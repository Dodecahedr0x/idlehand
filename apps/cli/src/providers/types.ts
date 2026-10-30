import type { Provider } from '@idlehand/shared';

export interface AgentRunRequest {
  cwd: string;
  prompt: string;
  /** JSON schema the final answer must satisfy. */
  schema: object;
  /** Provider dollar stopping threshold; null explicitly permits uncapped spend. */
  maxBudgetUsd: number | null;
  timeoutMs: number;
  onLog: (line: string) => void;
}

export interface AgentRunResult {
  /** Parsed structured output, or null when the agent failed to produce one. */
  output: unknown | null;
  costUsd: number;
  costEstimated: boolean;
  /** The process ran but did not report usable final accounting. Stop further tasks. */
  costUnknown?: boolean;
  durationMs: number;
  /** The provider refused to continue because credits / rate limits are exhausted. */
  exhausted: boolean;
  error: string | null;
  sessionId: string | null;
  rawTail: string;
}

export interface AgentProvider {
  readonly name: Provider;
  /** False when the provider cannot enforce a dollar stopping threshold. */
  readonly supportsUsdBudget?: boolean;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
  /** Quick availability check for `idlehand doctor`. */
  check(): Promise<{ ok: boolean; detail: string }>;
}

export function providerBudgetError(provider: AgentProvider, cap: number | null): string | null {
  if (cap == null) return null;
  if (!Number.isFinite(cap) || cap <= 0) return 'dollar budget must be a positive finite number';
  return provider.supportsUsdBudget === false
    ? 'Codex cannot enforce dollar or percent budgets. Use --provider claude, or explicitly choose --budget "3 tasks", "45m", or "remaining" (no dollar cap).'
    : null;
}

export function refusedRun(error: string): AgentRunResult {
  return { output: null, costUsd: 0, costEstimated: false, durationMs: 0, exhausted: false, error, sessionId: null, rawTail: '' };
}

export const EXHAUSTED_RE =
  /rate.?limit|usage limit|out of (credits|tokens|quota)|insufficient[_ ](credits|quota|funds)|credit balance|quota exceeded|billing|exceeded your current quota|too many requests|429|limit reached|reached your (usage|monthly|weekly)/i;

/** Pull JSON out of a model's final message even when wrapped in fences or prose. */
export function extractJson(text: string): unknown | null {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]!); } catch {} }
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch {} }
  return null;
}
