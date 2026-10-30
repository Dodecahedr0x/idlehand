import { ensureBase, headSha, makeWorktree } from '../workspace.ts';
import { createIssue, ensureLabel, issueBodies } from '../gh.ts';
import { commandLooksSafe, similarTitle, verify } from '../verify.ts';
import { CODEBASE_REVIEW_SCHEMA } from './schemas.ts';
import { codebaseReviewPrompt } from './prompts.ts';
import { FOOTER, MARKER, fmtCmd, fmtOut, type TaskContext, type TaskResult } from './common.ts';

interface Finding {
  title: string;
  severity: 'low' | 'medium' | 'high';
  body: string;
  reproduction: { setup: string[]; command: string };
  expect: { exitCode: 'zero' | 'nonzero'; outputIncludes: string | null; outputExcludes: string | null };
  observed: string;
}

export async function reviewCodebase(ctx: TaskContext): Promise<TaskResult> {
  const started = Date.now();
  const branch = ctx.info.default_branch;
  const base = await ensureBase(ctx.repo, branch, ctx.log);
  const sha = await headSha(base, `origin/${branch}`);
  const wt = await makeWorktree(ctx.repo, base, `origin/${branch}`, 'review');
  const kind = 'review-codebase' as const;
  const fail = (summary: string, costUsd = 0, costEstimated = false, exhausted = false, outcome: TaskResult['outcome'] = 'failed'): TaskResult =>
    ({ kind, outcome, url: null, summary, costUsd, costEstimated, durationMs: Date.now() - started, exhausted });
  try {
    const existing = await issueBodies(ctx.repo).catch(() => [] as { number: number; title: string; body: string }[]);
    const prompt = codebaseReviewPrompt(ctx.repo, branch, existing.map((i) => i.title), ctx.cfg.policy.maxIssuesPerReview);
    ctx.log(`agent: hunting for reproducible bugs on ${ctx.repo}@${sha.slice(0, 7)}`);
    const run = await ctx.provider.run({ cwd: wt.path, prompt, schema: CODEBASE_REVIEW_SCHEMA, maxBudgetUsd: ctx.maxBudgetUsd, timeoutMs: ctx.cfg.policy.taskTimeoutMin * 60_000, onLog: ctx.log });
    if (run.error || !run.output) return fail(run.error ?? 'no output', run.costUsd, run.costEstimated, run.exhausted);

    const out = run.output as { findings: Finding[]; notes: string };
    const findings = Array.isArray(out.findings) ? out.findings.slice(0, ctx.cfg.policy.maxIssuesPerReview) : [];
    ctx.state.markCodebaseReview(ctx.repo, sha);
    if (findings.length === 0) {
      return { kind, outcome: 'nothing-found', url: null, summary: `No reproducible defects found. ${out.notes ?? ''}`.trim(), costUsd: run.costUsd, costEstimated: run.costEstimated, durationMs: Date.now() - started, exhausted: run.exhausted };
    }

    // Verify each finding on a CLEAN worktree so scratch state from the agent cannot fake a failure.
    const clean = await makeWorktree(ctx.repo, base, `origin/${branch}`, 'verify');
    const filed: string[] = [];
    const rejected: string[] = [];
    try {
      const timeout = ctx.cfg.policy.commandTimeoutSec * 1000;
      let labelOk: boolean | null = null;
      for (const f of findings) {
        const unsafe = commandLooksSafe(f.reproduction.command) ?? f.reproduction.setup.map(commandLooksSafe).find(Boolean) ?? null;
        if (unsafe) { rejected.push(`${f.title}: ${unsafe}`); ctx.log(`✗ ${f.title} — ${unsafe}`); continue; }
        if (existing.some((i) => similarTitle(i.title, f.title))) { rejected.push(`${f.title}: similar open issue exists`); ctx.log(`✗ ${f.title} — similar issue already open`); continue; }
        ctx.log(`verifying: ${f.title}`);
        // Scratch files the agent created may be referenced by the command; copy them over if they are untracked in the agent worktree.
        await copyUntracked(wt.path, clean.path, ctx.log);
        const v = await verify(f.reproduction, f.expect, clean.path, timeout, ctx.log);
        if (!v.ok) { rejected.push(`${f.title}: ${v.reason}`); ctx.log(`✗ unverified — ${v.reason}`); continue; }
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
    } finally {
      await clean.remove();
    }
    const summary = `${filed.length} issue(s) filed, ${rejected.length} finding(s) rejected.` + (rejected.length ? ` Rejected: ${rejected.join('; ')}` : '');
    return {
      kind,
      outcome: filed.length ? 'issues-filed' : 'unverified',
      url: filed[0] ?? null,
      summary,
      costUsd: run.costUsd,
      costEstimated: run.costEstimated,
      durationMs: Date.now() - started,
      exhausted: run.exhausted,
    };
  } finally {
    await wt.remove();
  }
}

async function copyUntracked(from: string, to: string, log: (l: string) => void) {
  const { exec } = await import('../shell.ts');
  const r = await exec(['git', 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: from });
  const files = r.stdout.split('\0').filter(Boolean).filter((f) => !f.includes('node_modules/'));
  if (!files.length) return;
  const { mkdirSync, copyFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  for (const f of files.slice(0, 50)) {
    try { mkdirSync(dirname(join(to, f)), { recursive: true }); copyFileSync(join(from, f), join(to, f)); } catch {}
  }
  log(`copied ${Math.min(files.length, 50)} scratch file(s) into the clean checkout`);
}
