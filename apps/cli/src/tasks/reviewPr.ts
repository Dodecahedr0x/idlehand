import { existsSync } from 'node:fs';
import { attachWorktree, ensureBase, fetchPrRef, makeWorktree } from '../workspace.ts';
import { isStopped } from '../shell.ts';
import { ciStatus, closePr, mergePr, postPrReview, prDetail, prDiff, squashMarker, type PrDetail, type PrSummary } from '../gh.ts';
import { commandLooksSafe, verify } from '../verify.ts';
import { REVIEW_PR_SCHEMA } from './schemas.ts';
import { reviewPrPrompt } from './prompts.ts';
import { considerFailureIssue } from './failureIssue.ts';
import { FOOTER, MARKER, type TaskContext, type TaskResult } from './common.ts';

function held(title: string, labels: { name: string }[]): boolean {
  return /\bWIP\b|\[wip\]|do not merge/i.test(title) || labels.some((l) => /do.?not.?merge|wip|hold/i.test(l.name));
}

/** What to do with a reviewed pull request before any other work. */
export function prDisposition(input: {
  ours: boolean;
  canPush: boolean;
  merge: 'never' | 'when-authorized';
  wantsMerge: boolean;
  ci: 'none' | 'green' | 'pending' | 'red';
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  held: boolean;
}): 'merge' | 'wait' | 'close' | 'leave' {
  if (input.merge !== 'when-authorized' || !input.canPush || input.held) return 'leave';
  const ciOk = input.ci === 'green' || input.ci === 'none';
  if (input.wantsMerge && ciOk && input.mergeable === 'MERGEABLE') return 'merge';
  if (input.wantsMerge && input.ci !== 'red' && input.mergeable === 'UNKNOWN') return 'wait';
  if (input.wantsMerge && input.ci === 'pending' && input.mergeable !== 'CONFLICTING') return 'wait';
  if (input.ours) return 'close';
  return 'leave';
}

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
  const wt = ctx.resume?.worktree && existsSync(ctx.resume.worktree)
    ? attachWorktree(base, ctx.resume.worktree)
    : await makeWorktree(ctx.repo, base, ref, `pr-${prSummary.number}`);
  ctx.saveWorkspace?.({ worktree: wt.path });
  let paused = false;
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
    if (run.error || !run.output) {
      const judged = await considerFailureIssue(ctx, { base, cwd: wt.path, branch: ctx.info.default_branch, task: `reviewing pull request #${pr.number}: ${pr.title}`, run });
      return done('failed', judged.summary, judged, judged.url);
    }
    const out = run.output as ReviewOutput;

    // Independently re-run the test command the agent claims to have run.
    let testsNote = '';
    let testsVerified: boolean | null = null;
    if (out.tests.command) {
      const unsafe = commandLooksSafe(out.tests.command);
      if (unsafe) { testsNote = `Test command rejected (${unsafe}); treating tests as not run.`; }
      else {
        ctx.log(`verify: ${out.tests.command}`);
        const j = await verify({ setup: [], command: out.tests.command }, { exitCode: 'zero' }, wt.path, ctx.cfg.policy.commandTimeoutSec * 1000);
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
    const own = pr.author.login === ctx.login;
    if (own && verdict !== 'comment') {
      ctx.log('posting a comment; GitHub does not accept an approval on your own pull request');
      verdict = 'comment';
    }

    const inline = out.findings.filter((f) => f.line != null && f.line > 0).map((f) => ({ path: f.path, line: f.line!, body: `**${f.severity}** — ${f.body}` }));
    const general = out.findings.filter((f) => f.line == null || f.line <= 0);
    let body = [
      MARKER('review', `${pr.number}:${pr.headRefOid.slice(0, 7)}`),
      out.summary.trim(),
      '',
      ...(general.length ? ['## Notes', ...general.map((f) => `- **${f.severity}** \`${f.path}\` — ${f.body}`), ''] : []),
      `## Checks`,
      testsNote,
      `Reviewed at \`${pr.headRefOid.slice(0, 7)}\`.`,
      FOOTER('Review'),
    ].join('\n');
    const approved = verdict === 'approve' || (own && out.verdict === 'approve' && testsVerified === true);
    const ours = own || prSummary.headRefName.startsWith('idlehand/');
    const canPush = !!ctx.info.permissions?.push;
    const wantsMerge = approved && out.safeToMerge && testsVerified === true;
    const mayAct = ctx.cfg.policy.merge === 'when-authorized' && canPush && (wantsMerge || ours);
    const fresh = mayAct ? await prDetail(ctx.repo, pr.number) : null;
    const headOk = !fresh || fresh.headRefOid === pr.headRefOid;
    const checks = ciStatus(fresh?.statusCheckRollup);
    const decision = !headOk ? 'leave' : prDisposition({
      ours, canPush, merge: ctx.cfg.policy.merge, wantsMerge, ci: checks, mergeable: fresh?.mergeable ?? 'UNKNOWN', held: fresh ? held(fresh.title, prSummary.labels) : false,
    });
    if (decision === 'wait' && fresh) {
      body += `\n${squashMarker(fresh.headRefOid)}`;
      ctx.log(checks === 'pending' ? 'CI is still running; a later pass will squash this pull request once it is green' : 'marked for squash once GitHub reports the pull request mergeable');
    }
    const event = verdict === 'approve' ? 'APPROVE' : verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
    const url = await postPrReview(ctx.repo, pr.number, event, body, inline);
    ctx.log(`posted ${event.toLowerCase()} review ${url}`);

    if (decision === 'merge' && fresh) {
      ctx.log(`merging with ${ctx.cfg.policy.mergeMethod}…`);
      await mergePr(ctx.repo, pr.number, ctx.cfg.policy.mergeMethod);
      return done('merged', `Approved and merged (${ctx.cfg.policy.mergeMethod}). ${out.summary.slice(0, 600)}`, run, url);
    }
    if (decision === 'close' && fresh) {
      ctx.log(`closing PR #${pr.number}`);
      await closePr(ctx.repo, pr.number, `Closing: this pull request is not safe to merge.\n\n${out.summary.trim()}`);
      return done('closed', `Closed PR #${pr.number}. ${out.summary.slice(0, 600)}`, run, url);
    }
    if (fresh) ctx.log(`leaving PR #${pr.number} open: ${decision}`);
    return done('reviewed', `${verdict}: ${out.summary.slice(0, 800)}`, run, url);
  } catch (e) {
    paused = isStopped(e);
    throw e;
  } finally {
    if (!paused) await wt.remove();
  }
}

/** Squash a pull request a previous review already marked safe, once CI is green. Does not run an agent. */
export async function squashReadyPr(ctx: TaskContext, pr: PrSummary): Promise<TaskResult> {
  const started = Date.now();
  const done = (outcome: TaskResult['outcome'], summary: string, url: string | null = pr.url): TaskResult =>
    ({ kind: 'review-pr', outcome, url, summary, costUsd: 0, costEstimated: false, durationMs: Date.now() - started, exhausted: false });
  if (ctx.cfg.policy.merge !== 'when-authorized' || !ctx.info.permissions?.push) return done('nothing-found', 'not authorized to squash');
  const fresh: PrDetail = await prDetail(ctx.repo, pr.number);
  const reviews = fresh.reviews ?? pr.reviews;
  if (!reviews.some((r) => r.author?.login === ctx.login && r.body?.includes(squashMarker(fresh.headRefOid)))) {
    return done('nothing-found', 'this commit was not marked safe to squash');
  }
  if (held(fresh.title, pr.labels)) return done('nothing-found', 'pull request is held');
  if (ciStatus(fresh.statusCheckRollup) !== 'green') return done('nothing-found', 'CI is not green');
  if (fresh.mergeable !== 'MERGEABLE') return done('failed', `not squashable yet: ${fresh.mergeable}`);
  ctx.log(`squashing PR #${pr.number} (${ctx.cfg.policy.mergeMethod})`);
  await mergePr(ctx.repo, pr.number, ctx.cfg.policy.mergeMethod);
  return done('merged', `Squashed PR #${pr.number} (${ctx.cfg.policy.mergeMethod}) once CI was green.`, fresh.url);
}

/** Close a pull request a review already marked safe, after CI failed. Does not run an agent. */
export async function closeFailedPr(ctx: TaskContext, pr: PrSummary): Promise<TaskResult> {
  const started = Date.now();
  const done = (outcome: TaskResult['outcome'], summary: string, url: string | null = pr.url): TaskResult =>
    ({ kind: 'review-pr', outcome, url, summary, costUsd: 0, costEstimated: false, durationMs: Date.now() - started, exhausted: false });
  if (ctx.cfg.policy.merge !== 'when-authorized' || !ctx.info.permissions?.push) return done('nothing-found', 'not authorized to close');
  const fresh: PrDetail = await prDetail(ctx.repo, pr.number);
  const status = ciStatus(fresh.statusCheckRollup);
  if ((status === 'green' || status === 'none') && fresh.mergeable === 'MERGEABLE' && !held(fresh.title, pr.labels)) {
    ctx.log(`squashing PR #${pr.number} (${ctx.cfg.policy.mergeMethod})`);
    await mergePr(ctx.repo, pr.number, ctx.cfg.policy.mergeMethod);
    return done('merged', `Squashed PR #${pr.number} (${ctx.cfg.policy.mergeMethod}) once CI was green.`, fresh.url);
  }
  if (status === 'pending') return done('nothing-found', 'CI is still running');
  ctx.log(`closing PR #${pr.number}`);
  await closePr(ctx.repo, pr.number, `Closing: CI failed on \`${fresh.headRefOid.slice(0, 7)}\`.`);
  return done('closed', `Closed PR #${pr.number} because CI failed.`, fresh.url);
}
