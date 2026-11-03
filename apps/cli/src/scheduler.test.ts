import { describe, expect, test } from 'bun:test';
import { planCandidates, type RepoScan } from './scheduler.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { State, TASK_RETRY_DELAY_MS } from './state.ts';
import type { IssueSummary, PrSummary, RepoInfo } from './gh.ts';

const info = (over: Partial<RepoInfo> = {}): RepoInfo => ({ full_name: 'o/r', default_branch: 'main', private: false, fork: false, archived: false, html_url: '', clone_url: '', permissions: { admin: false, push: false, pull: true }, ...over });
const pr = (n: number, over: Partial<PrSummary> = {}): PrSummary => ({ number: n, title: `PR ${n}`, author: { login: 'someone' }, isDraft: false, headRefOid: 'abc', headRefName: `feat-${n}`, baseRefName: 'main', url: '', updatedAt: '2026-01-01T00:00:00Z', createdAt: `2026-01-0${n}T00:00:00Z`, reviews: [], labels: [], additions: 1, deletions: 1, isCrossRepository: false, ...over });
const issue = (n: number, over: Partial<IssueSummary> = {}): IssueSummary => ({ number: n, title: `Issue ${n}`, body: '', author: { login: 'x' }, labels: [], assignees: [], url: '', createdAt: `2026-01-0${n}T00:00:00Z`, updatedAt: '', comments: { totalCount: 0 }, state: 'OPEN', ...over });

describe('planCandidates', () => {
  const base = () => ({ login: 'me', cfg: structuredClone(DEFAULT_CONFIG), state: new State(':memory:') });

  test('priority: PRs, then issues, then codebase; oldest PR first', () => {
    const scans: RepoScan[] = [{ repo: 'o/r', info: info(), prs: [pr(3), pr(1)], issues: [issue(5)] }];
    const plan = planCandidates(scans, base());
    expect(plan.map((c) => c.kind)).toEqual(['review-pr', 'review-pr', 'fix-issue', 'review-codebase']);
    expect(plan.map((c) => c.target)).toEqual(['pr:1', 'pr:3', 'issue:5', expect.stringMatching(/^codebase:/)]);
  });

  test('open pull requests are merged or closed before any other work when the account can push', () => {
    const scans: RepoScan[] = [{
      repo: 'o/r',
      info: info({ permissions: { admin: false, push: true, pull: true } }),
      prs: [
        pr(1, { author: { login: 'me' } }),
        pr(2, { author: { login: 'me' }, headRefOid: 'def', reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: 'needs work' }] }),
        pr(3, { headRefOid: 'abc', reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: '<!-- idlehand:squash:abc -->' }], statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }),
        pr(4, { headRefOid: 'red', reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: '<!-- idlehand:squash:red -->' }], statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }] }),
      ],
      issues: [issue(9)],
    }];
    const plan = planCandidates(scans, base());
    expect(plan.map((c) => c.target)).toEqual(['squash:3:abc', 'close:4:red', 'pr:1', 'dispose:2:def']);
    expect(plan.every((c) => c.kind === 'review-pr')).toBe(true);
  });

  test('a pull request waiting on CI does not block issues', () => {
    const scans: RepoScan[] = [{
      repo: 'o/r',
      info: info({ permissions: { admin: false, push: true, pull: true } }),
      prs: [pr(1, { headRefOid: 'abc', reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: '<!-- idlehand:squash:abc -->' }], statusCheckRollup: [{ status: 'IN_PROGRESS' }] })],
      issues: [issue(2)],
    }];
    const plan = planCandidates(scans, { ...base(), only: ['review-pr', 'fix-issue'] });
    expect(plan.map((c) => c.target)).toEqual(['issue:2']);
  });

  test('squashes a reviewed pull request when push is authorized and CI is green', () => {
    const scans: RepoScan[] = [{ repo: 'o/r', info: info({ permissions: { admin: false, push: true, pull: true } }), prs: [
      pr(1, { headRefOid: 'abc', reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: '<!-- idlehand:squash:abc -->' }], statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }),
      pr(2, { headRefOid: 'def', reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: '<!-- idlehand:squash:def -->' }], statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }] }),
      pr(3, { headRefOid: 'ghi', reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: '<!-- idlehand:squash:ghi -->' }], statusCheckRollup: [{ status: 'IN_PROGRESS' }] }),
      pr(4),
    ], issues: [] }];
    const plan = planCandidates(scans, { ...base(), only: ['review-pr'] });
    expect(plan.map((c) => c.target)).toEqual(['squash:1:abc', 'close:2:def', 'pr:4']);
    expect(plan[0]).toMatchObject({ squash: true });
  });

  test('does not squash without push rights, a review marker, or merge authorization', () => {
    const ready = pr(1, { headRefOid: 'abc', reviews: [{ author: { login: 'me' }, state: 'COMMENTED', body: '<!-- idlehand:squash:abc -->' }], statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] });
    const scans = (over: Partial<RepoInfo> = {}): RepoScan[] => [{ repo: 'o/r', info: info(over), prs: [ready], issues: [] }];
    expect(planCandidates(scans(), { ...base(), only: ['review-pr'] })).toEqual([]);
    const b = base();
    b.cfg.policy.merge = 'never';
    expect(planCandidates(scans({ permissions: { admin: false, push: true, pull: true } }), { ...b, only: ['review-pr'] })).toEqual([]);
    expect(planCandidates([{ repo: 'o/r', info: info({ permissions: { admin: false, push: true, pull: true } }), prs: [pr(1, { statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] })], issues: [] }], { ...base(), only: ['review-pr'] }).map((c) => c.target)).toEqual(['pr:1']);
  });

  test('skips own, draft, already-reviewed and opted-out PRs', () => {
    const scans: RepoScan[] = [{ repo: 'o/r', info: info(), prs: [
      pr(1, { author: { login: 'me' } }),
      pr(2, { isDraft: true }),
      pr(3, { reviews: [{ author: { login: 'me' }, state: 'COMMENTED' }] }),
      pr(4, { labels: [{ name: 'no-idlehand' }] }),
      pr(5),
    ], issues: [] }];
    const plan = planCandidates(scans, { ...base(), only: ['review-pr'] });
    expect(plan.map((c) => c.target)).toEqual(['pr:5']);
  });

  test('a draft claim branch reserves its issue and is not reviewed', () => {
    const scans: RepoScan[] = [{
      repo: 'o/r',
      info: info(),
      prs: [pr(9, { isDraft: true, title: 'Working on an issue', headRefName: 'idlehand/issue-3' })],
      issues: [issue(3), issue(4)],
    }];
    expect(planCandidates(scans, { ...base(), only: ['review-pr', 'fix-issue'] }).map((c) => c.target)).toEqual(['issue:4']);
  });

  test('skips issues that are assigned to others, labelled skip, referenced by a PR, or already attempted; boosts bug labels', () => {
    const b = base();
    b.state.startTask({ repo: 'o/r', kind: 'fix-issue', target: 'issue:4', provider: 'claude' });
    const scans: RepoScan[] = [{ repo: 'o/r', info: info(), prs: [pr(9, { title: 'Fixes #3' })], issues: [
      issue(1, { assignees: [{ login: 'other' }] }),
      issue(2, { labels: [{ name: 'question' }] }),
      issue(3),
      issue(4),
      issue(5),
      issue(6, { labels: [{ name: 'bug' }] }),
    ] }];
    const plan = planCandidates(scans, { ...b, only: ['fix-issue'] });
    expect(plan.map((c) => c.target)).toEqual(['issue:6', 'issue:5']);
  });

  test('issueLabels filter restricts to matching labels', () => {
    const b = base();
    b.cfg.policy.issueLabels = ['help wanted'];
    const scans: RepoScan[] = [{ repo: 'o/r', info: info(), prs: [], issues: [issue(1), issue(2, { labels: [{ name: 'Help Wanted' }] })] }];
    expect(planCandidates(scans, { ...b, only: ['fix-issue'] }).map((c) => c.target)).toEqual(['issue:2']);
  });

  test('codebase review respects the interval and archived repos', () => {
    const b = base();
    b.state.markCodebaseReview('o/r', 'abc');
    const scans: RepoScan[] = [
      { repo: 'o/r', info: info(), prs: [], issues: [] },
      { repo: 'o/arch', info: info({ archived: true }), prs: [pr(1)], issues: [issue(1)] },
      { repo: 'o/fresh', info: info(), prs: [], issues: [] },
    ];
    const plan = planCandidates(scans, b);
    expect(plan.map((c) => c.repo)).toEqual(['o/fresh']);
    const later = new Date(Date.now() + 100 * 3_600_000);
    expect(planCandidates(scans, { ...b, now: later }).map((c) => c.repo)).toEqual(['o/r', 'o/fresh']);
  });

  test('continuous mode does not wait on author, assignment, review interval, or a failed attempt', () => {
    const b = base();
    b.state.markCodebaseReview('o/r', 'abc');
    const today = `codebase:${new Date().toISOString().slice(0, 10)}`;
    const reviewed = b.state.startTask({ repo: 'o/r', kind: 'review-codebase', target: today, provider: 'claude' });
    b.state.finishTask(reviewed, { outcome: 'nothing-found', url: null, summary: 'done', costUsd: 0, costEstimated: false, durationMs: 1 });
    const failed = b.state.startTask({ repo: 'o/r', kind: 'fix-issue', target: 'issue:8', provider: 'claude' });
    b.state.finishTask(failed, { outcome: 'failed', url: null, summary: 'failed', costUsd: 0, costEstimated: false, durationMs: 1 });
    const scans: RepoScan[] = [{ repo: 'o/r', info: info(), prs: [pr(1, { author: { login: 'me' } })], issues: [issue(2, { assignees: [{ login: 'other' }] }), issue(8)] }];
    const plan = planCandidates(scans, { ...b, continuous: true });
    expect(plan.map((c) => c.target)).toEqual(['pr:1', 'issue:2', 'issue:8', today]);
    b.state.close();
  });

  test('failed work becomes eligible after cooling down while completed work stays skipped', () => {
    const b = base();
    try {
      const scans: RepoScan[] = [{ repo: 'o/r', info: info(), prs: [pr(1)], issues: [issue(2), issue(3)] }];
      for (const [kind, target, outcome] of [['review-pr', 'pr:1', 'failed'], ['fix-issue', 'issue:2', 'failed'], ['fix-issue', 'issue:3', 'pr-opened']] as const) {
        const id = b.state.startTask({ repo: 'o/r', kind, target, provider: 'claude' });
        b.state.finishTask(id, { outcome, url: null, summary: outcome, costUsd: 0.1, costEstimated: false, durationMs: 1 });
      }
      const only = ['review-pr', 'fix-issue'] as const;
      expect(planCandidates(scans, { ...b, only: [...only] })).toEqual([]);
      expect(planCandidates(scans, { ...b, only: [...only], now: new Date(Date.now() + TASK_RETRY_DELAY_MS + 1000) }).map((c) => c.target)).toEqual(['pr:1', 'issue:2']);
    } finally {
      b.state.close();
    }
  });
});
