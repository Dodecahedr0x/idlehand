import { ensureBase, fetchPrRef, makeWorktree } from '../workspace.ts';
import { mergePr, postPrReview, prDetail, prDiff, type PrSummary } from '../gh.ts';
import { commandLooksSafe, judge } from '../verify.ts';
import { sh } from '../shell.ts';
import { REVIEW_PR_SCHEMA } from './schemas.ts';
import { reviewPrPrompt } from './prompts.ts';
import { FOOTER, MARKER, type TaskContext, type TaskResult } from './common.ts';

interface ReviewOutput {
  verdict: 'approve' | 'request_changes' | 'comment';
  summary: string;
  findings: { path: string; line: number | null; severity: 'nit' | 'minor' | 'major' | 'blocking'; body: string }[];
  tests: { command: string | null; passed: boolean; outputTail: string };
  safeToMerge: boolean;
}

export async function reviewPr(ctx: TaskContext, prSummary: PrSummary): Promise<TaskResult> {
  const started = Date.now();
  const kind = 'review-pr' as const;
  const base = await ensureBase(ctx.repo, ctx.info.default_branch, ctx.log);
  const ref = await fetchPrRef(base, prSummary.number);
  const wt = await makeWorktree(ctx.repo, base, ref, `pr-${prSummary.number}`);
  const done = (outcome: TaskResult['outcome'], summary: string, run?: { costUsd: number; costEstimated: boolean; exhausted: boolean }, url: string | null = null): TaskResult =>
    ({ kind, outcome, url, summary, costUsd: run?.costUsd ?? 0, costEstimated: run?.costEstimated ?? false, durationMs: Date.now() - started, exhausted: run?.exhausted ?? false });
  try {
    const [pr, diff] = await Promise.all([prDetail(ctx.repo, prSummary.number), prDiff(ctx.repo, prSummary.number)]);
    const canMerge = ctx.cfg.policy.merge === 'when-authorized' && !!ctx.info.permissions?.push;
    ctx.log(`agent: reviewing #${pr.number} ${pr.title}`);
    const run = await ctx.provider.run({
      cwd: wt.path,
      prompt: reviewPrPrompt(ctx.repo, pr, diff, canMerge),
      schema: REVIEW_PR_SCHEMA,
      maxBudgetUsd: ctx.maxBudgetUsd,
      timeoutMs: ctx.cfg.policy.taskTimeoutMin * 60_000,
      onLog: ctx.log,
    });
    if (run.error || !run.output) return done('failed', run.error ?? 'no output', run);
    const out = run.output as ReviewOutput;

    // Independently re-run the test command the agent claims to have run.
    let testsNote = '';
    let testsVerified: boolean | null = null;
    if (out.tests.command) {
      const unsafe = commandLooksSafe(out.tests.command);
      if (unsafe) { testsNote = `Test command rejected (${unsafe}); treating tests as not run.`; }
      else {
        ctx.log(`verify: ${out.tests.command}`);
        const t = await sh(out.tests.command, { cwd: wt.path, timeoutMs: ctx.cfg.policy.commandTimeoutSec * 1000, env: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' } });
        const j = judge({ exitCode: 'zero', outputIncludes: null, outputExcludes: null }, t.code, t.timedOut, t.stdout + '\n' + t.stderr);
        testsVerified = j.ok;
        testsNote = j.ok ? `Tests re-run by the runner: \`${out.tests.command}\` → passed.` : `Tests re-run by the runner: \`${out.tests.command}\` → **failed** (${j.reason}).`;
        if (!j.ok && out.tests.passed) ctx.log('agent claimed tests passed but they fail; downgrading verdict');
      }
    } else {
      testsNote = '_No test command was run._';
    }

    // Downgrade: never approve when we could not confirm green tests.
    let verdict = out.verdict;
    if (verdict === 'approve' && testsVerified !== true) verdict = 'comment';
    const blocking = out.findings.filter((f) => f.severity === 'blocking' || f.severity === 'major');
    if (verdict === 'approve' && blocking.length) verdict = 'request_changes';
    // GitHub refuses REQUEST_CHANGES/APPROVE on your own PR; the scheduler already skips those.

    const inline = out.findings.filter((f) => f.line != null && f.line > 0).map((f) => ({ path: f.path, line: f.line!, body: `**${f.severity}** — ${f.body}` }));
    const general = out.findings.filter((f) => f.line == null || f.line <= 0);
    const body = [
      MARKER('review', `${pr.number}:${pr.headRefOid.slice(0, 7)}`),
      out.summary.trim(),
      '',
      ...(general.length ? ['## Notes', ...general.map((f) => `- **${f.severity}** \`${f.path}\` — ${f.body}`), ''] : []),
      `## Checks`,
      testsNote,
      `Reviewed at \`${pr.headRefOid.slice(0, 7)}\`.`,
      FOOTER('Review'),
    ].join('\n');
    const event = verdict === 'approve' ? 'APPROVE' : verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
    const url = await postPrReview(ctx.repo, pr.number, event, body, inline);
    ctx.log(`posted ${event.toLowerCase()} review ${url}`);

    // Merge only when: policy allows, we have push rights, agent approved AND marked safe, tests verified green here, GitHub says mergeable & checks clean.
    if (verdict === 'approve' && out.safeToMerge && canMerge && testsVerified) {
      const fresh = await prDetail(ctx.repo, pr.number);
      const checksOk = fresh.statusCheckRollup.length === 0 || fresh.statusCheckRollup.every((c) => (c.conclusion ?? c.state ?? '').toUpperCase().match(/SUCCESS|NEUTRAL|SKIPPED/));
      const noHold = !fresh.title.match(/\bWIP\b|\[wip\]|do not merge/i) && !prSummary.labels.some((l) => /do.?not.?merge|wip|hold/i.test(l.name));
      if (fresh.mergeable === 'MERGEABLE' && checksOk && noHold && fresh.headRefOid === pr.headRefOid) {
        ctx.log('merging…');
        await mergePr(ctx.repo, pr.number, ctx.cfg.policy.mergeMethod);
        return done('merged', `Approved and merged (${ctx.cfg.policy.mergeMethod}). ${out.summary.slice(0, 600)}`, run, url);
      }
      ctx.log(`not merging: mergeable=${fresh.mergeable} checks=${checksOk} hold=${!noHold} headChanged=${fresh.headRefOid !== pr.headRefOid}`);
    }
    return done('reviewed', `${verdict}: ${out.summary.slice(0, 800)}`, run, url);
  } finally {
    await wt.remove();
  }
}
