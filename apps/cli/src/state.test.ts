import { afterEach, expect, test } from 'bun:test';
import { MAX_TASK_ATTEMPTS, State, TASK_RETRY_DELAY_MS } from './state.ts';
import type { TaskOutcome } from '@idlehand/shared';

const states: State[] = [];
afterEach(() => { for (const state of states.splice(0)) state.close(); });
function fixture() {
  const state = new State(':memory:');
  states.push(state);
  const target = { repo: 'o/r', kind: 'fix-issue' as const, target: 'issue:1', provider: 'claude' as const };
  const now = new Date('2026-01-01T00:00:00Z');
  const finish = (outcome: TaskOutcome) => {
    const id = state.startTask(target);
    state.finishTask(id, { outcome, url: null, summary: outcome, costUsd: 0.2, costEstimated: false, durationMs: 1 });
    state.db.query('UPDATE tasks SET finished_at=? WHERE id=?').run(now.toISOString(), id);
  };
  const seen = (elapsed = 0) => state.seen(target.repo, target.kind, target.target, new Date(now.getTime() + elapsed));
  return { state, target, now, finish, seen };
}

test('failed tasks retry after the cooldown, with a fixed attempt limit and preserved spend', () => {
  const f = fixture();
  expect(f.seen()).toBe(false);
  f.finish('failed');
  expect(f.seen(TASK_RETRY_DELAY_MS - 1)).toBe(true);
  expect(f.seen(TASK_RETRY_DELAY_MS)).toBe(false);
  for (let attempt = 1; attempt < MAX_TASK_ATTEMPTS; attempt++) f.finish('failed');
  expect(f.seen(TASK_RETRY_DELAY_MS * 100)).toBe(true);
  expect(f.state.totals('1970-01-01').spentUsd).toBeCloseTo(0.2 * MAX_TASK_ATTEMPTS);
});

test('completed, inconclusive and active work do not retry automatically', () => {
  for (const outcome of ['pr-opened', 'nothing-found', 'unverified'] as const) {
    const f = fixture();
    f.finish('failed');
    f.finish(outcome);
    expect(f.seen(TASK_RETRY_DELAY_MS * 100)).toBe(true);
  }
  const f = fixture();
  f.state.startTask(f.target);
  expect(f.seen(TASK_RETRY_DELAY_MS * 100)).toBe(true);
});

test('interrupted work can retry after being reaped and cooling down', () => {
  const f = fixture();
  f.state.startTask(f.target);
  expect(f.state.reapRunning()).toBe(1);
  expect(f.state.seen(f.target.repo, f.target.kind, f.target.target)).toBe(true);
  expect(f.state.seen(f.target.repo, f.target.kind, f.target.target, new Date(Date.now() + TASK_RETRY_DELAY_MS + 1000))).toBe(false);
});
