/** Non-interactive renderers for the scheduler: human-readable lines or JSONL. */
import { formatBudget, formatCost, type Budget } from '@idlehand/shared';
import type { Scheduler, SchedulerEvent } from '../scheduler.ts';

const ICON: Record<string, string> = {
  reviewed: '✓', merged: '✓', 'pr-opened': '✓', 'issues-filed': '✓', 'nothing-found': '·', unverified: '✗', failed: '!',
};

export function attachPlain(s: Scheduler, budget: Budget, subscriptionUsd?: number): void {
  const w = (l: string) => process.stdout.write(l + '\n');
  let estimated = false;
  w(`idlehand · budget ${formatBudget(budget, subscriptionUsd)}`);
  s.on('event', (e: SchedulerEvent) => {
    switch (e.type) {
      case 'info': w(`  ${e.message}`); break;
      case 'plan':
        w(`plan: ${e.candidates.length} task(s)`);
        e.candidates.forEach((c, i) => w(`  ${String(i + 1).padStart(2)}. [${c.kind}] ${c.repo} — ${c.label}`));
        break;
      case 'task-start': w(`\n▶ ${e.candidate.repo} — ${e.candidate.label}`); break;
      case 'log': w(`    ${e.candidate.target}  ${e.line}`); break;
      case 'task-done': {
        estimated ||= e.result.costEstimated;
        const cost = formatCost(e.result.costUsd, e.result.costEstimated, e.result.costUnknown, 3);
        w(`${ICON[e.result.outcome] ?? '·'} ${e.result.outcome} (${cost}, ${Math.round(e.result.durationMs / 1000)}s)${e.result.url ? ` ${e.result.url}` : ''}`);
        if (e.result.outcome === 'failed' || e.result.outcome === 'unverified') w(`    ${e.result.summary.split('\n')[0]}`);
        break;
      }
      case 'budget': if (!e.verdict.ok) w(`budget: ${e.verdict.reason}`); break;
      case 'done':
        w(`\ndone: ${e.reason}`);
        w(`spent ${formatCost(e.usage.spentUsd, estimated, e.usage.costUnknown, 3)} over ${e.usage.tasksCompleted} task(s) in ${Math.round(e.usage.elapsedMs / 1000)}s`);
        break;
    }
  });
}

export function attachJson(s: Scheduler): void {
  s.on('event', (e: SchedulerEvent) => {
    // Strip heavy nested objects so each line stays small and stable.
    const slim: Record<string, unknown> = { ts: new Date().toISOString(), type: e.type };
    if ('candidate' in e) slim.task = { kind: e.candidate.kind, repo: e.candidate.repo, target: e.candidate.target, label: e.candidate.label };
    if (e.type === 'plan') slim.tasks = e.candidates.map((c) => ({ kind: c.kind, repo: c.repo, target: c.target, label: c.label }));
    if (e.type === 'log') slim.line = e.line;
    if (e.type === 'info') slim.message = e.message;
    if (e.type === 'task-done') { slim.result = e.result; slim.usage = e.usage; }
    if (e.type === 'budget') { slim.usage = e.usage; slim.verdict = e.verdict; }
    if (e.type === 'done') { slim.reason = e.reason; slim.usage = e.usage; slim.reports = e.reports; }
    if (e.type === 'task-start') slim.index = e.index;
    process.stdout.write(JSON.stringify(slim) + '\n');
  });
}
