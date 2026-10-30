import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from './state.ts';

test('local accounting migrates legacy state and persists unknown costs across reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'idlehand-accounting-'));
  const path = join(root, 'state.sqlite');
  let state: State | undefined;
  try {
    state = new State(path);
    const task = { repo: 'o/r', kind: 'fix-issue' as const, target: 'issue:1', provider: 'claude' as const };
    const id = state.startTask(task);
    state.finishTask(id, { outcome: 'failed', url: null, summary: 'legacy', costUsd: 0.25, costEstimated: true, durationMs: 1 });
    state.db.exec('ALTER TABLE tasks DROP COLUMN cost_unknown');
    state.close();
    state = new State(path);
    expect(state.recent()[0]).toMatchObject({ cost_usd: 0.25, cost_unknown: 0 });
    const unknown = state.startTask(task);
    state.finishTask(unknown, { outcome: 'failed', url: null, summary: 'final accounting unavailable', costUsd: 0.5, costEstimated: true, costUnknown: true, durationMs: 1 });
    state.close();
    state = new State(path);
    expect(state.recent()[0]).toMatchObject({ cost_usd: 0.5, cost_unknown: 1 });
    expect(state.totals('1970-01-01')).toMatchObject({ spentUsd: 0.75, costUnknown: true, tasks: 2 });
    state.startTask({ ...task, target: 'issue:2' });
    state.reapRunning();
    expect(state.recent()[0]).toMatchObject({ cost_unknown: 1, cost_estimated: 1 });
  } finally {
    state?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
