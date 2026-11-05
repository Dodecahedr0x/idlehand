import { expect, test } from 'bun:test';

// Isolate task mocks in a child process so other suites keep their real modules.
test('scheduler runs up to jobs tasks at once and stops starting when the budget is spent', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    mock.module(${path('./workspace.ts')}, () => ({ pruneWorktrees: async () => {} }));
    mock.module(${path('./tasks/reviewPr.ts')}, () => ({ reviewPr: async () => { throw new Error('unexpected task'); }, closeFailedPr: async () => { throw new Error('unexpected task'); }, squashReadyPr: async () => { throw new Error('unexpected task'); }, addressPrComments: async () => { throw new Error('unexpected task'); }, hasActionableFeedback: () => false }));
    mock.module(${path('./tasks/reviewCodebase.ts')}, () => ({ reviewCodebase: async () => { throw new Error('unexpected task'); } }));
    const gates = [];
    mock.module(${path('./tasks/fixIssue.ts')}, () => ({ fixIssue: async (_ctx, issue) => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      gates.push({ number: issue.number, release, cost: issue.costUsd ?? 0 });
      await gate;
      return { kind: 'fix-issue', outcome: 'nothing-found', url: null, summary: 'ok', costUsd: issue.costUsd ?? 0, costEstimated: false, durationMs: 1, exhausted: false };
    } }));
    const { Scheduler } = await import(${path('./scheduler.ts')});
    const { DEFAULT_CONFIG } = await import(${path('./config.ts')});
    const { State } = await import(${path('./state.ts')});
    const { parseBudget } = await import(${path('../../../packages/shared/src/budget.ts')});

    const issues = (n, costUsd = 0) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: 'fix', labels: [], assignees: [], createdAt: '2026-01-01', costUsd }));
    const provider = { name: 'claude', supportsUsdBudget: true, check: async () => ({ ok: true, detail: '' }), run: async () => { throw new Error('provider should not be called'); } };
    const run = (over) => {
      gates.length = 0;
      const state = new State(':memory:');
      const scheduler = new Scheduler({ repos: ['o/r'], cfg: structuredClone(DEFAULT_CONFIG), provider, state, only: ['fix-issue'], ...over });
      scheduler.scan = async () => ({ login: 'me', scans: [{ repo: 'o/r', info: { archived: false, default_branch: 'main' }, prs: [], issues: over.issues }] });
      return { state, scheduler, pending: scheduler.run() };
    };
    const waitFor = async (n) => { while (gates.length < n) await Bun.sleep(5); };

    const parallel = run({ budget: parseBudget('10 tasks'), issues: issues(6) });
    await waitFor(4);
    await Bun.sleep(40);
    assert.equal(gates.length, 4, 'default jobs is 4');
    for (const gate of gates) gate.release();
    await waitFor(6);
    for (const gate of gates.slice(4)) gate.release();
    const parallelResult = await parallel.pending;
    assert.equal(parallelResult.reports.length, 6);
    parallel.state.close();

    const serial = run({ budget: parseBudget('10 tasks'), jobs: 1, issues: issues(3) });
    await waitFor(1);
    await Bun.sleep(40);
    assert.equal(gates.length, 1);
    gates[0].release();
    await waitFor(2);
    await Bun.sleep(40);
    assert.equal(gates.length, 2);
    gates[1].release();
    await waitFor(3);
    gates[2].release();
    assert.equal((await serial.pending).reports.length, 3);
    serial.state.close();

    const oneTask = run({ budget: parseBudget('1 task'), jobs: 4, issues: issues(3) });
    await waitFor(1);
    await Bun.sleep(40);
    assert.equal(gates.length, 1, 'a task budget counts tasks already running');
    gates[0].release();
    const oneResult = await oneTask.pending;
    assert.equal(gates.length, 1);
    assert.equal(oneResult.reports.length, 1);
    assert.match(oneResult.reason, /budget reached/);
    oneTask.state.close();

    const dollars = run({ budget: parseBudget('$0.50'), jobs: 2, issues: issues(3, 0.75) });
    await waitFor(2);
    await Bun.sleep(40);
    assert.equal(gates.length, 2);
    gates[0].release();
    await Bun.sleep(40);
    assert.equal(gates.length, 2, 'no new task starts after completed spend passes the budget');
    gates[1].release();
    const dollarResult = await dollars.pending;
    assert.equal(dollarResult.reports.length, 2);
    assert.equal(dollarResult.usage.spentUsd, 1.5);
    assert.match(dollarResult.reason, /budget reached/);
    dollars.state.close();
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(stdout).toBe('');
  expect(code).toBe(0);
});

test('continuous mode polls so free job slots start new work, and an idle queue does not spin', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    mock.module(${path('./workspace.ts')}, () => ({ pruneWorktrees: async () => {} }));
    mock.module(${path('./tasks/reviewPr.ts')}, () => ({ reviewPr: async () => { throw new Error('unexpected task'); }, closeFailedPr: async () => { throw new Error('unexpected task'); }, squashReadyPr: async () => { throw new Error('unexpected task'); }, addressPrComments: async () => { throw new Error('unexpected task'); }, hasActionableFeedback: () => false }));
    mock.module(${path('./tasks/reviewCodebase.ts')}, () => ({ reviewCodebase: async () => { throw new Error('unexpected task'); } }));
    const gates = [];
    mock.module(${path('./tasks/fixIssue.ts')}, () => ({ fixIssue: async (_ctx, issue) => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      gates.push({ number: issue.number, release });
      await gate;
      return { kind: 'fix-issue', outcome: 'nothing-found', url: null, summary: 'ok', costUsd: 0, costEstimated: false, durationMs: 1, exhausted: false };
    } }));
    const { Scheduler } = await import(${path('./scheduler.ts')});
    const { DEFAULT_CONFIG } = await import(${path('./config.ts')});
    const { State } = await import(${path('./state.ts')});
    const { parseBudget } = await import(${path('../../../packages/shared/src/budget.ts')});

    const issues = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: 'fix', labels: [], assignees: [], createdAt: '2026-01-01' }));
    const provider = { name: 'claude', supportsUsdBudget: true, check: async () => ({ ok: true, detail: '' }), run: async () => { throw new Error('provider should not be called'); } };
    const until = async (pred, ms) => {
      const deadline = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > deadline) return false;
        await Bun.sleep(5);
      }
      return true;
    };

    gates.length = 0;
    let scans = 0;
    const state = new State(':memory:');
    const scheduler = new Scheduler({ repos: ['o/r'], cfg: structuredClone(DEFAULT_CONFIG), provider, state, only: ['fix-issue'], budget: parseBudget('10 tasks'), jobs: 4, continuous: true, pollMs: 40 });
    scheduler.scan = async () => {
      scans++;
      return { login: 'me', scans: [{ repo: 'o/r', info: { archived: false, default_branch: 'main' }, prs: [], issues: issues(scans < 3 ? 2 : 6) }] };
    };
    const pending = scheduler.run();
    assert.equal(await until(() => gates.length >= 4, 1000), true, 'free slots pick up work found by a later scan');
    assert.equal(gates.length, 4);
    scheduler.stop();
    for (const gate of gates) gate.release();
    await pending;
    state.close();

    gates.length = 0;
    let idleScans = 0;
    const idleState = new State(':memory:');
    const idle = new Scheduler({ repos: ['o/r'], cfg: structuredClone(DEFAULT_CONFIG), provider, state: idleState, only: ['fix-issue'], budget: parseBudget('10 tasks'), jobs: 4, continuous: true, pollMs: 60_000 });
    idle.scan = async () => {
      idleScans++;
      return { login: 'me', scans: [{ repo: 'o/r', info: { archived: false, default_branch: 'main' }, prs: [], issues: [] }] };
    };
    const idlePending = idle.run();
    await Bun.sleep(200);
    idle.stop();
    await idlePending;
    assert.ok(idleScans < 5, 'idle continuous run waits between scans, got ' + idleScans);
    idleState.close();
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(stdout).toBe('');
  expect(code).toBe(0);
});
