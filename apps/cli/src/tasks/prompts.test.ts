import { expect, test } from 'bun:test';
import type { IssueSummary, PrDetail } from '../gh.ts';
import { fixIssuePrompt, reviewPrPrompt } from './prompts.ts';

const issue = (over: Partial<IssueSummary> = {}): IssueSummary => ({
  number: 12,
  title: 'Crash on empty input',
  body: 'It crashes',
  author: { login: 'alice' },
  labels: [],
  assignees: [],
  url: 'https://github.com/o/r/issues/12',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  comments: { totalCount: 0 },
  state: 'OPEN',
  ...over,
});

const pr = (over: Partial<PrDetail> = {}): PrDetail => ({
  number: 4,
  title: 'Fix crash',
  body: '',
  author: { login: 'bob' },
  baseRefName: 'main',
  headRefName: 'fix',
  headRefOid: 'abc',
  headRepositoryOwner: { login: 'o' },
  headRepository: { name: 'r' },
  url: 'https://github.com/o/r/pull/4',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: '',
  statusCheckRollup: [],
  files: [],
  commits: [],
  comments: [],
  ...over,
});

test('fixIssuePrompt treats a missing issue author as ghost', () => {
  const prompt = fixIssuePrompt('o/r', 'main', issue({ author: null as never }), 'idlehand/issue-12');
  expect(prompt).toContain('Opened by @ghost on 2026-01-01');
});

test('reviewPrPrompt treats a missing pull request author as ghost', () => {
  const prompt = reviewPrPrompt('o/r', pr({ author: null as never }), '', false);
  expect(prompt).toContain('PR #4: Fix crash by @ghost (`fix` → `main`)');
});
