import { describe, expect, test } from 'bun:test';
import { hasActionableFeedback, prDisposition } from './reviewPr.ts';

describe('prDisposition', () => {
  const base = { ours: true, canPush: true, merge: 'when-authorized' as const, wantsMerge: true, ci: 'green' as const, mergeable: 'MERGEABLE' as const, held: false, badOrDangerous: false };

  test('merges our pull request when it is safe and CI allows it', () => {
    expect(prDisposition(base)).toBe('merge');
    expect(prDisposition({ ...base, ci: 'none' })).toBe('merge');
  });

  test('waits for CI instead of closing a pull request that is otherwise safe', () => {
    expect(prDisposition({ ...base, ci: 'pending' })).toBe('wait');
  });

  test('leaves our pull request open when it is only a bit off', () => {
    expect(prDisposition({ ...base, wantsMerge: false, ci: 'none' })).toBe('leave');
    expect(prDisposition({ ...base, wantsMerge: false, ci: 'red' })).toBe('leave');
  });

  test('closes our pull request when the solution is bad or dangerous, or CI failed on a merge', () => {
    expect(prDisposition({ ...base, wantsMerge: false, badOrDangerous: true, ci: 'none' })).toBe('close');
    expect(prDisposition({ ...base, ci: 'red' })).toBe('close');
  });

  test('leaves someone else’s pull request open and respects merge never', () => {
    expect(prDisposition({ ...base, ours: false, wantsMerge: false, badOrDangerous: true })).toBe('leave');
    expect(prDisposition({ ...base, merge: 'never', badOrDangerous: true })).toBe('leave');
    expect(prDisposition({ ...base, canPush: false })).toBe('leave');
    expect(prDisposition({ ...base, held: true, badOrDangerous: true })).toBe('leave');
  });
});

describe('hasActionableFeedback', () => {
  const pr = { headRefOid: 'abc', reviews: [] as { author: { login: string } | null; state: string; body?: string }[] };

  test('notices a change request, another person’s comment, or our own revision marker', () => {
    expect(hasActionableFeedback(pr, 'me')).toBe(false);
    expect(hasActionableFeedback({ ...pr, reviewDecision: 'CHANGES_REQUESTED' }, 'me')).toBe(true);
    expect(hasActionableFeedback({ ...pr, reviews: [{ author: { login: 'pat' }, state: 'COMMENTED', body: 'rename this' }] }, 'me')).toBe(true);
    expect(hasActionableFeedback({ ...pr, reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: '<!-- idlehand:changes:abc -->\nplease add a test' }] }, 'me')).toBe(true);
    expect(hasActionableFeedback({ ...pr, comments: [{ author: { login: 'pat' }, body: 'this still fails' }] }, 'me')).toBe(true);
  });

  test('ignores our own approval comment and an empty note', () => {
    expect(hasActionableFeedback({ ...pr, reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: 'looks good' }] }, 'me')).toBe(false);
    expect(hasActionableFeedback({ ...pr, comments: [{ author: { login: 'me' }, body: 'pushed a fix' }] }, 'me')).toBe(false);
  });
});
