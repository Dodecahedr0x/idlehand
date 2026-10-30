/** Wire types between the web service and the CLI / browser. */

export interface Me {
  id: number;
  login: string;
  avatarUrl: string | null;
  name: string | null;
}

export interface RepoRef {
  owner: string;
  name: string;
  /** "owner/name" */
  fullName: string;
}

export interface RepoCard extends RepoRef {
  description: string | null;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string | null;
  language: string | null;
  stars: number;
  /** Whether the signed-in user has selected it. Only present on authed routes. */
  selected?: boolean;
  /** How many Idlehand users selected it. */
  selectedBy?: number;
}

export interface SelectedRepo extends RepoCard {
  selectedAt: string;
}

export interface PopularRepo extends RepoCard {
  selectedBy: number;
}

/* ---- CLI device-style login ---- */

export interface DeviceCodeStart {
  /** Opaque code the CLI polls with. */
  deviceCode: string;
  /** Short code the human types / sees on the approval page. */
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  /** Suggested poll interval in seconds. */
  interval: number;
}

export type DeviceCodePoll =
  | { status: 'pending' }
  | { status: 'approved'; token: string; login: string }
  | { status: 'expired' }
  | { status: 'denied' };

/* ---- Run reports (CLI -> server) ---- */

export type TaskKind = 'review-pr' | 'fix-issue' | 'review-codebase';
export type Provider = 'claude' | 'codex';

export type TaskOutcome =
  | 'reviewed' // a PR review was posted
  | 'merged' // PR reviewed and merged
  | 'pr-opened' // a fix PR was opened for an issue
  | 'issues-filed' // codebase review produced verified issues
  | 'nothing-found' // task ran, found nothing actionable
  | 'unverified' // agent claimed something the runner could not reproduce; discarded
  | 'failed'; // agent or tooling error

export interface RunReport {
  repo: RepoRef;
  kind: TaskKind;
  provider: Provider;
  outcome: TaskOutcome;
  /** PR / issue / review URL produced, if any. */
  url: string | null;
  summary: string;
  costUsd: number;
  /** True when costUsd is estimated from tokens rather than reported by the provider. */
  costEstimated: boolean;
  durationMs: number;
  startedAt: string;
}

export interface StoredRunReport extends RunReport {
  id: number;
  login: string;
}

export interface ApiError {
  error: string;
}
