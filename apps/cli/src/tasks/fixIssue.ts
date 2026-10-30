import { ensureBase, headSha, makeWorktree, hasChanges, stageChanges, commitAll, pushBranch, diffStat } from '../workspace.ts';
import { authToken, commentOnIssue, createPr, forkRepo, type IssueSummary } from '../gh.ts';
import { commandLooksSafe, verify } from '../verify.ts';
import { FIX_ISSUE_SCHEMA } from './schemas.ts';
import { fixIssuePrompt } from './prompts.ts';
import { FOOTER, MARKER, fmtCmd, fmtOut, type TaskContext, type TaskResult } from './common.ts';

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
  const branch = `idlehand/issue-${issue.number}`;
  const wt = await makeWorktree(ctx.repo, base, `origin/${defaultBranch}`, `issue-${issue.number}`, branch);
  const done = (outcome: TaskResult['outcome'], summary: string, run?: { costUsd: number; costEstimated: boolean; exhausted: boolean }, url: string | null = null): TaskResult =>
    ({ kind, outcome, url, summary, costUsd: run?.costUsd ?? 0, costEstimated: run?.costEstimated ?? false, durationMs: Date.now() - started, exhausted: run?.exhausted ?? false });
  try {
    ctx.log(`agent: working on #${issue.number} ${issue.title}`);
    const run = await ctx.provider.run({
      cwd: wt.path,
      prompt: fixIssuePrompt(ctx.repo, defaultBranch, issue, branch),
      schema: FIX_ISSUE_SCHEMA,
      maxBudgetUsd: ctx.maxBudgetUsd,
      timeoutMs: ctx.cfg.policy.taskTimeoutMin * 60_000,
      onLog: ctx.log,
    });
    if (run.error || !run.output) return done('failed', run.error ?? 'no output', run);
    const out = run.output as FixOutput;

    if (out.status !== 'fixed') {
      ctx.log(`agent concluded: ${out.status} — ${out.notes.slice(0, 200)}`);
      if (ctx.cfg.policy.commentOnIssues && (out.status === 'not_a_bug' || out.status === 'needs_info' || out.status === 'cannot_reproduce')) {
        const body = `${MARKER('issue-comment', String(issue.number))}I took a look at this and could not turn it into a fix yet (**${out.status.replace('_', ' ')}**).\n\n${out.notes.trim()}\n\n${out.reproduction?.command ? `What I tried:\n${fmtCmd(out.reproduction.command)}` : ''}${FOOTER('Comment')}`;
        await commentOnIssue(ctx.repo, issue.number, body).catch((e) => ctx.log(`comment failed: ${(e as Error).message}`));
      }
      return done('nothing-found', `${out.status}: ${out.notes}`.slice(0, 1000), run);
    }

    if (!(await hasChanges(wt.path))) return done('unverified', 'agent said "fixed" but the working tree has no changes', run);
    const unsafe = commandLooksSafe(out.reproduction.command) ?? out.reproduction.setup.map(commandLooksSafe).find(Boolean) ?? (out.testCommand ? commandLooksSafe(out.testCommand) : null);
    if (unsafe) return done('unverified', `rejected command: ${unsafe}`, run);

    const timeout = ctx.cfg.policy.commandTimeoutSec * 1000;

    // 1. The bug must exist on the base branch.
    ctx.log('verify: reproduction fails on the base branch…');
    const baseWt = await makeWorktree(ctx.repo, base, `origin/${defaultBranch}`, `issue-${issue.number}-base`);
    let before;
    try {
      before = await verify(out.reproduction, out.expectBefore, baseWt.path, timeout, ctx.log);
    } finally {
      await baseWt.remove();
    }
    if (!before.ok) return done(before.infrastructureError ? 'failed' : 'unverified', `could not confirm the bug on ${defaultBranch}: ${before.reason}`, run);

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

    // Commit, push (to origin if we may, else to a fork), open PR.
    // Preserve new modules and regression tests; generated files belong in .gitignore.
    await stageChanges(wt.path);
    const stat = await diffStat(wt.path, `origin/${defaultBranch}`);
    const sha = await commitAll(wt.path, `Fix #${issue.number}: ${issue.title}\n\n${out.summary.trim()}\n\nCloses #${issue.number}`);
    const canPush = !!ctx.info.permissions?.push;
    const target = canPush ? ctx.repo : await forkRepo(ctx.repo);
    ctx.log(`pushing ${branch} to ${target}…`);
    await pushBranch(wt.path, target, branch, await authToken());
    const head = canPush ? branch : `${target.split('/')[0]}:${branch}`;

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
    const url = await createPr(ctx.repo, { title: `Fix #${issue.number}: ${issue.title}`.slice(0, 250), body, head, base: defaultBranch });
    ctx.log(`opened ${url}`);
    return done('pr-opened', out.summary.slice(0, 1000), run, url);
  } finally {
    await wt.remove();
  }
}
