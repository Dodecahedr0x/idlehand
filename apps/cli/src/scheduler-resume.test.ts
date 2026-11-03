import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a later run resumes an interrupted task in its workspace and session', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const work = mkdtempSync(join(tmpdir(), 'idlehand-resume-'));
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    mock.module(${path('./workspace.ts')}, () => ({ pruneWorktrees: async () => {} }));
    mock.module(${path('./tasks/reviewPr.ts')}, () => ({ reviewPr: async () => { throw new Error('unexpected review'); }, closeFailedPr: async () => { throw new Error('unexpected review'); }, squashReadyPr: async () => { throw new Error('unexpected review'); } }));
    mock.module(${path('./tasks/reviewCodebase.ts')}, () => ({ reviewCodebase: async () => { throw new Error('unexpected review'); } }));
    const seen = [];
    mock.module(${path('./tasks/fixIssue.ts')}, () => ({ fixIssue: async (ctx) => {
      seen.push(ctx.resume);
      const run = await ctx.provider.run({ cwd: ctx.resume.worktree, prompt: 'original', schema: {}, maxBudgetUsd: null, timeoutMs: 1, onLog() {} });
      return { kind: 'fix-issue', outcome: 'pr-opened', url: 'https://example.test/pull/1', summary: 'resumed', costUsd: run.costUsd, costEstimated: false, durationMs: 1, exhausted: false };
    } }));
    const { Scheduler } = await import(${path('./scheduler.ts')});
    const { DEFAULT_CONFIG } = await import(${path('./config.ts')});
    const { State } = await import(${path('./state.ts')});
    const { parseBudget } = await import(${path('../../../packages/shared/src/budget.ts')});
    const state = new State(':memory:');
    const id = state.startTask({ repo: 'o/r', kind: 'fix-issue', target: 'issue:1', provider: 'claude' });
    state.saveCheckpoint(id, { worktree: ${JSON.stringify(work)}, sessionId: 'sess-1', branch: 'idlehand/issue-1' });
    let requests = 0;
    const provider = { name: 'claude', supportsUsdBudget: true, check: async () => ({ ok: true, detail: '' }), run: async (req) => {
      requests++;
      assert.equal(req.resumeSessionId, 'sess-1');
      assert.equal(req.cwd, ${JSON.stringify(work)});
      return { output: { status: 'fixed' }, costUsd: 0.2, costEstimated: false, durationMs: 1, exhausted: false, error: null, sessionId: 'sess-1', rawTail: '' };
    } };
    const issue = { number: 1, title: 'crash', labels: [], assignees: [], createdAt: '2026-01-01' };
    const scheduler = new Scheduler({ repos: ['o/r'], budget: parseBudget('3 tasks'), cfg: structuredClone(DEFAULT_CONFIG), provider, state, only: ['fix-issue'], jobs: 1 });
    scheduler.scan = async () => ({ login: 'me', scans: [{ repo: 'o/r', info: { archived: false, default_branch: 'main' }, prs: [], issues: [issue] }] });
    const result = await scheduler.run();
    assert.equal(requests, 1);
    assert.equal(seen[0].worktree, ${JSON.stringify(work)});
    assert.equal(seen[0].sessionId, 'sess-1');
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0].outcome, 'pr-opened');
    assert.equal(state.listRunning().length, 0);
    assert.equal(state.recent().length, 1);
    assert.equal(state.recent()[0].id, id);
    state.close();
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  rmSync(work, { recursive: true, force: true });
  expect(stderr).toBe('');
  expect(code).toBe(0);
});

test('a fresh follow-up does not resume or replace the interrupted session', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const work = mkdtempSync(join(tmpdir(), 'idlehand-fresh-'));
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    mock.module(${path('./workspace.ts')}, () => ({ pruneWorktrees: async () => {} }));
    mock.module(${path('./tasks/reviewPr.ts')}, () => ({ reviewPr: async () => { throw new Error('unexpected review'); }, closeFailedPr: async () => { throw new Error('unexpected review'); }, squashReadyPr: async () => { throw new Error('unexpected review'); } }));
    mock.module(${path('./tasks/reviewCodebase.ts')}, () => ({ reviewCodebase: async () => { throw new Error('unexpected review'); } }));
    mock.module(${path('./tasks/fixIssue.ts')}, () => ({ fixIssue: async (ctx) => {
      const first = await ctx.provider.run({ cwd: ctx.resume.worktree, prompt: 'original', schema: {}, maxBudgetUsd: null, timeoutMs: 1, onLog() {} });
      const follow = await ctx.provider.run({ cwd: ctx.resume.worktree, prompt: 'consider an issue', schema: {}, maxBudgetUsd: null, timeoutMs: 1, onLog() {}, fresh: true });
      return { kind: 'fix-issue', outcome: 'failed', url: null, summary: 'failed', costUsd: first.costUsd + follow.costUsd, costEstimated: false, durationMs: 1, exhausted: false };
    } }));
    const { Scheduler } = await import(${path('./scheduler.ts')});
    const { DEFAULT_CONFIG } = await import(${path('./config.ts')});
    const { State } = await import(${path('./state.ts')});
    const { parseBudget } = await import(${path('../../../packages/shared/src/budget.ts')});
    const state = new State(':memory:');
    const id = state.startTask({ repo: 'o/r', kind: 'fix-issue', target: 'issue:1', provider: 'claude' });
    state.saveCheckpoint(id, { worktree: ${JSON.stringify(work)}, sessionId: 'sess-1', branch: 'idlehand/issue-1' });
    const requests = [];
    const provider = { name: 'claude', supportsUsdBudget: true, check: async () => ({ ok: true, detail: '' }), run: async (req) => {
      requests.push({ resume: req.resumeSessionId ?? null, prompt: req.prompt });
      req.onSession?.('sess-follow');
      return { output: {}, costUsd: 0.2, costEstimated: false, durationMs: 1, exhausted: false, error: null, sessionId: req.resumeSessionId ?? 'sess-follow', rawTail: '' };
    } };
    const issue = { number: 1, title: 'crash', labels: [], assignees: [], createdAt: '2026-01-01' };
    const scheduler = new Scheduler({ repos: ['o/r'], budget: parseBudget('3 tasks'), cfg: structuredClone(DEFAULT_CONFIG), provider, state, only: ['fix-issue'], jobs: 1 });
    scheduler.scan = async () => ({ login: 'me', scans: [{ repo: 'o/r', info: { archived: false, default_branch: 'main' }, prs: [], issues: [issue] }] });
    const result = await scheduler.run();
    assert.deepEqual(requests, [
      { resume: 'sess-1', prompt: 'original' },
      { resume: null, prompt: 'consider an issue' },
    ]);
    assert.equal(result.reports[0].costUsd, 0.4);
    assert.equal(JSON.parse(state.recent()[0].checkpoint).sessionId, 'sess-1');
    state.close();
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  rmSync(work, { recursive: true, force: true });
  expect(stderr).toBe('');
  expect(stdout).toBe('');
  expect(code).toBe(0);
});

test('stopping mid-task leaves the workspace and session running for the next launch', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const work = mkdtempSync(join(tmpdir(), 'idlehand-pause-'));
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    mock.module(${path('./workspace.ts')}, () => ({ pruneWorktrees: async () => {} }));
    mock.module(${path('./tasks/reviewPr.ts')}, () => ({ reviewPr: async () => { throw new Error('unexpected review'); }, closeFailedPr: async () => { throw new Error('unexpected review'); }, squashReadyPr: async () => { throw new Error('unexpected review'); } }));
    mock.module(${path('./tasks/reviewCodebase.ts')}, () => ({ reviewCodebase: async () => { throw new Error('unexpected review'); } }));
    mock.module(${path('./tasks/fixIssue.ts')}, () => ({ fixIssue: async (ctx) => {
      ctx.saveWorkspace({ worktree: ${JSON.stringify(work)}, branch: 'idlehand/issue-1' });
      await ctx.provider.run({ cwd: ${JSON.stringify(work)}, prompt: 'original', schema: {}, maxBudgetUsd: null, timeoutMs: 1, onLog() {} });
      throw new Error('the agent should have been stopped');
    } }));
    const { Scheduler } = await import(${path('./scheduler.ts')});
    const { DEFAULT_CONFIG } = await import(${path('./config.ts')});
    const { State } = await import(${path('./state.ts')});
    const { Stopped } = await import(${path('./shell.ts')});
    const { parseBudget } = await import(${path('../../../packages/shared/src/budget.ts')});
    const state = new State(':memory:');
    const provider = { name: 'claude', supportsUsdBudget: true, check: async () => ({ ok: true, detail: '' }), run: async (req) => {
      req.onSession('sess-new');
      scheduler.stop();
      throw new Stopped();
    } };
    const issue = { number: 1, title: 'crash', labels: [], assignees: [], createdAt: '2026-01-01' };
    const scheduler = new Scheduler({ repos: ['o/r'], budget: parseBudget('3 tasks'), cfg: structuredClone(DEFAULT_CONFIG), provider, state, only: ['fix-issue'], jobs: 1 });
    scheduler.scan = async () => ({ login: 'me', scans: [{ repo: 'o/r', info: { archived: false, default_branch: 'main' }, prs: [], issues: [issue] }] });
    const result = await scheduler.run();
    assert.equal(result.reason, 'stopped by user');
    assert.equal(result.reports.length, 0);
    const running = state.listRunning();
    assert.equal(running.length, 1);
    assert.deepEqual(JSON.parse(running[0].checkpoint), { worktree: ${JSON.stringify(work)}, branch: 'idlehand/issue-1', sessionId: 'sess-new' });
    state.close();
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  rmSync(work, { recursive: true, force: true });
  expect(stderr).toBe('');
  expect(code).toBe(0);
});
