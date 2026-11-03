/** When an agent run fails, decide whether that failure is a reproducible defect. One follow-up, no retry. */
import type { AgentRunResult } from '../providers/types.ts';
import { createIssue, ensureLabel, issueBodies } from '../gh.ts';
import { headSha, makeWorktree } from '../workspace.ts';
import { commandLooksSafe, similarTitle, verify } from '../verify.ts';
import { CODEBASE_REVIEW_SCHEMA } from './schemas.ts';
import { failureIssuePrompt } from './prompts.ts';
import { FOOTER, MARKER, fmtCmd, fmtOut, type TaskContext } from './common.ts';

export interface IssueFinding {
  title: string;
  severity: 'low' | 'medium' | 'high';
  body: string;
  reproduction: { setup: string[]; command: string };
  expect: { exitCode: 'zero' | 'nonzero'; outputIncludes: string | null; outputExcludes: string | null };
  observed: string;
}

const PROVIDER_STOP = /budget threshold|in-flight usage/i;

export function agentFailureCanBeConsidered(run: { exhausted: boolean; costUnknown?: boolean; error: string | null }): boolean {
  if (run.exhausted || run.costUnknown) return false;
  return !PROVIDER_STOP.test(run.error ?? '');
}

export async function fileVerifiedFindings(
  ctx: Pick<TaskContext, 'repo' | 'cfg' | 'log'>,
  findings: IssueFinding[],
  existing: { title: string }[],
  cleanPath: string,
  branch: string,
  sha: string,
): Promise<{ filed: string[]; rejected: string[]; infrastructureFailed: boolean }> {
  const filed: string[] = [];
  const rejected: string[] = [];
  let infrastructureFailed = false;
  const timeout = ctx.cfg.policy.commandTimeoutSec * 1000;
  let labelOk: boolean | null = null;
  for (const f of findings) {
    const unsafe = commandLooksSafe(f.reproduction.command) ?? f.reproduction.setup.map(commandLooksSafe).find(Boolean) ?? null;
    if (unsafe) { rejected.push(`${f.title}: ${unsafe}`); ctx.log(`✗ ${f.title} — ${unsafe}`); continue; }
    if (existing.some((i) => similarTitle(i.title, f.title))) { rejected.push(`${f.title}: similar open issue exists`); ctx.log(`✗ ${f.title} — similar issue already open`); continue; }
    ctx.log(`verifying: ${f.title}`);
    const v = await verify(f.reproduction, f.expect, cleanPath, timeout, ctx.log);
    if (!v.ok) {
      infrastructureFailed ||= !!v.infrastructureError;
      rejected.push(`${f.title}: ${v.reason}`);
      ctx.log(`✗ ${v.infrastructureError ? 'verification unavailable' : 'unverified'} — ${v.reason}`);
      continue;
    }
    ctx.log(`✓ reproduced (exit ${v.exitCode})`);
    if (labelOk == null) labelOk = await ensureLabel(ctx.repo, 'idlehand', '6f42c1', 'Filed by an Idlehand node after re-verifying the reproduction');
    const body = [
      MARKER('issue', sha.slice(0, 7)),
      f.body.trim(),
      '',
      '## Reproduction',
      `On \`${branch}\` @ ${sha.slice(0, 7)}, from the repo root:`,
      ...(f.reproduction.setup.length ? ['Setup:', fmtCmd(f.reproduction.setup.join('\n'))] : []),
      fmtCmd(f.reproduction.command),
      `Expected: exit ${f.expect.exitCode === 'zero' ? '0' : '≠ 0'}${f.expect.outputIncludes ? ` and output containing \`${f.expect.outputIncludes}\`` : ''}.`,
      'Observed (re-run by the runner on a clean checkout):',
      fmtOut(v.outputTail),
      `Severity: **${f.severity}**`,
      FOOTER('Filed'),
    ].join('\n');
    const url = await createIssue(ctx.repo, f.title, body, labelOk ? ['idlehand'] : []);
    filed.push(url);
    ctx.log(`filed ${url}`);
  }
  return { filed, rejected, infrastructureFailed };
}

type FailedRun = Pick<AgentRunResult, 'error' | 'costUsd' | 'costEstimated' | 'exhausted'> & { costUnknown?: boolean; rawTail?: string };

export async function considerFailureIssue(
  ctx: TaskContext,
  input: { base: string; cwd: string; branch: string; task: string; run: FailedRun },
): Promise<{ summary: string; url: string | null; costUsd: number; costEstimated: boolean; exhausted: boolean }> {
  const summary = input.run.error ?? 'no output';
  const declined = (extra?: Partial<FailedRun>) => ({
    summary,
    url: null as string | null,
    costUsd: input.run.costUsd + (extra?.costUsd ?? 0),
    costEstimated: input.run.costEstimated || !!extra?.costEstimated,
    exhausted: input.run.exhausted || !!extra?.exhausted,
  });
  if (!agentFailureCanBeConsidered(input.run)) {
    ctx.log('not opening an issue: provider stopped before the failure could be judged');
    return declined();
  }
  const existing = await issueBodies(ctx.repo).catch(() => [] as { number: number; title: string; body: string }[]);
  ctx.log('agent failed; considering whether to open an issue');
  // ponytail: one follow-up. If this call fails too, the task stays failed.
  const follow = await ctx.provider.run({
    cwd: input.cwd,
    prompt: failureIssuePrompt({
      repo: ctx.repo,
      branch: input.branch,
      task: input.task,
      failure: summary,
      evidence: input.run.rawTail ?? '',
      openIssueTitles: existing.map((issue) => issue.title),
    }),
    schema: CODEBASE_REVIEW_SCHEMA,
    maxBudgetUsd: ctx.maxBudgetUsd,
    timeoutMs: ctx.cfg.policy.taskTimeoutMin * 60_000,
    onLog: ctx.log,
    fresh: true,
  });
  const cost = declined(follow);
  if (follow.error || !follow.output) {
    ctx.log('considered an issue: follow-up failed');
    return cost;
  }
  const findings = Array.isArray((follow.output as { findings?: IssueFinding[] }).findings)
    ? (follow.output as { findings: IssueFinding[] }).findings.slice(0, 1)
    : [];
  if (findings.length === 0) {
    ctx.log('considered an issue: no');
    return cost;
  }
  const sha = await headSha(input.base, `origin/${input.branch}`);
  const clean = await makeWorktree(ctx.repo, input.base, `origin/${input.branch}`, 'failure');
  try {
    const published = await fileVerifiedFindings(ctx, findings, existing, clean.path, input.branch, sha);
    const url = published.filed[0] ?? null;
    if (!url) {
      ctx.log(`considered an issue: no (${published.rejected.join('; ') || 'unverified'})`);
      return cost;
    }
    return { ...cost, url, summary: `${summary}. Filed ${url}.` };
  } finally {
    await clean.remove();
  }
}
