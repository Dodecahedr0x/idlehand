import { expect, test } from 'bun:test';
import { checkBudget, formatCost } from './budget.ts';

test('unknown accounting preserves reported amounts without presenting them as total spending', () => {
  expect(formatCost(0, true, true)).toBe('unknown (reported ≈$0.00)');
  expect(formatCost(1.25, true, true)).toBe('unknown (reported ≈$1.25)');
  expect(formatCost(1.25, true, false)).toBe('≈$1.25');
  expect(formatCost(0, false)).toBe('$0.00');
  expect(checkBudget({ kind: 'remaining' }, { spentUsd: 0, costUnknown: true, tasksCompleted: 1, elapsedMs: 0, providerExhausted: false })).toMatchObject({ ok: false });
});
