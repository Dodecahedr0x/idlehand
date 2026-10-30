/**
 * Discovers work and runs it under a budget.
 * Priority is fixed by the product brief: 1) review PRs, 2) work issues, 3) review the codebase.
 */
import { EventEmitter } from 'node:events';
import { checkBudget, usdCap, type Budget, type BudgetUsage, type BudgetVerdict, type RunReport, type TaskKind } from '@idlehand/shared';
import type { Config } from './config.ts';
import { currentLogin, listOpenIssues, listOpenPrs, repoInfo, type IssueSummary, type PrSummary, type RepoInfo } from './gh.ts';
import { providerBudgetError, type AgentProvider, type AgentRunResult } from './providers/index.ts';
import type { State } from './state.ts';
import { reviewPr } from './tasks/reviewPr.ts';
import { fixIssue } from './tasks/fixIssue.ts';
import { reviewCodebase } from './tasks/reviewCodebase.ts';
import type { Candidate, TaskResult } from './tasks/common.ts';
import { pruneWorktrees } from './workspace.ts';

export type SchedulerEvent =
  | { type: 'info'; message: string }
  | { type: 'plan'; candidates: Candidate[] }
  | { type: 'task-start'; candidate: Candidate; index: number }
  | { type: 'log'; candidate: Candidate; line: string }
  | { type: 'task-done'; candidate: Candidate; result: TaskResult; usage: BudgetUsage }
  | { type: 'task-skipped'; candidate: Candidate; reason: string }
  | { type: 'budget'; usage: BudgetUsage; verdict: BudgetVerdict }
  | { type: 'done'; reason: string; usage: BudgetUsage; reports: RunReport[] };

export interface SchedulerOptions {
  repos: string[];
  budget: Budget;
  cfg: Config;
  provider: AgentProvider;
  state: State;
  /** Restrict to some task kinds (default all). */
  only?: TaskKind[];
  dryRun?: boolean;
  /** Stop after the first task. */
  once?: boolean;
  report?: (r: RunReport) => Promise<void>;
}

export interface RepoScan {
  repo: string;
  info: RepoInfo;
  prs: PrSummary[];
  issues: IssueSummary[];
}

export const PRIORITY: TaskKind[] = ['review-pr', 'fix-issue', 'review-codebase'];

const ISSUE_BOOST = ['bug', 'good first issue', 'good-first-issue', 'help wanted', 'help-wanted', 'regression', 'crash'];

/** Pure: turn scans into an ordered candidate list. Exported for tests. */
export function planCandidates(scans: RepoScan[], opts: { login: string; cfg: Config; state: State; only?: TaskKind[]; now?: Date }): Candidate[] {
  const { login, cfg, state } = opts;
  const now = opts.now ?? new Date();
  const want = (k: TaskKind) => !opts.only || opts.only.includes(k);
  const out: Candidate[] = [];

  if (want('review-pr')) {
    const prs: Candidate[] = [];
    for (const s of scans) {
      if (s.info.archived) continue;
      for (const pr of s.prs) {
        if (pr.isDraft) continue;
        if (pr.author.login === login) continue; // cannot review your own PR
        if (pr.reviews.some((r) => r.author?.login === login)) continue;
        if (pr.labels.some((l) => /no-idlehand|no-bots?/i.test(l.name))) continue;
        if (state.seen(s.repo, 'review-pr', `pr:${pr.number}`, now)) continue;
        prs.push({ kind: 'review-pr', repo: s.repo, target: `pr:${pr.number}`, label: `review PR #${pr.number} · ${pr.title}`, pr });
      }
    }
    // Oldest open PR first: it has waited the longest.
    prs.sort((a, b) => (a.kind === 'review-pr' && b.kind === 'review-pr' ? a.pr.createdAt.localeCompare(b.pr.createdAt) : 0));
    out.push(...prs);
  }

  if (want('fix-issue')) {
    const issues: (Candidate & { score: number })[] = [];
    for (const s of scans) {
      if (s.info.archived) continue;
      const prBodies = s.prs.map((p) => p.title + ' ' + p.headRefName).join('\n');
      for (const issue of s.issues) {
        const labels = issue.labels.map((l) => l.name.toLowerCase());
        if (labels.some((l) => cfg.policy.skipIssueLabels.map((x) => x.toLowerCase()).includes(l))) continue;
        if (cfg.policy.issueLabels.length && !labels.some((l) => cfg.policy.issueLabels.map((x) => x.toLowerCase()).includes(l))) continue;
        if (issue.assignees.length && !issue.assignees.some((a) => a.login === login)) continue; // someone else owns it
        if (new RegExp(`(^|\\D)#${issue.number}(\\D|$)|issue-${issue.number}(\\D|$)`).test(prBodies)) continue; // a PR already references it
        if (state.seen(s.repo, 'fix-issue', `issue:${issue.number}`, now)) continue;
        const score = (labels.some((l) => ISSUE_BOOST.includes(l)) ? 1000 : 0) - Date.parse(issue.createdAt) / 1e10;
        issues.push({ kind: 'fix-issue', repo: s.repo, target: `issue:${issue.number}`, label: `fix issue #${issue.number} · ${issue.title}`, issue, score });
      }
    }
    issues.sort((a, b) => b.score - a.score);
    out.push(...issues.map(({ score: _s, ...c }) => c));
  }

  if (want('review-codebase')) {
    for (const s of scans) {
      if (s.info.archived) continue;
      const last = state.lastCodebaseReview(s.repo);
      if (last && now.getTime() - Date.parse(last.reviewed_at) < cfg.policy.codebaseReviewIntervalHours * 3_600_000) continue;
      const target = `codebase:${now.toISOString().slice(0, 10)}`;
      if (state.seen(s.repo, 'review-codebase', target, now)) continue;
      out.push({ kind: 'review-codebase', repo: s.repo, target, label: `review codebase · ${s.repo}` });
    }
  }
  return out;
}

export class Scheduler extends EventEmitter {
  private stopped = false;
  constructor(private opts: SchedulerOptions) { super(); }

  emitEvent(e: SchedulerEvent) { this.emit('event', e); }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.emitEvent({ type: 'info', message: 'stopping after the current task; no new tasks will start' });
  }

  async scan(): Promise<{ login: string; scans: RepoScan[] }> {
    const login = await currentLogin();
    const scans: RepoScan[] = [];
    for (const repo of this.opts.repos) {
      if (this.stopped) break;
      try {
        this.emitEvent({ type: 'info', message: `scanning ${repo}…` });
        const [info, prs, issues] = await Promise.all([repoInfo(repo), listOpenPrs(repo), listOpenIssues(repo)]);
        scans.push({ repo, info, prs, issues });
      } catch (e) {
        this.emitEvent({ type: 'info', message: `skipping ${repo}: ${(e as Error).message.split('\n')[0]}` });
      }
    }
    return { login, scans };
  }

  async run(): Promise<{ reports: RunReport[]; usage: BudgetUsage; reason: string }> {
    const { cfg, provider, state, budget } = this.opts;
    const startedAt = Date.now();
    const usage: BudgetUsage = { spentUsd: 0, tasksCompleted: 0, elapsedMs: 0, providerExhausted: false };
    const reports: RunReport[] = [];
    const sub = cfg.subscription.monthlyUsd ?? undefined;
    const finish = (reason: string) => { usage.elapsedMs = Date.now() - startedAt; this.emitEvent({ type: 'done', reason, usage, reports }); return { reports, usage, reason }; };

    const first = checkBudget(budget, usage, sub);
    this.emitEvent({ type: 'budget', usage, verdict: first });
    if (!first.ok) return finish(first.reason);
    const unsupportedBudget = providerBudgetError(provider, usdCap(budget, sub));
    if (!this.opts.dryRun && unsupportedBudget) return finish(unsupportedBudget);

    if (this.stopped) return finish('stopped by user');
    if (!this.opts.dryRun) {
      const reaped = state.reapRunning();
      if (reaped) this.emitEvent({ type: 'info', message: `marked ${reaped} interrupted task(s) from a previous run as failed` });
      for (const r of this.opts.repos) {
        if (this.stopped) return finish('stopped by user');
        await pruneWorktrees(r);
      }
    }

    const { login, scans } = await this.scan();
    if (this.stopped) return finish('stopped by user');
    const candidates = planCandidates(scans, { login, cfg, state, only: this.opts.only });
    this.emitEvent({ type: 'plan', candidates });
    if (candidates.length === 0) return finish('nothing to do: no unreviewed PRs, no open issues to attempt, codebases reviewed recently');
    if (this.opts.dryRun) return finish('dry run: nothing executed');

    const infoByRepo = new Map(scans.map((s) => [s.repo, s.info]));
    let index = 0;
    for (const c of candidates) {
      if (this.stopped) return finish('stopped by user');
      usage.elapsedMs = Date.now() - startedAt;
      const verdict = checkBudget(budget, usage, sub);
      this.emitEvent({ type: 'budget', usage, verdict });
      if (!verdict.ok) return finish(`budget reached: ${verdict.reason}`);

      // Hand the provider the smaller of: what is left, or nothing (unbounded kinds).
      const cap = usdCap(budget, sub);
      const perTaskCap = cap == null ? null : Math.max(0, cap - usage.spentUsd);
      this.emitEvent({ type: 'task-start', candidate: c, index: index++ });
      const taskId = state.startTask({ repo: c.repo, kind: c.kind, target: c.target, provider: provider.name });
      const log = (line: string) => this.emitEvent({ type: 'log', candidate: c, line });
      // Keep accounting even if verification or publishing throws after the agent ran.
      const accounting: { run?: AgentRunResult } = {};
      const trackedProvider: AgentProvider = {
        name: provider.name,
        supportsUsdBudget: provider.supportsUsdBudget,
        check: () => provider.check(),
        run: async (request) => { accounting.run = await provider.run(request); return accounting.run; },
      };
      const ctx = { repo: c.repo, info: infoByRepo.get(c.repo)!, login, cfg, provider: trackedProvider, state, log, maxBudgetUsd: perTaskCap };
      const started = new Date().toISOString();
      let result: TaskResult;
      try {
        result = c.kind === 'review-pr' ? await reviewPr(ctx, c.pr) : c.kind === 'fix-issue' ? await fixIssue(ctx, c.issue) : await reviewCodebase(ctx);
      } catch (e) {
        result = { kind: c.kind, outcome: 'failed', url: null, summary: (e as Error).message, costUsd: accounting.run?.costUsd ?? 0, costEstimated: accounting.run?.costEstimated ?? false, durationMs: Date.now() - Date.parse(started), exhausted: accounting.run?.exhausted ?? false };
        log(`error: ${(e as Error).message}`);
      }
      if (accounting.run?.costUnknown) {
        result.costUnknown = true;
        result.summary = `Provider spending is unknown; no further tasks will start. ${result.summary}`;
        usage.costUnknown = true;
      }
      state.finishTask(taskId, result);
      usage.spentUsd += result.costUsd;
      usage.tasksCompleted += 1;
      usage.providerExhausted ||= result.exhausted;
      usage.elapsedMs = Date.now() - startedAt;
      const [owner, name] = c.repo.split('/') as [string, string];
      const report: RunReport = {
        repo: { owner, name, fullName: c.repo }, kind: c.kind, provider: provider.name, outcome: result.outcome, url: result.url,
        summary: result.summary, costUsd: result.costUsd, costEstimated: result.costEstimated, costUnknown: result.costUnknown, durationMs: result.durationMs, startedAt: started,
      };
      reports.push(report);
      this.emitEvent({ type: 'task-done', candidate: c, result, usage });
      if (this.opts.report) await this.opts.report(report).catch((e) => this.emitEvent({ type: 'info', message: `could not report to server: ${(e as Error).message}` }));
      if (accounting.run?.costUnknown) return finish('provider cost unavailable; stopped to avoid untracked spending');
      if (this.stopped) return finish('stopped by user');
      if (this.opts.once) return finish('--once: stopped after one task');
    }
    usage.elapsedMs = Date.now() - startedAt;
    const last = checkBudget(budget, usage, sub);
    return finish(last.ok ? 'all available work done' : `budget reached: ${last.reason}`);
  }
}
