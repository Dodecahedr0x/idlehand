import type { TaskKind, TaskOutcome } from '@idlehand/shared';
import type { Config } from '../config.ts';
import type { IssueSummary, PrSummary, RepoInfo } from '../gh.ts';
import type { AgentProvider } from '../providers/index.ts';
import type { State } from '../state.ts';

export interface TaskContext {
  repo: string;
  info: RepoInfo;
  /** GitHub login of the gh user running this node. */
  login: string;
  cfg: Config;
  provider: AgentProvider;
  state: State;
  log: (line: string) => void;
  /** Estimated-spend stopping threshold for the provider (null = none). */
  maxBudgetUsd: number | null;
}

export type Candidate =
  | { kind: 'review-pr'; repo: string; target: string; label: string; pr: PrSummary }
  | { kind: 'fix-issue'; repo: string; target: string; label: string; issue: IssueSummary }
  | { kind: 'review-codebase'; repo: string; target: string; label: string };

export interface TaskResult {
  kind: TaskKind;
  outcome: TaskOutcome;
  url: string | null;
  summary: string;
  costUsd: number;
  costEstimated: boolean;
  costUnknown?: boolean;
  durationMs: number;
  exhausted: boolean;
}

export const FOOTER = (what: string) =>
  `\n\n---\n<sub>${what} by [Idlehand](https://github.com/idlehand) — a human's spare Claude Code / Codex credits, pointed at this repo. Every claim above was re-verified by the runner, not just the model. Reply to this thread if it is wrong; a maintainer can label the repo \`no-idlehand\` to opt out.</sub>`;

export const MARKER = (kind: string, target: string) => `<!-- idlehand:${kind}:${target} -->`;

export function fmtCmd(cmd: string) {
  return '```sh\n' + cmd + '\n```';
}
export function fmtOut(out: string) {
  const t = out.trim();
  return '```\n' + (t.length > 2500 ? '…' + t.slice(-2500) : t || '(no output)') + '\n```';
}
