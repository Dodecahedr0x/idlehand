import { describe, expect, test } from 'bun:test';
import { fixIssuePrompt, reviewPrPrompt } from './prompts.ts';
import type { IssueSummary, PrDetail } from '../gh.ts';

const issue = { number: 7, title: 'Offer an installer', body: 'Add a one-line install.', author: { login: 'x' }, labels: [], assignees: [], url: '', createdAt: '', updatedAt: '', comments: { totalCount: 0 }, state: 'OPEN' } satisfies IssueSummary;

describe('fixer prompt', () => {
  test('refuses a pull request unless a current defect was reproduced', () => {
    const prompt = fixIssuePrompt('o/r', 'main', issue, 'idlehand/issue-7');
    expect(prompt).toContain('Do not return status "fixed"');
    expect(prompt).toContain('feature request');
    expect(prompt).toContain('documentation, packaging, an installer, deployment, or a workflow');
    expect(prompt).toContain('files unrelated to the defect');
    expect(prompt).toContain('draft pull request already reserves this issue');
    expect(prompt).toContain('.github/idlehand-claim');
  });
});

describe('review prompt', () => {
  test('refuses to merge a pull request that is not a verified defect fix', () => {
    const pr = { number: 1, title: 'Add installer', body: '', author: { login: 'x' }, baseRefName: 'main', headRefName: 'feat', headRefOid: 'abc', headRepositoryOwner: null, headRepository: null, url: '', mergeable: 'MERGEABLE', mergeStateStatus: '', reviewDecision: '', statusCheckRollup: [], files: [], commits: [], comments: [] } satisfies PrDetail;
    const prompt = reviewPrPrompt('o/r', pr, '', true);
    expect(prompt).toContain('safeToMerge');
    expect(prompt).toContain('feature');
    expect(prompt).toContain('unrelated refactor');
  });
});
