import { expect, test } from 'bun:test';
import type { SchedulerEvent } from '../scheduler.ts';
import type { Candidate } from '../tasks/common.ts';
import { applyEvent, applyKey, emptyDash, focusedLogs, rows, taskId } from './dashboard.ts';

function cand(partial: Pick<Candidate, 'kind' | 'repo' | 'target' | 'label'>): Candidate {
  return partial as Candidate;
}

const review = cand({ kind: 'review-pr', repo: 'acme/web', target: 'pr:1', label: 'review PR #1 · login' });
const fix = cand({ kind: 'fix-issue', repo: 'acme/web', target: 'issue:2', label: 'fix issue #2 · crash' });

function run(events: SchedulerEvent[]) {
  return events.reduce(applyEvent, emptyDash());
}

test('overview lists what is running on which repo and starts unfocused', () => {
  const s = run([
    { type: 'plan', candidates: [review, fix] },
    { type: 'task-start', candidate: review, index: 0 },
  ]);
  expect(s.focus).toBeNull();
  expect(rows(s).filter((t) => t.status === 'running').map((t) => [t.repo, t.label])).toEqual([
    ['acme/web', 'review PR #1 · login'],
  ]);
});

test('enter shows only the selected task logs, and escape returns to the overview', () => {
  let s = run([
    { type: 'plan', candidates: [review, fix] },
    { type: 'task-start', candidate: review, index: 0 },
    { type: 'task-start', candidate: fix, index: 1 },
    { type: 'log', candidate: review, line: 'reading the diff' },
    { type: 'log', candidate: fix, line: 'reproducing the crash' },
  ]);
  s = applyKey(s, '', { downArrow: true });
  s = applyKey(s, '', { return: true });
  expect(s.focus).toBe(taskId(rows(s).find((t) => t.target === fix.target)!));
  expect(focusedLogs(s)).toEqual(['reproducing the crash']);
  s = applyKey(s, '', { escape: true });
  expect(s.focus).toBeNull();
  expect(rows(s).map((t) => t.target)).toEqual(['pr:1', 'issue:2']);
});

test('a later plan keeps an in-flight task and its logs', () => {
  const s = run([
    { type: 'plan', candidates: [review] },
    { type: 'task-start', candidate: review, index: 0 },
    { type: 'log', candidate: review, line: 'still going' },
    { type: 'plan', candidates: [cand({ kind: 'review-codebase', repo: 'other/lib', target: 'codebase:abc', label: 'review codebase · other/lib' })] },
  ]);
  const running = rows(s).find((t) => t.status === 'running');
  expect(running?.repo).toBe('acme/web');
  expect(running?.logs).toEqual(['still going']);
  expect(rows(s).some((t) => t.repo === 'other/lib' && t.status === 'pending')).toBe(true);
});

test('tasks that share a target each stay running, with their own logs', () => {
  const hunt = cand({ kind: 'review-codebase', repo: 'acme/web', target: 'codebase:2026-11-03', label: 'review codebase · acme/web' });
  const done = { kind: 'review-codebase' as const, outcome: 'issues-filed' as const, url: null, summary: 'filed', costUsd: 1, costEstimated: false, durationMs: 1, exhausted: false };
  const usage = { spentUsd: 1, tasksCompleted: 1, elapsedMs: 1, providerExhausted: false };
  const s = run([
    { type: 'plan', candidates: [hunt] },
    { type: 'task-start', candidate: hunt, index: 0 },
    { type: 'task-start', candidate: hunt, index: 1 },
    { type: 'log', candidate: hunt, index: 0, line: 'first hunt' },
    { type: 'log', candidate: hunt, index: 1, line: 'second hunt' },
    { type: 'task-done', candidate: hunt, index: 0, result: done, usage },
  ]);
  const running = rows(s).filter((t) => t.status === 'running');
  expect(running.map((t) => t.logs)).toEqual([['second hunt']]);
  expect(rows(s).filter((t) => t.status === 'done').map((t) => t.logs)).toEqual([['first hunt']]);
});
