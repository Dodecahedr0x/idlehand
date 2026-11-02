/**
 * Budget model shared by the CLI (which enforces it) and the server (which
 * displays what a node reported).
 *
 * A budget is always reduced to something the runner can measure per task:
 *   - dollars  : Claude Code reports `total_cost_usd` per headless run. Codex and
 *                the Cursor CLI report token usage, priced with a configurable table.
 *   - tasks    : number of completed agent tasks.
 *   - minutes  : wall-clock time.
 *   - remaining: no cap of our own; keep going until the provider refuses
 *                (rate limit / credits exhausted) or there is no more work.
 *
 * "percent" is sugar: `10%` of a subscription whose monthly value the user
 * declares in config (e.g. a $200/month plan) becomes a $20 dollar cap, measured
 * at the provider's list-price equivalent. We cannot read a subscription's live
 * quota from the CLIs, so this is the honest approximation.
 */
export type Budget =
  | { kind: 'usd'; limitUsd: number }
  | { kind: 'percent'; percent: number }
  | { kind: 'tasks'; limit: number }
  | { kind: 'minutes'; limit: number }
  | { kind: 'remaining' };

export interface BudgetUsage {
  spentUsd: number;
  /** Some tasks did not report final accounting; spentUsd is incomplete. */
  costUnknown?: boolean;
  tasksCompleted: number;
  elapsedMs: number;
  /** Set when the provider itself refused to continue (rate limit, no credits). */
  providerExhausted: boolean;
}

/** Keep missing accounting distinct from a measured zero. */
export function formatCost(costUsd: number, estimated: boolean, unknown = false, digits = 2): string {
  const reported = `${estimated ? '≈' : ''}$${costUsd.toFixed(digits)}`;
  return unknown ? `unknown (reported ${reported})` : reported;
}

export class BudgetParseError extends Error {}

/**
 * Parse a human budget string.
 *   "$10" | "10usd" | "10"      -> usd
 *   "10%"                        -> percent of declared subscription
 *   "3 tasks" | "3t"             -> tasks
 *   "45m" | "2h" | "90 minutes"  -> minutes
 *   "remaining" | "all" | "rest" -> remaining
 */
export function parseBudget(input: string): Budget {
  const s = input.trim().toLowerCase().replace(/,/g, '');
  if (!s) throw new BudgetParseError('empty budget');
  if (['remaining', 'all', 'rest', 'everything', 'unlimited'].includes(s)) return { kind: 'remaining' };

  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*%$/))) {
    const percent = Number(m[1]);
    if (percent <= 0 || percent > 100) throw new BudgetParseError(`percent out of range: ${input}`);
    return { kind: 'percent', percent };
  }
  if ((m = s.match(/^\$?\s*(\d+(?:\.\d+)?)\s*(usd|dollars?|\$)?$/))) {
    const limitUsd = Number(m[1]);
    if (!(limitUsd > 0)) throw new BudgetParseError(`dollar budget must be positive: ${input}`);
    return { kind: 'usd', limitUsd };
  }
  if ((m = s.match(/^(\d+)\s*(tasks?|t)$/))) {
    const limit = Number(m[1]);
    if (limit <= 0) throw new BudgetParseError(`task budget must be positive: ${input}`);
    return { kind: 'tasks', limit };
  }
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?)$/))) {
    return { kind: 'minutes', limit: Number(m[1]) };
  }
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?)$/))) {
    return { kind: 'minutes', limit: Number(m[1]) * 60 };
  }
  throw new BudgetParseError(
    `could not parse budget "${input}". Try "$10", "10%", "3 tasks", "45m" or "remaining".`,
  );
}

export function formatBudget(b: Budget, subscriptionMonthlyUsd?: number): string {
  switch (b.kind) {
    case 'usd':
      return `$${b.limitUsd.toFixed(2)}`;
    case 'percent': {
      const usd = percentToUsd(b, subscriptionMonthlyUsd);
      return usd == null ? `${b.percent}% of subscription` : `${b.percent}% of subscription (≈ $${usd.toFixed(2)})`;
    }
    case 'tasks':
      return `${b.limit} task${b.limit === 1 ? '' : 's'}`;
    case 'minutes':
      return b.limit >= 60 && b.limit % 60 === 0 ? `${b.limit / 60}h` : `${b.limit}m`;
    case 'remaining':
      return 'remaining credits';
  }
}

export function percentToUsd(b: { percent: number }, subscriptionMonthlyUsd?: number): number | null {
  if (subscriptionMonthlyUsd == null || !(subscriptionMonthlyUsd > 0)) return null;
  return (b.percent / 100) * subscriptionMonthlyUsd;
}

/** Dollar cap that applies, if any (used to pass `--max-budget-usd` to the provider). */
export function usdCap(b: Budget, subscriptionMonthlyUsd?: number): number | null {
  if (b.kind === 'usd') return b.limitUsd;
  if (b.kind === 'percent') return percentToUsd(b, subscriptionMonthlyUsd);
  return null;
}

export type BudgetVerdict =
  | { ok: true; remainingUsd: number | null; remainingTasks: number | null; remainingMs: number | null }
  | { ok: false; reason: string };

/** Decide whether another task may start under the budget. */
export function checkBudget(b: Budget, u: BudgetUsage, subscriptionMonthlyUsd?: number): BudgetVerdict {
  if (u.costUnknown) return { ok: false, reason: 'provider cost unavailable; stopped to avoid untracked spending' };
  if (u.providerExhausted) return { ok: false, reason: 'provider refused to continue (credits or rate limit exhausted)' };
  const cap = usdCap(b, subscriptionMonthlyUsd);
  const remainingUsd = cap == null ? null : cap - u.spentUsd;
  const remainingTasks = b.kind === 'tasks' ? b.limit - u.tasksCompleted : null;
  const remainingMs = b.kind === 'minutes' ? b.limit * 60_000 - u.elapsedMs : null;

  if (b.kind === 'percent' && cap == null) {
    return {
      ok: false,
      reason:
        'a percent budget needs the subscription value: run `idlehand config set subscription.monthlyUsd 200` (or whatever your plan is worth)',
    };
  }
  if (remainingUsd != null && remainingUsd <= 0) return { ok: false, reason: `spent $${u.spentUsd.toFixed(2)} of $${cap!.toFixed(2)}` };
  if (remainingTasks != null && remainingTasks <= 0) return { ok: false, reason: `completed ${u.tasksCompleted} task(s)` };
  if (remainingMs != null && remainingMs <= 0) return { ok: false, reason: `ran for ${Math.round(u.elapsedMs / 60000)} minute(s)` };
  return { ok: true, remainingUsd, remainingTasks, remainingMs };
}
