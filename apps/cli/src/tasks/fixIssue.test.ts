import { expect, test } from 'bun:test';

test('an issue that cannot be verified is closed with an explanation, and a failed fix is not', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const wt = mkdtempSync(join(tmpdir(), 'idlehand-fix-'));
    const closes = [];
    const comments = [];
    let phase = 'agent-no-repro';
    let verifyCalls = 0;
    mock.module(${path('../workspace.ts')}, () => ({
      ensureBase: async () => '/base',
      headSha: async (p) => p === wt ? 'def' : 'abc',
      makeWorktree: async () => ({ path: wt, remove: async () => {} }),
      attachWorktree: () => ({ path: wt, remove: async () => {} }),
      hasChanges: async () => true,
      stageChanges: async () => {},
      stageForced: async () => {},
      commitAll: async () => 'sha',
      pushBranch: async () => {},
      diffStat: async () => '',
    }));
    mock.module(${path('../gh.ts')}, () => ({
      authToken: async () => 'tok',
      commentOnIssue: async (_repo, _number, body) => { comments.push(body); return ''; },
      createPr: async () => 'https://github.com/o/r/pull/9',
      currentGithubUser: async () => ({ login: 'me', id: '1', name: null }),
      editPr: async () => {},
      forkRepo: async () => 'me/r',
      githubCommitIdentity: () => ({ name: 'me', email: 'me@example.com' }),
      markPrReady: async () => {},
      openPrForBranch: async () => null,
      closePr: async () => {},
      closeIssue: async (repo, number, comment) => {
        if (phase === 'no-permission') throw new Error('gh issue close failed (1): HTTP 403');
        closes.push({ repo, number, comment });
      },
      issueBodies: async () => [],
      ensureLabel: async () => true,
      createIssue: async () => { throw new Error('unexpected issue'); },
    }));
    mock.module(${path('../verify.ts')}, () => ({
      commandLooksSafe: () => null,
      similarTitle: () => false,
      verify: async () => {
        verifyCalls++;
        if (phase === 'bug-missing') return { ok: false, reason: 'expected nonzero, got 0', exitCode: 0, timedOut: false, outputTail: 'ok', durationMs: 1 };
        if (phase === 'fix-failed' && verifyCalls > 1) return { ok: false, reason: 'still broken', exitCode: 1, timedOut: false, outputTail: 'bug', durationMs: 1 };
        return { ok: true, reason: null, exitCode: 1, timedOut: false, outputTail: 'bug', durationMs: 1 };
      },
    }));
    const { fixIssue } = await import(${path('./fixIssue.ts')});
    const { DEFAULT_CONFIG } = await import(${path('../config.ts')});
    const issue = { number: 7, title: 'crash', body: '', author: { login: 'x' }, labels: [], assignees: [], url: 'https://github.com/o/r/issues/7', createdAt: '2026-01-01', updatedAt: '', comments: { totalCount: 0 }, state: 'OPEN' };
    const expectBefore = { exitCode: 'nonzero', outputIncludes: null, outputExcludes: null };
    const fixed = { status: 'fixed', summary: 'fixed', changes: 'x', notes: '', reproduction: { setup: [], command: 'bug' }, expectBefore, expectAfter: { exitCode: 'zero', outputIncludes: null, outputExcludes: null }, testCommand: null };
    const ctx = () => ({
      repo: 'o/r', info: { default_branch: 'main', permissions: { push: true } }, login: 'me', cfg: structuredClone(DEFAULT_CONFIG),
      state: {}, log() {}, maxBudgetUsd: null,
      provider: { run: async () => ({ costUsd: 0, costEstimated: false, exhausted: false, error: null, output: phase === 'agent-no-repro' || phase === 'no-permission' ? { status: 'cannot_reproduce', summary: '', changes: '', notes: 'works on main', reproduction: { setup: [], command: 'true' }, expectBefore, expectAfter: { exitCode: 'zero', outputIncludes: null, outputExcludes: null }, testCommand: null } : fixed }) },
    });

    let result = await fixIssue(ctx(), issue);
    assert.equal(result.outcome, 'nothing-found');
    assert.equal(result.url, issue.url);
    assert.equal(closes.length, 1);
    assert.equal(closes[0].repo, 'o/r');
    assert.equal(closes[0].number, 7);
    assert.match(closes[0].comment, /could not verify/i);
    assert.match(closes[0].comment, /works on main/);
    assert.equal(comments.length, 0);

    phase = 'no-permission';
    result = await fixIssue(ctx(), issue);
    assert.equal(closes.length, 1);
    assert.equal(comments.length, 1);
    assert.match(comments[0], /works on main/);
    assert.equal(result.url, issue.url);

    phase = 'bug-missing';
    result = await fixIssue(ctx(), issue);
    assert.equal(result.outcome, 'unverified');
    assert.match(result.summary, /could not confirm the bug/);
    assert.equal(closes.length, 2);
    assert.match(closes[1].comment, /expected nonzero, got 0/);

    phase = 'fix-failed';
    verifyCalls = 0;
    const before = closes.length;
    result = await fixIssue(ctx(), issue);
    assert.equal(result.outcome, 'unverified');
    assert.match(result.summary, /fix does not make the reproduction pass/);
    assert.equal(closes.length, before);
    assert.equal(result.url, null);
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(stdout).toBe('');
  expect(code).toBe(0);
});
