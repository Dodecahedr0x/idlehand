import { describe, expect, test } from 'bun:test';
import { prDisposition } from './reviewPr.ts';

describe('prDisposition', () => {
  const base = { ours: true, canPush: true, merge: 'when-authorized' as const, wantsMerge: true, ci: 'green' as const, mergeable: 'MERGEABLE' as const, held: false };

  test('merges our pull request when it is safe and CI allows it', () => {
    expect(prDisposition(base)).toBe('merge');
    expect(prDisposition({ ...base, ci: 'none' })).toBe('merge');
  });

  test('waits for CI instead of closing a pull request that is otherwise safe', () => {
    expect(prDisposition({ ...base, ci: 'pending' })).toBe('wait');
  });

  test('closes our pull request when it is not safe or CI failed', () => {
    expect(prDisposition({ ...base, wantsMerge: false, ci: 'none' })).toBe('close');
    expect(prDisposition({ ...base, ci: 'red' })).toBe('close');
  });

  test('leaves someone else’s pull request open and respects merge never', () => {
    expect(prDisposition({ ...base, ours: false, wantsMerge: false })).toBe('leave');
    expect(prDisposition({ ...base, merge: 'never' })).toBe('leave');
    expect(prDisposition({ ...base, canPush: false })).toBe('leave');
    expect(prDisposition({ ...base, held: true })).toBe('leave');
  });
});
