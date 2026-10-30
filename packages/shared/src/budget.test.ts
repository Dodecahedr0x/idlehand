import { describe, expect, test } from 'bun:test';
import { checkBudget, formatBudget, parseBudget, usdCap } from './budget.ts';

describe('parseBudget', () => {
  test('dollars', () => {
    expect(parseBudget('$10')).toEqual({ kind: 'usd', limitUsd: 10 });
    expect(parseBudget('2.5 usd')).toEqual({ kind: 'usd', limitUsd: 2.5 });
    expect(parseBudget('7')).toEqual({ kind: 'usd', limitUsd: 7 });
  });
  test('percent', () => {
    expect(parseBudget('10%')).toEqual({ kind: 'percent', percent: 10 });
    expect(() => parseBudget('150%')).toThrow();
  });
  test('tasks', () => {
    expect(parseBudget('3 tasks')).toEqual({ kind: 'tasks', limit: 3 });
    expect(parseBudget('1t')).toEqual({ kind: 'tasks', limit: 1 });
  });
  test('time', () => {
    expect(parseBudget('45m')).toEqual({ kind: 'minutes', limit: 45 });
    expect(parseBudget('2h')).toEqual({ kind: 'minutes', limit: 120 });
  });
  test('remaining', () => {
    expect(parseBudget('remaining')).toEqual({ kind: 'remaining' });
    expect(parseBudget('ALL')).toEqual({ kind: 'remaining' });
  });
  test('garbage', () => {
    expect(() => parseBudget('lots')).toThrow(/could not parse/);
  });
});

describe('checkBudget', () => {
  const base = { spentUsd: 0, tasksCompleted: 0, elapsedMs: 0, providerExhausted: false };
  test('usd cap', () => {
    const b = parseBudget('$5');
    expect(checkBudget(b, { ...base, spentUsd: 4.99 }).ok).toBe(true);
    expect(checkBudget(b, { ...base, spentUsd: 5 }).ok).toBe(false);
  });
  test('percent needs subscription value', () => {
    const b = parseBudget('10%');
    expect(checkBudget(b, base).ok).toBe(false);
    expect(usdCap(b, 200)).toBe(20);
    expect(checkBudget(b, { ...base, spentUsd: 19 }, 200).ok).toBe(true);
    expect(checkBudget(b, { ...base, spentUsd: 20 }, 200).ok).toBe(false);
    expect(formatBudget(b, 200)).toContain('$20.00');
  });
  test('tasks and minutes', () => {
    expect(checkBudget(parseBudget('2 tasks'), { ...base, tasksCompleted: 2 }).ok).toBe(false);
    expect(checkBudget(parseBudget('2 tasks'), { ...base, tasksCompleted: 1 }).ok).toBe(true);
    expect(checkBudget(parseBudget('1m'), { ...base, elapsedMs: 60_001 }).ok).toBe(false);
  });
  test('remaining stops only when the provider refuses', () => {
    const b = parseBudget('remaining');
    expect(checkBudget(b, { ...base, spentUsd: 1e6, tasksCompleted: 1e6 }).ok).toBe(true);
    expect(checkBudget(b, { ...base, providerExhausted: true }).ok).toBe(false);
  });
});
