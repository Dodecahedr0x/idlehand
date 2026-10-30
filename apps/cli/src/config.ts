import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Provider } from '@idlehand/shared';
import { CONFIG_PATH } from './paths.ts';

export interface Config {
  server: { url: string; token: string | null; login: string | null };
  provider: Provider;
  /** Default budget string, e.g. "$5", "10%", "remaining". */
  budget: string;
  subscription: {
    /** What your plan is worth per month in list-price dollars; used for percent budgets. */
    monthlyUsd: number | null;
  };
  claude: {
    bin: string;
    model: string | null;
    permissionMode: 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
    allowedTools: string[];
    maxTurns: number;
  };
  codex: {
    bin: string;
    model: string | null;
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    /** Price table used to *estimate* Codex spend from token counts. */
    pricing: { inputPerM: number; cachedInputPerM: number; outputPerM: number };
  };
  /** Repos to work on when not using the server (or in addition). "owner/name". */
  repos: string[];
  policy: {
    /** Merge approved PRs when the GitHub account has push rights and checks are green. */
    merge: 'never' | 'when-authorized';
    mergeMethod: 'squash' | 'merge' | 'rebase';
    /** Only attempt issues carrying one of these labels (empty = any label). */
    issueLabels: string[];
    /** Never attempt issues carrying one of these labels. */
    skipIssueLabels: string[];
    /** Max issues filed per codebase review. */
    maxIssuesPerReview: number;
    /** Hours between codebase reviews of the same repo. */
    codebaseReviewIntervalHours: number;
    /** Comment on an issue when the agent concludes it is not a bug / needs info. */
    commentOnIssues: boolean;
    /** Per-command timeout for reproduction / test commands (seconds). */
    commandTimeoutSec: number;
    /** Hard cap on a single agent task (minutes). */
    taskTimeoutMin: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  server: { url: 'http://localhost:8787', token: null, login: null },
  provider: 'claude',
  budget: '$5',
  subscription: { monthlyUsd: null },
  claude: {
    bin: 'claude',
    model: null,
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent'],
    maxTurns: 120,
  },
  codex: {
    bin: 'codex',
    model: null,
    sandbox: 'workspace-write',
    // Estimate only. Adjust to your plan/model: `idlehand config set codex.pricing.outputPerM 10`.
    pricing: { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10 },
  },
  repos: [],
  policy: {
    merge: 'when-authorized',
    mergeMethod: 'squash',
    issueLabels: [],
    skipIssueLabels: ['question', 'discussion', 'wontfix', 'duplicate', 'invalid', 'needs-design', 'epic'],
    maxIssuesPerReview: 3,
    codebaseReviewIntervalHours: 72,
    commentOnIssues: false,
    commandTimeoutSec: 600,
    taskTimeoutMin: 45,
  },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return (patch === undefined ? base : (patch as T));
  if (base == null || typeof base !== 'object' || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export function loadConfig(path = CONFIG_PATH): Config {
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return deepMerge(structuredClone(DEFAULT_CONFIG), raw);
}

export function saveConfig(cfg: Config, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

/** Set a dotted key, coercing booleans/numbers/JSON arrays. */
export function setConfigValue(cfg: Config, dotted: string, value: string): Config {
  const keys = dotted.split('.');
  const next = structuredClone(cfg) as unknown as Record<string, unknown>;
  let cur: Record<string, unknown> = next;
  let ref: Record<string, unknown> = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (!(k in ref) || typeof ref[k] !== 'object') throw new Error(`unknown config key: ${dotted}`);
    ref = ref[k] as Record<string, unknown>;
    if (typeof cur[k] !== 'object' || cur[k] == null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (!(last in ref)) throw new Error(`unknown config key: ${dotted}`);
  cur[last] = coerce(value, ref[last]);
  return next as unknown as Config;
}

export function getConfigValue(cfg: Config, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), cfg);
}

function coerce(value: string, reference: unknown): unknown {
  const v = value.trim();
  if (v === 'null') return null;
  if (Array.isArray(reference)) {
    if (v.startsWith('[')) return JSON.parse(v);
    return v === '' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (typeof reference === 'number' || (reference === null && /^-?\d+(\.\d+)?$/.test(v))) {
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`expected a number, got "${value}"`);
    return n;
  }
  if (typeof reference === 'boolean') {
    if (!/^(true|false|1|0|yes|no)$/i.test(v)) throw new Error(`expected true/false, got "${value}"`);
    return /^(true|1|yes)$/i.test(v);
  }
  return v;
}

/** Hide secrets when printing. */
export function redactConfig(cfg: Config): Config {
  const c = structuredClone(cfg);
  if (c.server.token) c.server.token = c.server.token.slice(0, 6) + '…';
  return c;
}
