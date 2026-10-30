import { expect, test } from 'bun:test';

test('codebase infrastructure and publishing failures remain eligible for bounded retries', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    let phase = 'infrastructure';
    mock.module(${path('../providers/index.ts')}, () => ({providerBudgetError: () => null}));
    mock.module(${path('./fixIssue.ts')}, () => ({fixIssue: async () => {throw new Error('unexpected task');}}));
    mock.module(${path('./reviewPr.ts')}, () => ({reviewPr: async () => {throw new Error('unexpected task');}}));
    mock.module(${path('../workspace.ts')}, () => ({
      ensureBase: async () => '/unused', headSha: async () => 'abcdef',
      makeWorktree: async () => ({path: '/unused', remove: async () => {}}),
      pruneWorktrees: async () => {},
    }));
    mock.module(${path('../shell.ts')}, () => ({exec: async () => ({code: 0, stdout: '', stderr: ''})}));
    mock.module(${path('../verify.ts')}, () => ({
      commandLooksSafe: () => null, similarTitle: () => false,
      verify: async () => phase === 'infrastructure'
        ? {ok: false, infrastructureError: true, reason: 'sandbox unavailable'}
        : {ok: true, exitCode: 1, outputTail: 'reproduced'},
    }));
    mock.module(${path('../gh.ts')}, () => ({
      issueBodies: async () => [], ensureLabel: async () => true,
      currentLogin: async () => 'me', listOpenIssues: async () => [], listOpenPrs: async () => [], repoInfo: async () => ({}),
      createIssue: async () => {if (phase === 'publish') throw new Error('temporary GitHub failure'); return 'https://github.com/o/r/issues/1';},
    }));
    const { reviewCodebase } = await import(${path('./reviewCodebase.ts')});
    const { planCandidates } = await import(${path('../scheduler.ts')});
    const { DEFAULT_CONFIG } = await import(${path('../config.ts')});
    const { State, TASK_RETRY_DELAY_MS } = await import(${path('../state.ts')});
    const now = new Date('2026-01-01T01:00:00Z');
    for (phase of ['infrastructure', 'publish', 'success']) {
      const state = new State(':memory:');
      const info = {default_branch: 'main', archived: false};
      const ctx = {repo: 'o/r', info, login: 'me', cfg: structuredClone(DEFAULT_CONFIG), state, log() {}, maxBudgetUsd: 1,
        provider: {run: async () => ({output: {findings: [{title: 'Reproduced bug', severity: 'high', body: 'bug', reproduction: {setup: [], command: 'echo bug'}, expect: {exitCode: 'nonzero'}, observed: 'bug'}]}, costUsd: 0.1, costEstimated: true, exhausted: false})}};
      const id = state.startTask({repo: 'o/r', kind: 'review-codebase', target: 'codebase:2026-01-01', provider: 'claude'});
      let result;
      try {result = await reviewCodebase(ctx);} catch {result = {outcome: 'failed', url: null, summary: 'temporary failure', costUsd: 0.1, costEstimated: true, durationMs: 1};}
      state.finishTask(id, result);
      state.db.query('UPDATE tasks SET finished_at=? WHERE id=?').run(now.toISOString(), id);
      if (phase === 'success') {
        assert.equal(result.outcome, 'issues-filed');
        assert.ok(state.lastCodebaseReview('o/r'));
      } else {
        assert.equal(result.outcome, 'failed');
        assert.equal(state.lastCodebaseReview('o/r'), null);
        const candidates = planCandidates([{repo: 'o/r', info, prs: [], issues: []}], {login: 'me', cfg: ctx.cfg, state, now: new Date(now.getTime() + TASK_RETRY_DELAY_MS), only: ['review-codebase']});
        assert.equal(candidates.length, 1);
      }
      state.close();
    }
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
});
