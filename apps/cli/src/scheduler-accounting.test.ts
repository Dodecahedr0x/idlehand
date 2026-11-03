import { expect, test } from 'bun:test';

// Isolate task mocks in a child process so other suites keep their real modules.
test('scheduler retains charged usage on publishing failure and stops on unknown costs', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    mock.module(${path('./workspace.ts')}, () => ({ pruneWorktrees: async () => {} }));
    mock.module(${path('./tasks/reviewPr.ts')}, () => ({ reviewPr: async () => { throw new Error('unexpected task'); }, closeFailedPr: async () => { throw new Error('unexpected task'); }, squashReadyPr: async () => { throw new Error('unexpected task'); } }));
    mock.module(${path('./tasks/reviewCodebase.ts')}, () => ({ reviewCodebase: async () => { throw new Error('unexpected task'); } }));
    mock.module(${path('./tasks/fixIssue.ts')}, () => ({ fixIssue: async (ctx) => {
      await ctx.provider.run({});
      throw new Error('temporary publishing failure');
    } }));
    const { Scheduler } = await import(${path('./scheduler.ts')});
    const { DEFAULT_CONFIG } = await import(${path('./config.ts')});
    const { State } = await import(${path('./state.ts')});
    const { parseBudget } = await import(${path('../../../packages/shared/src/budget.ts')});
    for (const unknown of [false, true]) {
      const state = new State(':memory:');
      let calls = 0;
      const provider = { name: 'claude', supportsUsdBudget: true, check: async () => ({ok: true, detail: ''}), run: async () => {
        calls++;
        return {output: null, costUsd: unknown ? 0 : 0.75, costEstimated: true, costUnknown: unknown, durationMs: 1, exhausted: false, error: null, sessionId: null, rawTail: ''};
      } };
      const scheduler = new Scheduler({repos: ['o/r'], budget: parseBudget(unknown ? '3 tasks' : '$0.50'), cfg: structuredClone(DEFAULT_CONFIG), provider, state, only: ['fix-issue'], jobs: 1});
      scheduler.scan = async () => ({login: 'me', scans: [{repo: 'o/r', info: {archived: false}, prs: [], issues: [1, 2].map(number => ({number, title: 'fix', labels: [], assignees: [], createdAt: '2026-01-01'}))}]});
      const result = await scheduler.run();
      assert.equal(calls, 1);
      assert.equal(result.reports.length, 1);
      assert.equal(result.reports[0].outcome, 'failed');
      assert.equal(result.usage.spentUsd, unknown ? 0 : 0.75);
      assert.equal(state.recent()[0].cost_usd, unknown ? 0 : 0.75);
      assert.equal(!!result.usage.costUnknown, unknown);
      assert.equal(!!result.reports[0].costUnknown, unknown);
      assert.equal(!!state.recent()[0].cost_unknown, unknown);
      assert.match(result.reason, unknown ? /cost unavailable/ : /budget reached/);
      if (unknown) assert.match(result.reports[0].summary, /spending is unknown/);
      state.close();
    }
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
});
