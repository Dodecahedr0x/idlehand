import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBase, headSha, makeWorktree, attachWorktree, hasChanges, stageChanges, stageForced, commitAll, pushBranch, diffStat } from '../workspace.ts';
import { isStopped } from '../shell.ts';
import { authToken, commentOnIssue, closeIssue, createPr, currentGithubUser, editPr, forkRepo, githubCommitIdentity, markPrReady, openPrForBranch, closePr, type IssueSummary } from '../gh.ts';
import { commandLooksSafe, verify } from '../verify.ts';
import { FIX_ISSUE_SCHEMA } from './schemas.ts';
import { fixIssuePrompt } from './prompts.ts';
import { considerFailureIssue } from './failureIssue.ts';
import { FOOTER, MARKER, fmtCmd, fmtOut, type TaskContext, type TaskResult } from './common.ts';

const CLAIM_FILE = '.github/idlehand-claim';

interface FixOutput {
  status: 'fixed' | 'cannot_reproduce' | 'not_a_bug' | 'needs_info' | 'too_large';
  summary: string;
  changes: string;
  reproduction: { setup: string[]; command: string };
  expectBefore: { exitCode: 'zero' | 'nonzero'; outputIncludes: string | null; outputExcludes: string | null };
  expectAfter: { exitCode: 'zero' | 'nonzero'; outputIncludes: string | null; outputExcludes: string | null };
  testCommand: string | null;
  notes: string;
}

export async function fixIssue(ctx: TaskContext, issue: IssueSummary): Promise<TaskResult> {
  const started = Date.now();
  const kind = 'fix-issue' as const;
  const defaultBranch = ctx.info.default_branch;
  const base = await ensureBase(ctx.repo, defaultBranch, ctx.log);
  const baseSha = await headSha(base, `origin/${defaultBranch}`);
  const branch = ctx.resume?.branch || `idlehand/issue-${issue.number}`;
  const wt = ctx.resume?.worktree && existsSync(ctx.resume.worktree)
    ? attachWorktree(base, ctx.resume.worktree, branch)
    : await makeWorktree(ctx.repo, base, `origin/${defaultBranch}`, `issue-${issue.number}`, branch);
  ctx.saveWorkspace?.({ worktree: wt.path, branch });
  let paused = false;
  let claim: { number: number; url: string } | null = null;
  let keepClaim = false;
  const done = (outcome: TaskResult['outcome'], summary: string, run?: { costUsd: number; costEstimated: boolean; exhausted: boolean }, url: string | null = null): TaskResult =>
    ({ kind, outcome, url, summary, costUsd: run?.costUsd ?? 0, costEstimated: run?.costEstimated ?? false, durationMs: Date.now() - started, exhausted: run?.exhausted ?? false });
  const canPush = !!ctx.info.permissions?.push;
  const head = canPush ? branch : `${ctx.login}:${branch}`;
  const title = `Fix #${issue.number}: ${issue.title}`.slice(0, 250);
  try {
    const existing = await openPrForBranch(ctx.repo, branch);
    if (existing && ctx.resume && existing.author.login === ctx.login) {
      claim = { number: existing.number, url: existing.url };
      ctx.log(`resuming claim ${existing.url}`);
    } else if (existing) {
      keepClaim = true;
      ctx.log(`#${issue.number} already claimed at ${existing.url}`);
      return done('failed', `#${issue.number} already has an open pull request: ${existing.url}`, undefined, existing.url);
    } else {
      const target = canPush ? ctx.repo : await forkRepo(ctx.repo);
      const token = await authToken();
      if ((await headSha(wt.path)) === baseSha) {
        mkdirSync(join(wt.path, '.github'), { recursive: true });
        writeFileSync(join(wt.path, CLAIM_FILE), `#${issue.number}\n`);
        await stageForced(wt.path, CLAIM_FILE);
        const author = githubCommitIdentity(await currentGithubUser());
        await commitAll(wt.path, `Reserve #${issue.number}\n\nHolding this issue while a fix is in progress.`, author);
      }
      try {
        await pushBranch(wt.path, target, branch, token, { force: false });
      } catch (e) {
        const winner = await openPrForBranch(ctx.repo, branch);
        if (!winner) throw e;
        keepClaim = true;
        ctx.log(`#${issue.number} already claimed at ${winner.url}`);
        return done('failed', `#${issue.number} already has an open pull request: ${winner.url}`, undefined, winner.url);
      }
      const raced = await openPrForBranch(ctx.repo, branch);
      if (raced) {
        keepClaim = true;
        return done('failed', `#${issue.number} already has an open pull request: ${raced.url}`, undefined, raced.url);
      }
      const claimBody = `${MARKER('pr', String(issue.number))}Working on #${issue.number}.\n\nThis draft only reserves the issue so other agents leave it alone. It is not a fix, and nothing in it has been verified.`;
      try {
        const url = await createPr(ctx.repo, { title, body: claimBody, head, base: defaultBranch, draft: true });
        const number = Number(url.match(/\/pull\/(\d+)\s*$/)?.[1]);
        if (!number) throw new Error(`could not parse pull request number from ${url}`);
        claim = { number, url };
      } catch (e) {
        const winner = await openPrForBranch(ctx.repo, branch);
        if (winner) {
          keepClaim = true;
          return done('failed', `#${issue.number} already has an open pull request: ${winner.url}`, undefined, winner.url);
        }
        await pushBranch(wt.path, target, branch, token, { delete: true }).catch((err) => ctx.log(`could not delete unclaimed branch: ${(err as Error).message}`));
        throw e;
      }
      ctx.log(`opened draft ${claim.url} to claim #${issue.number}`);
    }

    ctx.log(`agent: working on #${issue.number} ${issue.title}`);
    const run = await ctx.provider.run({
      cwd: wt.path,
      prompt: fixIssuePrompt(ctx.repo, defaultBranch, issue, branch),
      schema: FIX_ISSUE_SCHEMA,
      maxBudgetUsd: ctx.maxBudgetUsd,
      timeoutMs: ctx.cfg.policy.taskTimeoutMin * 60_000,
      onLog: ctx.log,
    });
    if (run.error || !run.output) {
      const judged = await considerFailureIssue(ctx, { base, cwd: wt.path, branch: defaultBranch, task: `fixing #${issue.number}: ${issue.title}`, run });
      return done('failed', judged.summary, judged, judged.url);
    }
    const out = run.output as FixOutput;

    const explain = async (text: string): Promise<string | null> => {
      const body = `${MARKER('issue-close', String(issue.number))}${text.trim()}${FOOTER('Closed')}`;
      try {
        await closeIssue(ctx.repo, issue.number, body);
        ctx.log(`closed #${issue.number}`);
        return issue.url;
      } catch (e) {
        ctx.log(`could not close #${issue.number}: ${(e as Error).message.split('\n')[0]}`);
        try {
          await commentOnIssue(ctx.repo, issue.number, body);
          ctx.log(`commented on #${issue.number}`);
          return issue.url;
        } catch (err) {
          ctx.log(`comment failed: ${(err as Error).message.split('\n')[0]}`);
          return null;
        }
      }
    };

    if (out.status !== 'fixed') {
      ctx.log(`agent concluded: ${out.status} — ${out.notes.slice(0, 200)}`);
      if (out.status === 'not_a_bug' || out.status === 'cannot_reproduce') {
        const tried = out.reproduction?.command ? `\n\nWhat I tried:\n${fmtCmd(out.reproduction.command)}` : '';
        const url = await explain(`I could not verify this issue (**${out.status.replaceAll('_', ' ')}**).\n\n${out.notes.trim()}${tried}\n\nClosing it. Reopen if it is still wrong.`);
        return done('nothing-found', `${out.status}: ${out.notes}`.slice(0, 1000), run, url);
      }
      if (ctx.cfg.policy.commentOnIssues && out.status === 'needs_info') {
        const body = `${MARKER('issue-comment', String(issue.number))}I took a look at this and could not turn it into a fix yet (**needs info**).\n\n${out.notes.trim()}\n\n${out.reproduction?.command ? `What I tried:\n${fmtCmd(out.reproduction.command)}` : ''}${FOOTER('Comment')}`;
        await commentOnIssue(ctx.repo, issue.number, body).catch((e) => ctx.log(`comment failed: ${(e as Error).message}`));
      }
      return done('nothing-found', `${out.status}: ${out.notes}`.slice(0, 1000), run);
    }

    if (!(await hasChanges(wt.path))) return done('unverified', 'agent said "fixed" but the working tree has no changes', run);
    const unsafe = commandLooksSafe(out.reproduction.command) ?? out.reproduction.setup.map(commandLooksSafe).find(Boolean) ?? (out.testCommand ? commandLooksSafe(out.testCommand) : null);
    if (unsafe) return done('unverified', `rejected command: ${unsafe}`, run);

    const timeout = ctx.cfg.policy.commandTimeoutSec * 1000;
    rmSync(join(wt.path, CLAIM_FILE), { force: true });

    // 1. The bug must exist on the base branch.
    ctx.log('verify: reproduction fails on the base branch…');
    const baseWt = await makeWorktree(ctx.repo, base, `origin/${defaultBranch}`, `issue-${issue.number}-base`);
    let before;
    try {
      before = await verify(out.reproduction, out.expectBefore, baseWt.path, timeout, ctx.log);
    } finally {
      await baseWt.remove();
    }
    if (!before.ok) {
      const url = before.infrastructureError ? null : await explain(`I could not verify this issue on \`${defaultBranch}\`.\n\n${before.reason}\n\n${fmtOut(before.outputTail)}\n\nClosing it. Reopen if it is still wrong.`);
      return done(before.infrastructureError ? 'failed' : 'unverified', `could not confirm the bug on ${defaultBranch}: ${before.reason}`, run, url);
    }

    // 2. The reproduction must pass on the fix branch (agent's own scratch state removed by re-running setup).
    ctx.log('verify: reproduction passes on the fix…');
    const after = await verify(out.reproduction, out.expectAfter, wt.path, timeout, ctx.log);
    if (!after.ok) return done(after.infrastructureError ? 'failed' : 'unverified', `fix does not make the reproduction pass: ${after.reason}`, run);

    // 3. Tests pass on the fix branch.
    let testTail = '(no test command)';
    if (out.testCommand) {
      ctx.log(`verify: tests — ${out.testCommand}`);
      const j = await verify({ setup: out.reproduction.setup, command: out.testCommand }, { exitCode: 'zero' }, wt.path, timeout, ctx.log);
      if (!j.ok) return done(j.infrastructureError ? 'failed' : 'unverified', `tests fail on the fix branch: ${j.reason}\n${j.outputTail.slice(-1500)}`, run);
      testTail = j.outputTail;
    }

    // Commit and push onto the claim, then publish the verified result into that pull request.
    // Preserve new modules and regression tests; generated files belong in .gitignore.
    await stageChanges(wt.path);
    const stat = await diffStat(wt.path, `origin/${defaultBranch}`);
    const author = githubCommitIdentity(await currentGithubUser());
    const sha = await commitAll(wt.path, `Fix #${issue.number}: ${issue.title}\n\n${out.summary.trim()}\n\nCloses #${issue.number}`, author);
    const target = canPush ? ctx.repo : await forkRepo(ctx.repo);
    ctx.log(`pushing ${branch} to ${target}…`);
    await pushBranch(wt.path, target, branch, await authToken());

    const body = [
      MARKER('pr', String(issue.number)),
      `Closes #${issue.number}.`,
      '',
      '## Summary',
      out.summary.trim(),
      '',
      '## Changes',
      out.changes.trim(),
      '',
      '## Reproduction',
      `From the repo root:`,
      ...(out.reproduction.setup.length ? ['Setup:', fmtCmd(out.reproduction.setup.join('\n'))] : []),
      fmtCmd(out.reproduction.command),
      `**Before** (on \`${defaultBranch}\` @ ${baseSha.slice(0, 7)}): exit ${before.exitCode}${out.expectBefore.outputIncludes ? `, output contains \`${out.expectBefore.outputIncludes}\`` : ''}`,
      fmtOut(before.outputTail),
      `**After** (this branch @ ${sha.slice(0, 7)}): exit ${after.exitCode}${out.expectAfter.outputIncludes ? `, output contains \`${out.expectAfter.outputIncludes}\`` : ''}`,
      fmtOut(after.outputTail),
      '',
      '## Testing',
      out.testCommand ? `${fmtCmd(out.testCommand)}\n${fmtOut(testTail)}` : '_This repository has no test runner the agent could find; the reproduction above is the only automated check._',
      '',
      '## Diff stat',
      fmtOut(stat),
      ...(out.notes.trim() ? ['', '## Notes', out.notes.trim()] : []),
      FOOTER('Opened'),
    ].join('\n');
    if (!claim) throw new Error('fix finished without a claim pull request');
    await editPr(ctx.repo, claim.number, { title, body });
    keepClaim = true;
    await markPrReady(ctx.repo, claim.number);
    ctx.log(`marked ${claim.url} ready`);
    return done('pr-opened', out.summary.slice(0, 1000), run, claim.url);
  } catch (e) {
    paused = isStopped(e);
    if (paused) keepClaim = true;
    throw e;
  } finally {
    if (claim && !keepClaim) {
      ctx.log(`closing draft claim ${claim.url}`);
      await closePr(ctx.repo, claim.number, `Closing this draft: no verified fix for #${issue.number}.`, { deleteBranch: true })
        .catch((e) => ctx.log(`closing the claim failed: ${(e as Error).message}`));
    }
    if (!paused) await wt.remove();
  }
}
