/**
 * Discovers work and runs it under a budget.
 * Priority is fixed by the product brief: 1) review PRs, 2) work issues, 3) review the codebase.
 */
import { EventEmitter } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { checkBudget, usdCap, type Budget, type BudgetUsage, type BudgetVerdict, type RunReport, type TaskKind } from '@idlehand/shared';
import type { Config } from './config.ts';
import { ciAllowsMerge, ciStatus, currentLogin, listOpenIssues, listOpenPrs, repoInfo, squashMarker, type IssueSummary, type PrSummary, type RepoInfo } from './gh.ts';
import { providerBudgetError, type AgentProvider, type AgentRunResult } from './providers/index.ts';
import { TASK_RETRY_DELAY_MS, parseCheckpoint, type State, type TaskCheckpoint } from './state.ts';
import { addressPrComments, closeFailedPr, hasActionableFeedback, reviewPr, squashReadyPr } from './tasks/reviewPr.ts';
import { fixIssue } from './tasks/fixIssue.ts';
import { reviewCodebase } from './tasks/reviewCodebase.ts';
import type { Candidate, TaskResult } from './tasks/common.ts';
import { isStopped } from './shell.ts';
import { pruneWorktrees } from './workspace.ts';

export type SchedulerEvent =
  | { type: 'info'; message: string }
  | { type: 'plan'; candidates: Candidate[] }
  | { type: 'task-start'; candidate: Candidate; index: number }
  | { type: 'log'; candidate: Candidate; index?: number; line: string }
  | { type: 'task-done'; candidate: Candidate; index?: number; result: TaskResult; usage: BudgetUsage }
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
  /** Tasks in flight at once. Each task has its own worktree. Default 4. */
  jobs?: number;
  /** Keep scanning until the budget is spent. No cooldowns, and author is ignored. */
  continuous?: boolean;
  /** Wait before scanning again when slots are free and the last scan found nothing. Default 15s. */
  pollMs?: number;
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
export function planCandidates(scans: RepoScan[], opts: { login: string; cfg: Config; state: State; only?: TaskKind[]; now?: Date; continuous?: boolean }): Candidate[] {
  const { login, cfg, state } = opts;
  const now = opts.now ?? new Date();
  const want = (k: TaskKind) => !opts.only || opts.only.includes(k);
  const retryDelayMs = opts.continuous ? 0 : TASK_RETRY_DELAY_MS;
  const handled = (repo: string, kind: TaskKind, target: string) => state.seen(repo, kind, target, now, retryDelayMs);
  const out: Candidate[] = [];

  let disposing = false;
  if (want('review-pr')) {
    const prs: Candidate[] = [];
    for (const s of scans) {
      if (s.info.archived) continue;
      for (const pr of s.prs) {
        if (pr.isDraft) continue;
        if (pr.labels.some((l) => /no-idlehand|no-bots?/i.test(l.name))) continue;
        const reviewed = pr.reviews.some((r) => r.author?.login === login);
        const canDispose = cfg.policy.merge === 'when-authorized' && !!s.info.permissions?.push;
        const ours = pr.author?.login === login || pr.headRefName.startsWith('idlehand/');
        const armed = pr.reviews.some((r) => r.author?.login === login && r.body?.includes(squashMarker(pr.headRefOid)));
        const ci = ciStatus(pr.statusCheckRollup);
        if (canDispose && armed && ci === 'red' && !handled(s.repo, 'review-pr', `close:${pr.number}:${pr.headRefOid}`)) {
          disposing = true;
          prs.push({ kind: 'review-pr', close: true, repo: s.repo, target: `close:${pr.number}:${pr.headRefOid}`, label: `close PR #${pr.number} · ${pr.title}`, pr });
          continue;
        }
        if (canDispose && armed && ciAllowsMerge(pr.statusCheckRollup) && !handled(s.repo, 'review-pr', `squash:${pr.number}:${pr.headRefOid}`)) {
          disposing = true;
          prs.push({ kind: 'review-pr', squash: true, repo: s.repo, target: `squash:${pr.number}:${pr.headRefOid}`, label: `squash PR #${pr.number} · ${pr.title}`, pr });
          continue;
        }
        if (armed && ci === 'pending') continue;
        const canUpdate = !!s.info.permissions?.push || pr.isCrossRepository;
        if (!pr.isDraft && ours && canUpdate && hasActionableFeedback(pr, login) && !handled(s.repo, 'review-pr', `address:${pr.number}:${pr.headRefOid}:${pr.updatedAt}`)) {
          disposing = true;
          prs.push({ kind: 'review-pr', address: true, repo: s.repo, target: `address:${pr.number}:${pr.headRefOid}:${pr.updatedAt}`, label: `address comments on PR #${pr.number} · ${pr.title}`, pr });
          continue;
        }
        if (reviewed) {
          if (canDispose && ours && !handled(s.repo, 'review-pr', `dispose:${pr.number}:${pr.headRefOid}`)) {
            disposing = true;
            prs.push({ kind: 'review-pr', repo: s.repo, target: `dispose:${pr.number}:${pr.headRefOid}`, label: `merge or close PR #${pr.number} · ${pr.title}`, pr });
          }
          continue;
        }
        if (!opts.continuous && pr.author?.login === login && !canDispose) continue;
        if (handled(s.repo, 'review-pr', `pr:${pr.number}`)) continue;
        if (canDispose) disposing = true;
        prs.push({ kind: 'review-pr', repo: s.repo, target: `pr:${pr.number}`, label: `review PR #${pr.number} · ${pr.title}`, pr });
      }
    }
    // Merge or close an open pull request before reviewing the next one.
    prs.sort((a, b) => {
      if (a.kind !== 'review-pr' || b.kind !== 'review-pr') return 0;
      const rank = (c: typeof a) => (c.squash || c.close ? 0 : c.address ? 1 : 2);
      return rank(a) - rank(b) || a.pr.createdAt.localeCompare(b.pr.createdAt);
    });
    out.push(...prs);
  }

  if (disposing) return out;

  if (want('fix-issue')) {
    const issues: (Candidate & { score: number })[] = [];
    for (const s of scans) {
      if (s.info.archived) continue;
      const prBodies = s.prs.map((p) => p.title + ' ' + p.headRefName).join('\n');
      for (const issue of s.issues) {
        const labels = issue.labels.map((l) => l.name.toLowerCase());
        if (labels.some((l) => cfg.policy.skipIssueLabels.map((x) => x.toLowerCase()).includes(l))) continue;
        if (cfg.policy.issueLabels.length && !labels.some((l) => cfg.policy.issueLabels.map((x) => x.toLowerCase()).includes(l))) continue;
        if (!opts.continuous && issue.assignees.length && !issue.assignees.some((a) => a.login === login)) continue;
        if (new RegExp(`(^|\\D)#${issue.number}(\\D|$)|issue-${issue.number}(\\D|$)`).test(prBodies)) continue; // a PR already references it
        if (handled(s.repo, 'fix-issue', `issue:${issue.number}`)) continue;
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
      if (!opts.continuous && last && now.getTime() - Date.parse(last.reviewed_at) < cfg.policy.codebaseReviewIntervalHours * 3_600_000) continue;
      const target = `codebase:${now.toISOString().slice(0, 10)}`;
      if (!opts.continuous && handled(s.repo, 'review-codebase', target)) continue;
      out.push({ kind: 'review-codebase', repo: s.repo, target, label: `review codebase · ${s.repo}` });
    }
  }
  return out;
}

interface ResumeItem {
  id: number;
  checkpoint: TaskCheckpoint;
  repo: string;
  kind: TaskKind;
  target: string;
}

function resumeCandidate(item: ResumeItem, scans: RepoScan[]): Candidate | null {
  const scan = scans.find((s) => s.repo === item.repo);
  if (!scan) return null;
  if (item.kind === 'fix-issue') {
    const issue = scan.issues.find((i) => i.number === Number(item.target.slice('issue:'.length)));
    return issue ? { kind: 'fix-issue', repo: item.repo, target: item.target, label: `resume issue #${issue.number} · ${issue.title}`, issue } : null;
  }
  if (item.kind === 'review-pr' && /^(pr|address):/.test(item.target)) {
    const number = Number(item.target.split(':')[1]);
    const pr = scan.prs.find((p) => p.number === number);
    if (!pr) return null;
    const address = item.target.startsWith('address:');
    return { kind: 'review-pr', repo: item.repo, target: item.target, label: `${address ? 'resume comments on' : 'resume'} PR #${pr.number} · ${pr.title}`, pr, ...(address ? { address: true } : {}) };
  }
  if (item.kind === 'review-codebase') return { kind: 'review-codebase', repo: item.repo, target: item.target, label: `resume codebase review · ${item.repo}` };
  return null;
}

export class Scheduler extends EventEmitter {
  private stopped = false;
  private abort = new AbortController();
  constructor(private opts: SchedulerOptions) { super(); }

  emitEvent(e: SchedulerEvent) { this.emit('event', e); }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.emitEvent({ type: 'info', message: 'stopping; in-progress tasks resume on the next run' });
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
    const pendingResume: ResumeItem[] = [];
    if (!this.opts.dryRun) {
      let abandoned = 0;
      for (const row of state.listRunning()) {
        if (!this.opts.repos.includes(row.repo)) continue;
        if (this.opts.only && !this.opts.only.includes(row.kind)) continue;
        const checkpoint = parseCheckpoint(row.checkpoint);
        if (checkpoint && existsSync(checkpoint.worktree)) {
          if (row.provider !== provider.name) delete checkpoint.sessionId;
          pendingResume.push({ id: row.id, checkpoint, repo: row.repo, kind: row.kind, target: row.target });
        } else {
          state.finishTask(row.id, { outcome: 'failed', url: null, summary: 'interrupted before its workspace was saved', costUsd: 0, costEstimated: true, costUnknown: true, durationMs: 0 });
          abandoned++;
        }
      }
      if (abandoned) this.emitEvent({ type: 'info', message: `marked ${abandoned} interrupted task(s) as failed; their workspace is gone` });
      for (const r of this.opts.repos) {
        if (this.stopped) return finish('stopped by user');
        await pruneWorktrees(r);
      }
    } else {
      const waiting = state.listRunning().filter((row) => this.opts.repos.includes(row.repo) && existsSync(parseCheckpoint(row.checkpoint)?.worktree ?? '')).length;
      if (waiting) this.emitEvent({ type: 'info', message: `${waiting} interrupted task(s) resume on the next real run` });
    }

    const jobs = this.opts.once ? 1 : Math.max(1, Math.floor(this.opts.jobs ?? 4));
    const pollMs = this.opts.pollMs ?? 15_000;
    let index = 0;
    let reason: string | null = null;
    const note = (next: string) => { reason ??= next; };
    const inFlight = new Set<Promise<void>>();

    const execute = async (c: Candidate, infoByRepo: Map<string, RepoInfo>, login: string, held?: ResumeItem) => {
      const cap = usdCap(budget, sub);
      const perTaskCap = cap == null ? null : Math.max(0, cap - usage.spentUsd);
      const taskIndex = index++;
      this.emitEvent({ type: 'task-start', candidate: c, index: taskIndex });
      const taskId = held?.id ?? state.startTask({ repo: c.repo, kind: c.kind, target: c.target, provider: provider.name });
      const checkpoint: TaskCheckpoint = { ...(held?.checkpoint ?? { worktree: '' }) };
      const persist = () => { if (checkpoint.worktree) state.saveCheckpoint(taskId, { worktree: checkpoint.worktree, ...(checkpoint.sessionId ? { sessionId: checkpoint.sessionId } : {}), ...(checkpoint.branch ? { branch: checkpoint.branch } : {}) }); };
      const log = (line: string) => this.emitEvent({ type: 'log', candidate: c, index: taskIndex, line });
      const accounting: { run?: AgentRunResult } = {};
      const trackedProvider: AgentProvider = {
        name: provider.name,
        supportsUsdBudget: provider.supportsUsdBudget,
        check: () => provider.check(),
        run: async (request) => {
          const { fresh, ...rest } = request;
          const result = await provider.run({
            ...rest,
            signal: this.abort.signal,
            resumeSessionId: fresh ? undefined : checkpoint.sessionId,
            onSession: fresh ? undefined : (id) => { if (checkpoint.sessionId === id) return; checkpoint.sessionId = id; persist(); },
          });
          const costUnknown = Boolean(accounting.run?.costUnknown || result.costUnknown);
          accounting.run = {
            ...result,
            costUsd: (accounting.run?.costUsd ?? 0) + result.costUsd,
            costEstimated: Boolean(accounting.run?.costEstimated || result.costEstimated),
            exhausted: Boolean(accounting.run?.exhausted || result.exhausted),
            costUnknown,
          };
          if (!fresh && result.sessionId && result.sessionId !== checkpoint.sessionId) { checkpoint.sessionId = result.sessionId; persist(); }
          return result;
        },
      };
      const ctx = {
        repo: c.repo, info: infoByRepo.get(c.repo)!, login, cfg, provider: trackedProvider, state, log, maxBudgetUsd: perTaskCap,
        resume: checkpoint.worktree ? checkpoint : undefined,
        saveWorkspace: (workspace: { worktree: string; branch?: string }) => { checkpoint.worktree = workspace.worktree; checkpoint.branch = workspace.branch; persist(); },
      };
      const started = new Date().toISOString();
      let result: TaskResult;
      try {
        if (held) log(`resuming ${c.label}`);
        result = c.kind === 'review-pr' ? await (c.close ? closeFailedPr(ctx, c.pr) : c.squash ? squashReadyPr(ctx, c.pr) : c.address ? addressPrComments(ctx, c.pr) : reviewPr(ctx, c.pr)) : c.kind === 'fix-issue' ? await fixIssue(ctx, c.issue) : await reviewCodebase(ctx);
      } catch (e) {
        if (isStopped(e)) { log('paused; the next run resumes this task'); return; }
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
      this.emitEvent({ type: 'task-done', candidate: c, index: taskIndex, result, usage });
      if (this.opts.report) await this.opts.report(report).catch((e) => this.emitEvent({ type: 'info', message: `could not report to server: ${(e as Error).message}` }));
      if (accounting.run?.costUnknown) note('provider cost unavailable; stopped to avoid untracked spending');
      else if (this.stopped) note('stopped by user');
      else if (this.opts.once) note('--once: stopped after one task');
    };

    // Free job slots scan again immediately. A scan that finds nothing waits, so an idle run does not hammer GitHub.
    const waitForWork = async () => {
      if (inFlight.size >= jobs) {
        await Promise.race(inFlight);
        return;
      }
      const waiting = inFlight.size;
      const deadline = Date.now() + pollMs;
      while (!this.stopped && !reason && inFlight.size === waiting && Date.now() < deadline) {
        await Bun.sleep(Math.max(1, Math.min(250, deadline - Date.now())));
      }
    };

    for (;;) {
      if (reason) break;
      if (this.stopped) { note('stopped by user'); break; }
      const { login, scans } = await this.scan();
      if (this.stopped) { note('stopped by user'); break; }
      const candidates = planCandidates(scans, { login, cfg, state, only: this.opts.only, continuous: this.opts.continuous });
      const prior = new Map<string, ResumeItem>();
      for (const item of pendingResume.splice(0)) {
        const candidate = resumeCandidate(item, scans);
        if (!candidate) {
          state.finishTask(item.id, { outcome: 'failed', url: null, summary: 'interrupted task can no longer be resumed', costUsd: 0, costEstimated: true, costUnknown: true, durationMs: 0 });
          rmSync(item.checkpoint.worktree, { recursive: true, force: true });
          continue;
        }
        prior.set(`${candidate.repo}\0${candidate.target}`, item);
      }
      const queue = [...prior.values()].map((item) => resumeCandidate(item, scans)!).concat(candidates.filter((c) => !prior.has(`${c.repo}\0${c.target}`)));
      this.emitEvent({ type: 'plan', candidates: queue });
      if (queue.length === 0) {
        if (this.opts.continuous && !this.opts.dryRun) {
          await waitForWork();
          continue;
        }
        note('nothing to do: no unreviewed PRs, no open issues to attempt, codebases reviewed recently');
        break;
      }
      if (this.opts.dryRun) { note('dry run: nothing executed'); break; }

      const infoByRepo = new Map(scans.map((s) => [s.repo, s.info]));
      for (const c of queue) {
        while (inFlight.size >= jobs) await Promise.race(inFlight);
        if (reason || this.stopped) { if (this.stopped) note('stopped by user'); break; }
        usage.elapsedMs = Date.now() - startedAt;
        const projected = budget.kind === 'tasks' ? { ...usage, tasksCompleted: usage.tasksCompleted + inFlight.size } : usage;
        const verdict = checkBudget(budget, projected, sub);
        this.emitEvent({ type: 'budget', usage, verdict });
        if (!verdict.ok) {
          const live = checkBudget(budget, usage, sub);
          note(`budget reached: ${live.ok ? `${usage.tasksCompleted + inFlight.size} task(s) already running or finished` : live.reason}`);
          break;
        }
        let tracked!: Promise<void>;
        tracked = execute(c, infoByRepo, login, prior.get(`${c.repo}\0${c.target}`)).finally(() => inFlight.delete(tracked));
        inFlight.add(tracked);
      }
      if (reason || this.stopped) { if (this.stopped) note('stopped by user'); break; }
      if (!this.opts.continuous) {
        await Promise.all(inFlight);
        usage.elapsedMs = Date.now() - startedAt;
        const last = checkBudget(budget, usage, sub);
        note(last.ok ? 'all available work done' : `budget reached: ${last.reason}`);
        break;
      }
      if (inFlight.size >= jobs) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    return finish(reason ?? 'stopped by user');
  }
}
