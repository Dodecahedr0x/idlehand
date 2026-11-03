import { existsSync } from 'node:fs';
import { attachWorktree, ensureBase, headSha, makeWorktree } from '../workspace.ts';
import { isStopped } from '../shell.ts';
import { issueBodies } from '../gh.ts';
import { CODEBASE_REVIEW_SCHEMA } from './schemas.ts';
import { codebaseReviewPrompt } from './prompts.ts';
import { considerFailureIssue, fileVerifiedFindings, type IssueFinding } from './failureIssue.ts';
import { type TaskContext, type TaskResult } from './common.ts';

export async function reviewCodebase(ctx: TaskContext): Promise<TaskResult> {
  const started = Date.now();
  const branch = ctx.info.default_branch;
  const base = await ensureBase(ctx.repo, branch, ctx.log);
  const sha = await headSha(base, `origin/${branch}`);
  const wt = ctx.resume?.worktree && existsSync(ctx.resume.worktree)
    ? attachWorktree(base, ctx.resume.worktree)
    : await makeWorktree(ctx.repo, base, `origin/${branch}`, 'review');
  ctx.saveWorkspace?.({ worktree: wt.path });
  let paused = false;
  const kind = 'review-codebase' as const;
  try {
    const existing = await issueBodies(ctx.repo).catch(() => [] as { number: number; title: string; body: string }[]);
    const prompt = codebaseReviewPrompt(ctx.repo, branch, existing.map((i) => i.title), ctx.cfg.policy.maxIssuesPerReview);
    ctx.log(`agent: hunting for reproducible bugs on ${ctx.repo}@${sha.slice(0, 7)}`);
    const run = await ctx.provider.run({ cwd: wt.path, prompt, schema: CODEBASE_REVIEW_SCHEMA, maxBudgetUsd: ctx.maxBudgetUsd, timeoutMs: ctx.cfg.policy.taskTimeoutMin * 60_000, onLog: ctx.log });
    if (run.error || !run.output) {
      const judged = await considerFailureIssue(ctx, { base, cwd: wt.path, branch, task: `a codebase review of ${ctx.repo}`, run });
      return { kind, outcome: 'failed', url: judged.url, summary: judged.summary, costUsd: judged.costUsd, costEstimated: judged.costEstimated, durationMs: Date.now() - started, exhausted: judged.exhausted };
    }

    const out = run.output as { findings: IssueFinding[]; notes: string };
    const findings = Array.isArray(out.findings) ? out.findings.slice(0, ctx.cfg.policy.maxIssuesPerReview) : [];
    if (findings.length === 0) {
      ctx.state.markCodebaseReview(ctx.repo, sha);
      return { kind, outcome: 'nothing-found', url: null, summary: `No reproducible defects found. ${out.notes ?? ''}`.trim(), costUsd: run.costUsd, costEstimated: run.costEstimated, durationMs: Date.now() - started, exhausted: run.exhausted };
    }

    // Verify each finding on a CLEAN worktree so scratch state from the agent cannot fake a failure.
    const clean = await makeWorktree(ctx.repo, base, `origin/${branch}`, 'verify');
    let filed: string[] = [];
    let rejected: string[] = [];
    let infrastructureFailed = false;
    try {
      ({ filed, rejected, infrastructureFailed } = await fileVerifiedFindings(ctx, findings, existing, clean.path, branch, sha));
    } finally {
      await clean.remove();
    }
    if (!infrastructureFailed) ctx.state.markCodebaseReview(ctx.repo, sha);
    const summary = `${filed.length} issue(s) filed, ${rejected.length} finding(s) rejected.` + (rejected.length ? ` Rejected: ${rejected.join('; ')}` : '');
    return {
      kind,
      outcome: infrastructureFailed ? 'failed' : filed.length ? 'issues-filed' : 'unverified',
      url: filed[0] ?? null,
      summary,
      costUsd: run.costUsd,
      costEstimated: run.costEstimated,
      durationMs: Date.now() - started,
      exhausted: run.exhausted,
    };
  } catch (e) {
    paused = isStopped(e);
    throw e;
  } finally {
    if (!paused) await wt.remove();
  }
}
