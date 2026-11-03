import { expect, test } from 'bun:test';

test('a failed agent considers an issue and the runner files it only when reproduced', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const wt = mkdtempSync(join(tmpdir(), 'idlehand-fail-'));
    const created = [];
    const calls = [];
    let titles = [];
    let safe = null;
    let verified = true;
    mock.module(${path('../workspace.ts')}, () => ({
      ensureBase: async () => '/base',
      headSha: async () => 'abcdef0',
      makeWorktree: async () => ({ path: wt, remove: async () => {} }),
      attachWorktree: () => ({ path: wt, remove: async () => {} }),
      fetchPrRef: async () => 'origin/pr/3',
      hasChanges: async () => false,
      stageChanges: async () => {},
      stageForced: async () => {},
      commitAll: async () => 'sha',
      pushBranch: async () => {},
      diffStat: async () => '',
    }));
    mock.module(${path('../gh.ts')}, () => ({
      authToken: async () => 'tok',
      commentOnIssue: async () => '',
      closeIssue: async () => {},
      closePr: async () => { created.push('closed-claim'); },
      createPr: async () => 'https://github.com/o/r/pull/9',
      currentGithubUser: async () => ({ login: 'me', id: '1', name: null }),
      editPr: async () => {},
      forkRepo: async () => 'me/r',
      githubCommitIdentity: () => ({ name: 'me', email: 'me@example.com' }),
      markPrReady: async () => {},
      openPrForBranch: async () => null,
      issueBodies: async () => titles.map((title) => ({ number: 1, title, body: '' })),
      ensureLabel: async () => true,
      createIssue: async (repo, title, body) => { created.push({ repo, title, body }); return 'https://github.com/o/r/issues/4'; },
      ciStatus: () => 'none',
      mergePr: async () => {},
      postPrReview: async () => {},
      squashMarker: () => '',
      prDetail: async () => ({ number: 3, title: 'Fix crash', body: '', author: { login: 'x' }, baseRefName: 'main', headRefName: 'feat', headRefOid: 'abc', headRepositoryOwner: null, headRepository: null, url: 'https://github.com/o/r/pull/3', mergeable: 'MERGEABLE', mergeStateStatus: '', reviewDecision: '', statusCheckRollup: [], files: [], commits: [], comments: [] }),
      prDiff: async () => '',
    }));
    mock.module(${path('../verify.ts')}, () => ({
      commandLooksSafe: () => safe,
      similarTitle: (a, b) => a.toLowerCase() === b.toLowerCase(),
      verify: async () => verified
        ? { ok: true, reason: null, exitCode: 1, timedOut: false, outputTail: 'boom', durationMs: 1 }
        : { ok: false, reason: 'expected a non-zero exit, got 0', exitCode: 0, timedOut: false, outputTail: 'ok', durationMs: 1 },
    }));
    const { considerFailureIssue } = await import(${path('./failureIssue.ts')});
    const { reviewCodebase } = await import(${path('./reviewCodebase.ts')});
    const { fixIssue } = await import(${path('./fixIssue.ts')});
    const { reviewPr } = await import(${path('./reviewPr.ts')});
    const { DEFAULT_CONFIG } = await import(${path('../config.ts')});
    const finding = { title: 'Build fails on main', severity: 'high', body: 'The default branch does not build.', reproduction: { setup: [], command: 'echo boom && exit 1' }, expect: { exitCode: 'nonzero', outputIncludes: 'boom', outputExcludes: null }, observed: 'boom' };
    const fail = (error, extra = {}) => ({ output: null, error, costUsd: 0.3, costEstimated: false, exhausted: false, rawTail: 'Error: boom', sessionId: 'sess-task', durationMs: 1, ...extra });
    const follow = (output, extra = {}) => ({ output, error: null, costUsd: 0.2, costEstimated: false, exhausted: false, rawTail: '', sessionId: 'sess-consider', durationMs: 1, ...extra });
    const scripts = [];
    const provider = { run: async (req) => { calls.push(req); const next = scripts.shift(); if (!next) throw new Error('unexpected provider call'); return next(req); } };
    const ctx = () => ({ repo: 'o/r', info: { default_branch: 'main', permissions: { push: true } }, login: 'me', cfg: structuredClone(DEFAULT_CONFIG), state: { markCodebaseReview() {} }, log() {}, maxBudgetUsd: null, provider });
    const issue = { number: 7, title: 'crash', body: '', author: { login: 'x' }, labels: [], assignees: [], url: 'https://github.com/o/r/issues/7', createdAt: '2026-01-01', updatedAt: '', comments: { totalCount: 0 }, state: 'OPEN' };
    const pr = { number: 3, title: 'Fix crash', author: { login: 'x' }, url: 'https://github.com/o/r/pull/3', headRefName: 'feat', baseRefName: 'main', isDraft: false, labels: [], createdAt: '2026-01-01', updatedAt: '', comments: { totalCount: 0 } };

    for (const error of ['credits exhausted', 'claude reached the $1 budget threshold', 'no output']) {
      calls.length = 0;
      const stopped = error === 'credits exhausted' ? fail(error, { exhausted: true }) : error === 'no output' ? fail(null, { costUnknown: true, error: null }) : fail(error);
      const judged = await considerFailureIssue(ctx(), { base: '/base', cwd: wt, branch: 'main', task: 'a codebase review of o/r', run: stopped });
      assert.equal(calls.length, 0, error);
      assert.equal(judged.url, null);
      assert.equal(created.length, 0);
    }

    scripts.push(() => follow({ findings: [], notes: 'this was my mistake' }, { costEstimated: true }));
    let judged = await considerFailureIssue(ctx(), { base: '/base', cwd: wt, branch: 'main', task: 'fixing #7: crash', run: fail('claude exited 1: boom') });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fresh, true);
    assert.match(calls[0].prompt, /must consider whether to open an issue/i);
    assert.match(calls[0].prompt, /claude exited 1: boom/);
    assert.match(calls[0].prompt, /fixing #7: crash/);
    assert.match(calls[0].prompt, /Zero findings/);
    assert.equal(judged.url, null);
    assert.equal(judged.summary, 'claude exited 1: boom');
    assert.equal(judged.costUsd, 0.5);
    assert.equal(judged.costEstimated, true);
    assert.equal(created.filter((item) => item !== 'closed-claim').length, 0);

    calls.length = 0;
    scripts.push(() => fail('follow-up died'));
    judged = await considerFailureIssue(ctx(), { base: '/base', cwd: wt, branch: 'main', task: 'a codebase review of o/r', run: fail('claude exited 1: boom') });
    assert.equal(calls.length, 1);
    assert.equal(judged.url, null);

    calls.length = 0;
    verified = false;
    scripts.push(() => follow({ findings: [finding], notes: 'saw it' }));
    judged = await considerFailureIssue(ctx(), { base: '/base', cwd: wt, branch: 'main', task: 'a codebase review of o/r', run: fail('claude exited 1: boom') });
    assert.equal(judged.url, null);
    assert.equal(created.filter((item) => item !== 'closed-claim').length, 0);

    calls.length = 0;
    verified = true;
    titles = ['Build fails on main'];
    scripts.push(() => follow({ findings: [finding], notes: 'saw it' }));
    judged = await considerFailureIssue(ctx(), { base: '/base', cwd: wt, branch: 'main', task: 'a codebase review of o/r', run: fail('claude exited 1: boom') });
    assert.equal(judged.url, null);

    calls.length = 0;
    titles = [];
    safe = 'refuses to run sudo';
    scripts.push(() => follow({ findings: [finding], notes: 'saw it' }));
    judged = await considerFailureIssue(ctx(), { base: '/base', cwd: wt, branch: 'main', task: 'a codebase review of o/r', run: fail('claude exited 1: boom') });
    assert.equal(judged.url, null);
    safe = null;

    calls.length = 0;
    scripts.push(() => follow({ findings: [finding, { ...finding, title: 'Second bug' }], notes: 'saw two' }));
    judged = await considerFailureIssue(ctx(), { base: '/base', cwd: wt, branch: 'main', task: 'a codebase review of o/r', run: fail('claude exited 1: boom') });
    assert.equal(judged.url, 'https://github.com/o/r/issues/4');
    assert.ok(judged.summary.includes('Filed https://github.com/o/r/issues/4'));
    assert.equal(judged.costUsd, 0.5);
    const filed = created.filter((item) => item && item.title);
    assert.equal(filed.length, 1);
    assert.equal(filed[0].title, 'Build fails on main');
    assert.match(filed[0].body, /Reproduction/);
    assert.match(filed[0].body, /echo boom && exit 1/);
    assert.match(filed[0].body, /boom/);

    calls.length = 0;
    created.length = 0;
    scripts.push(() => fail('claude exited 1: boom'), () => follow({ findings: [finding], notes: 'the review crashed on a broken build' }));
    let result = await reviewCodebase(ctx());
    assert.equal(result.outcome, 'failed');
    assert.equal(result.url, 'https://github.com/o/r/issues/4');
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /codebase review of o\\/r/);
    assert.equal(calls[1].fresh, true);

    calls.length = 0;
    created.length = 0;
    scripts.push(() => fail('claude exited 1: boom'), () => follow({ findings: [], notes: 'already the issue I was fixing' }));
    result = await fixIssue(ctx(), issue);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.url, null);
    assert.match(result.summary, /claude exited 1: boom/);
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /fixing #7: crash/);
    assert.equal(created.includes('closed-claim'), true);
    assert.equal(created.filter((item) => item && item.title).length, 0);

    calls.length = 0;
    created.length = 0;
    scripts.push(() => fail('claude exited 1: boom'), () => follow({ findings: [finding], notes: 'default branch does not build' }));
    result = await reviewPr(ctx(), pr);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.url, 'https://github.com/o/r/issues/4');
    assert.equal(result.costUsd, 0.5);
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /reviewing pull request #3: Fix crash/);
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(stdout).toBe('');
  expect(code).toBe(0);
});
