import type { Provider } from '@idlehand/shared';

export interface AgentRunRequest {
  cwd: string;
  prompt: string;
  /** JSON schema the final answer must satisfy. */
  schema: object;
  /** Dollar cap for this single run, if the budget has one. */
  maxBudgetUsd: number | null;
  timeoutMs: number;
  onLog: (line: string) => void;
}

export interface AgentRunResult {
  /** Parsed structured output, or null when the agent failed to produce one. */
  output: unknown | null;
  costUsd: number;
  costEstimated: boolean;
  durationMs: number;
  /** The provider refused to continue because credits / rate limits are exhausted. */
  exhausted: boolean;
  error: string | null;
  sessionId: string | null;
  rawTail: string;
}

export interface AgentProvider {
  readonly name: Provider;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
  /** Quick availability check for `idlehand doctor`. */
  check(): Promise<{ ok: boolean; detail: string }>;
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
