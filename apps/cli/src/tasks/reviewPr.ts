import { existsSync } from 'node:fs';
import { attachWorktree, commitAll, ensureBase, fetchPrRef, hasChanges, makeWorktree, pushBranch } from '../workspace.ts';
import { isStopped } from '../shell.ts';
import { authToken, changesMarker, ciStatus, closePr, commentOnIssue, currentGithubUser, githubCommitIdentity, mergePr, postPrReview, prDetail, prDiff, squashMarker, type PrDetail, type PrSummary } from '../gh.ts';
import { commandLooksSafe, verify } from '../verify.ts';
import { ADDRESS_PR_SCHEMA, REVIEW_PR_SCHEMA } from './schemas.ts';
import { addressPrPrompt, reviewPrPrompt } from './prompts.ts';
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
  /** True only when the review judged the solution bad or dangerous. */
  badOrDangerous: boolean;
}): 'merge' | 'wait' | 'close' | 'leave' {
  if (input.merge !== 'when-authorized' || !input.canPush || input.held) return 'leave';
  const ciOk = input.ci === 'green' || input.ci === 'none';
  if (input.wantsMerge && ciOk && input.mergeable === 'MERGEABLE') return 'merge';
  if (input.wantsMerge && input.ci !== 'red' && input.mergeable === 'UNKNOWN') return 'wait';
  if (input.wantsMerge && input.ci === 'pending' && input.mergeable !== 'CONFLICTING') return 'wait';
  if (input.ours && input.wantsMerge && input.ci === 'red') return 'close';
  if (input.ours && input.badOrDangerous) return 'close';
  return 'leave';
}

/** Comments on a pull request we own that a later pass should answer. */
export function hasActionableFeedback(pr: Pick<PrSummary, 'headRefOid' | 'reviews' | 'comments' | 'reviewDecision'>, login: string): boolean {
  if ((pr.reviewDecision ?? '').toUpperCase() === 'CHANGES_REQUESTED') return true;
  const marker = changesMarker(pr.headRefOid);
  for (const review of pr.reviews ?? []) {
    const body = review.body ?? '';
    const state = (review.state ?? '').toUpperCase();
    const author = review.author?.login;
    if (body.includes(marker)) return true;
    if (state === 'CHANGES_REQUESTED') return true;
    if (state === 'COMMENTED' && author && author !== login) return true;
  }
  for (const comment of pr.comments ?? []) {
    if (!comment.body?.trim()) continue;
    if (comment.author?.login === login) continue;
    return true;
  }
  return false;
}

function feedbackText(pr: PrDetail, login: string): string {
  const lines: string[] = [];
  if ((pr.reviewDecision ?? '').toUpperCase() === 'CHANGES_REQUESTED') lines.push('GitHub review decision: CHANGES_REQUESTED');
  const marker = changesMarker(pr.headRefOid);
  for (const review of pr.reviews ?? []) {
    const body = review.body?.trim() ?? '';
    const state = (review.state ?? 'COMMENTED').toUpperCase();
    const author = review.author?.login ?? 'someone';
    const ours = review.author?.login === login;
    const relevant = state === 'CHANGES_REQUESTED' || body.includes(marker) || (!ours && state === 'COMMENTED' && body);
    if (!relevant) continue;
    lines.push(`Review by @${author} (${state}):\n${body || '(no body)'}`);
  }
  for (const comment of pr.comments ?? []) {
    if (comment.author?.login === login) continue;
    if (!comment.body?.trim()) continue;
    lines.push(`Comment by @${comment.author?.login ?? 'someone'}:\n${comment.body.trim()}`);
  }
  return lines.join('\n\n');
}

interface ReviewOutput {
  verdict: 'approve' | 'request_changes' | 'comment';
  solution?: 'sound' | 'off' | 'bad' | 'dangerous';
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

    // A bit off stays open as a change request. Close only a bad or dangerous solution.
    let verdict = out.verdict;
    const solution = out.solution ?? 'sound';
    const badOrDangerous = solution === 'bad' || solution === 'dangerous';
    const substantive = out.findings.some((f) => f.severity !== 'nit');
    if ((badOrDangerous || solution === 'off') && verdict === 'approve') verdict = 'request_changes';
    if (solution === 'off' && verdict === 'comment') verdict = 'request_changes';
    if (!badOrDangerous && !out.safeToMerge && substantive && verdict === 'comment') verdict = 'request_changes';
    if (!badOrDangerous && !out.safeToMerge && verdict === 'approve') verdict = 'request_changes';
    if (verdict === 'approve' && testsVerified !== true) verdict = 'comment';
    const blocking = out.findings.filter((f) => f.severity === 'blocking' || f.severity === 'major');
    if (verdict === 'approve' && blocking.length) verdict = 'request_changes';
    const askedToRevise = verdict === 'request_changes';
    const own = pr.author.login === ctx.login;
    if (own && verdict !== 'comment') {
      ctx.log('posting a comment; GitHub does not accept an approval or a change request on your own pull request');
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
    const concludedApprove = out.verdict === 'approve' && !badOrDangerous && solution !== 'off' && out.safeToMerge;
    const approved = verdict === 'approve' || (own && concludedApprove && testsVerified === true);
    const ours = own || prSummary.headRefName.startsWith('idlehand/');
    const canPush = !!ctx.info.permissions?.push;
    const wantsMerge = approved && out.safeToMerge && testsVerified === true && !badOrDangerous && solution !== 'off';
    const mayAct = ctx.cfg.policy.merge === 'when-authorized' && canPush && (wantsMerge || ours);
    const fresh = mayAct ? await prDetail(ctx.repo, pr.number) : null;
    const headOk = !fresh || fresh.headRefOid === pr.headRefOid;
    const checks = ciStatus(fresh?.statusCheckRollup);
    const decision = !headOk ? 'leave' : prDisposition({
      ours, canPush, merge: ctx.cfg.policy.merge, wantsMerge, ci: checks, mergeable: fresh?.mergeable ?? 'UNKNOWN', held: fresh ? held(fresh.title, prSummary.labels) : false, badOrDangerous,
    });
    if (askedToRevise && decision === 'leave' && !badOrDangerous) body += `\n${changesMarker(pr.headRefOid)}`;
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
      const reason = out.solution === 'dangerous' ? 'the solution is dangerous' : out.solution === 'bad' ? 'the solution is bad' : 'CI failed';
      ctx.log(`closing PR #${pr.number}: ${reason}`);
      await closePr(ctx.repo, pr.number, `Closing: ${reason}.\n\n${out.summary.trim()}`);
      return done('closed', `Closed PR #${pr.number}: ${reason}. ${out.summary.slice(0, 600)}`, run, url);
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

interface AddressOutput {
  action: 'addressed' | 'nothing';
  summary: string;
  testCommand: string | null;
}

/** Revise a pull request we own when review comments ask for a change. */
export async function addressPrComments(ctx: TaskContext, prSummary: PrSummary): Promise<TaskResult> {
  const started = Date.now();
  const kind = 'review-pr' as const;
  const base = await ensureBase(ctx.repo, ctx.info.default_branch, ctx.log);
  const ref = await fetchPrRef(base, prSummary.number);
  const wt = ctx.resume?.worktree && existsSync(ctx.resume.worktree)
    ? attachWorktree(base, ctx.resume.worktree)
    : await makeWorktree(ctx.repo, base, ref, `address-${prSummary.number}`);
  ctx.saveWorkspace?.({ worktree: wt.path });
  let paused = false;
  const done = (outcome: TaskResult['outcome'], summary: string, run?: { costUsd: number; costEstimated: boolean; exhausted: boolean }, url: string | null = null): TaskResult =>
    ({ kind, outcome, url, summary, costUsd: run?.costUsd ?? 0, costEstimated: run?.costEstimated ?? false, durationMs: Date.now() - started, exhausted: run?.exhausted ?? false });
  try {
    const pr = await prDetail(ctx.repo, prSummary.number);
    if (pr.headRefOid !== prSummary.headRefOid) return done('nothing-found', `PR #${pr.number} moved before comments could be addressed`, undefined, pr.url);
    const feedback = feedbackText(pr, ctx.login);
    if (!feedback) return done('nothing-found', `PR #${pr.number} has no comments to address`, undefined, pr.url);
    const diff = await prDiff(ctx.repo, pr.number);
    ctx.log(`agent: addressing comments on #${pr.number} ${pr.title}`);
    const run = await ctx.provider.run({
      cwd: wt.path,
      prompt: addressPrPrompt(ctx.repo, pr, diff, feedback),
      schema: ADDRESS_PR_SCHEMA,
      maxBudgetUsd: ctx.maxBudgetUsd,
      timeoutMs: ctx.cfg.policy.taskTimeoutMin * 60_000,
      onLog: ctx.log,
    });
    if (run.error || !run.output) {
      const judged = await considerFailureIssue(ctx, { base, cwd: wt.path, branch: ctx.info.default_branch, task: `addressing comments on pull request #${pr.number}: ${pr.title}`, run });
      return done('failed', judged.summary, judged, judged.url);
    }
    const out = run.output as AddressOutput;
    if (out.action !== 'addressed') return done('nothing-found', out.summary.slice(0, 800), run, pr.url);
    if (!(await hasChanges(wt.path))) return done('unverified', 'agent said the comments were addressed but the working tree has no changes', run, pr.url);
    const unsafe = out.testCommand ? commandLooksSafe(out.testCommand) : null;
    if (unsafe) return done('unverified', `rejected command: ${unsafe}`, run, pr.url);
    if (out.testCommand) {
      ctx.log(`verify: ${out.testCommand}`);
      const tests = await verify({ setup: [], command: out.testCommand }, { exitCode: 'zero' }, wt.path, ctx.cfg.policy.commandTimeoutSec * 1000);
      if (!tests.ok) return done(tests.infrastructureError ? 'failed' : 'unverified', `tests fail after addressing comments: ${tests.reason}`, run, pr.url);
    }
    const author = githubCommitIdentity(await currentGithubUser());
    const sha = await commitAll(wt.path, `Address review on #${pr.number}\n\n${out.summary.trim()}`, author);
    const owner = pr.headRepositoryOwner?.login;
    const name = pr.headRepository?.name;
    const target = owner && name ? `${owner}/${name}` : ctx.repo;
    ctx.log(`pushing ${pr.headRefName} to ${target}…`);
    await pushBranch(wt.path, target, pr.headRefName, await authToken(), { expect: pr.headRefOid });
    const body = `${MARKER('address', `${pr.number}:${sha.slice(0, 7)}`)}${out.summary.trim()}${FOOTER('Comment')}`;
    const url = await commentOnIssue(ctx.repo, pr.number, body);
    ctx.log(`addressed comments on #${pr.number}`);
    return done('reviewed', `Addressed comments on #${pr.number}. ${out.summary.slice(0, 600)}`, run, url);
  } catch (e) {
    paused = isStopped(e);
    throw e;
  } finally {
    if (!paused) await wt.remove();
  }
}
