/** Thin wrapper around the GitHub CLI (`gh`), which holds the user's auth. */
import { exec } from './shell.ts';

export class GhError extends Error {
  constructor(message: string, readonly code: number, readonly stderr: string) {
    super(message);
  }
}

export async function gh(args: string[], opts: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<string> {
  const r = await exec(['gh', ...args], { ...opts, timeoutMs: opts.timeoutMs ?? 120_000, env: { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' } });
  if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 3).join(' ')} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`, r.code, r.stderr);
  return r.stdout;
}

export async function ghJson<T>(args: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<T> {
  const out = await gh(args, opts);
  return JSON.parse(out || 'null') as T;
}

export interface PrSummary {
  number: number;
  title: string;
  author: { login: string };
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  reviews: { author: { login: string } | null; state: string; body?: string }[];
  /** Conversation comments. Inline review threads arrive on `reviews`. */
  comments?: { author: { login: string } | null; body: string }[];
  reviewDecision?: string;
  statusCheckRollup?: { name?: string; context?: string; state?: string; conclusion?: string; status?: string }[];
  labels: { name: string }[];
  additions: number;
  deletions: number;
  isCrossRepository: boolean;
}

export interface IssueSummary {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  labels: { name: string }[];
  assignees: { login: string }[];
  url: string;
  createdAt: string;
  updatedAt: string;
  comments: { totalCount: number };
  state: string;
}

export async function currentLogin(): Promise<string> {
  const out = await gh(['api', 'user', '--jq', '.login']);
  return out.trim();
}

/** Author identity for commits made by the logged-in GitHub user. */
export function githubCommitIdentity(user: { login: string; id: number; name: string | null }): { name: string; email: string } {
  return { name: user.name?.trim() || user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
}

export function currentGithubUser(): Promise<{ login: string; id: number; name: string | null }> {
  return ghJson(['api', 'user', '--jq', '{login:.login,id:.id,name:.name}']);
}

export interface RepoInfo {
  full_name: string;
  default_branch: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  permissions?: { admin: boolean; maintain?: boolean; push: boolean; triage?: boolean; pull: boolean };
  html_url: string;
  clone_url: string;
}

export function repoInfo(repo: string): Promise<RepoInfo> {
  return ghJson<RepoInfo>(['api', `repos/${repo}`]);
}

export function listOpenPrs(repo: string, limit = 50): Promise<PrSummary[]> {
  return ghJson<PrSummary[]>([
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json',
    'number,title,author,isDraft,headRefOid,headRefName,baseRefName,url,updatedAt,createdAt,reviews,comments,reviewDecision,statusCheckRollup,labels,additions,deletions,isCrossRepository',
  ]);
}

export function listOpenIssues(repo: string, limit = 100): Promise<IssueSummary[]> {
  return ghJson<IssueSummary[]>([
    'issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json',
    'number,title,body,author,labels,assignees,url,createdAt,updatedAt,comments,state',
  ]);
}

export async function issueBodies(repo: string, limit = 100): Promise<{ number: number; title: string; body: string }[]> {
  return ghJson([ 'issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', 'number,title,body' ]);
}

export async function prDiff(repo: string, number: number): Promise<string> {
  return gh(['pr', 'diff', String(number), '--repo', repo]);
}

export interface PrDetail {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  headRepositoryOwner: { login: string } | null;
  headRepository: { name: string } | null;
  url: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: string;
  statusCheckRollup: { name?: string; context?: string; state?: string; conclusion?: string; status?: string }[];
  files: { path: string; additions: number; deletions: number }[];
  commits: { messageHeadline: string }[];
  comments: { author: { login: string }; body: string }[];
  reviews?: { author: { login: string } | null; state?: string; body?: string }[];
}

export function prDetail(repo: string, number: number): Promise<PrDetail> {
  return ghJson<PrDetail>([
    'pr', 'view', String(number), '--repo', repo, '--json',
    'number,title,body,author,baseRefName,headRefName,headRefOid,headRepositoryOwner,headRepository,url,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,files,commits,comments,reviews',
  ]);
}

export interface ReviewComment { path: string; line: number; body: string }

/** Post a PR review. Tries inline comments first, falls back to body-only if GitHub rejects positions. */
export async function postPrReview(
  repo: string,
  number: number,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body: string,
  comments: ReviewComment[] = [],
): Promise<string> {
  const payload = { event, body, comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })) };
  try {
    const r = await ghJson<{ html_url: string }>(['api', `repos/${repo}/pulls/${number}/reviews`, '--method', 'POST', '--input', '-'], { stdin: JSON.stringify(payload) });
    return r.html_url;
  } catch (e) {
    if (comments.length === 0) throw e;
    const r = await ghJson<{ html_url: string }>(['api', `repos/${repo}/pulls/${number}/reviews`, '--method', 'POST', '--input', '-'], {
      stdin: JSON.stringify({ event, body: body + '\n\n' + comments.map((c) => `- \`${c.path}:${c.line}\` — ${c.body}`).join('\n') }),
    });
    return r.html_url;
  }
}

export type CheckRollup = { conclusion?: string | null; state?: string | null; status?: string | null };

/** none: no checks configured. green: every check finished successfully. pending: still running. red: a check failed. */
export function ciStatus(checks: CheckRollup[] | null | undefined): 'none' | 'green' | 'pending' | 'red' {
  if (!checks?.length) return 'none';
  const pending = checks.some((c) => {
    const status = (c.status ?? '').toUpperCase();
    const conclusion = (c.conclusion ?? c.state ?? '').toUpperCase();
    return ['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED'].includes(status) || (!conclusion && status !== 'COMPLETED');
  });
  if (pending) return 'pending';
  return checks.every((c) => /^(SUCCESS|NEUTRAL|SKIPPED)$/.test((c.conclusion ?? c.state ?? '').toUpperCase())) ? 'green' : 'red';
}

/** A pull request may merge when CI passed, or when the repo has no checks. */
export function ciAllowsMerge(checks: CheckRollup[] | null | undefined): boolean {
  const status = ciStatus(checks);
  return status === 'green' || status === 'none';
}

export const squashMarker = (sha: string) => `<!-- idlehand:squash:${sha} -->`;

/** Posted on a review that asks for a revision and leaves the pull request open. */
export const changesMarker = (sha: string) => `<!-- idlehand:changes:${sha} -->`;

export async function mergePr(repo: string, number: number, method: 'squash' | 'merge' | 'rebase'): Promise<void> {
  await gh(['pr', 'merge', String(number), '--repo', repo, `--${method}`]);
}

export async function closePr(repo: string, number: number, comment: string, opts?: { deleteBranch?: boolean }): Promise<void> {
  const args = ['pr', 'close', String(number), '--repo', repo, '--comment', comment];
  if (opts?.deleteBranch) args.push('--delete-branch');
  await gh(args);
}

/** An open pull request whose head branch is `branch`, including drafts and forks. */
export async function openPrForBranch(repo: string, branch: string): Promise<PrSummary | null> {
  const prs = await listOpenPrs(repo);
  return prs.find((pr) => pr.headRefName === branch) ?? null;
}

export async function editPr(repo: string, number: number, opts: { title: string; body: string }): Promise<void> {
  await gh(['pr', 'edit', String(number), '--repo', repo, '--title', opts.title, '--body', opts.body]);
}

export async function markPrReady(repo: string, number: number): Promise<void> {
  await gh(['pr', 'ready', String(number), '--repo', repo]);
}

export async function createIssue(repo: string, title: string, body: string, labels: string[] = []): Promise<string> {
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
  for (const l of labels) args.push('--label', l);
  const out = await gh(args);
  return out.trim().split('\n').pop()!.trim();
}

export async function ensureLabel(repo: string, name: string, color: string, description: string): Promise<boolean> {
  try {
    await gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', description, '--force']);
    return true;
  } catch {
    return false; // no permission; fine
  }
}

export async function commentOnIssue(repo: string, number: number, body: string): Promise<string> {
  const out = await gh(['issue', 'comment', String(number), '--repo', repo, '--body', body]);
  return out.trim();
}

export async function closeIssue(repo: string, number: number, comment: string): Promise<void> {
  await gh(['issue', 'close', String(number), '--repo', repo, '--reason', 'not planned', '--comment', comment]);
}

export async function createPr(repo: string, opts: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<string> {
  const args = ['pr', 'create', '--repo', repo, '--title', opts.title, '--body', opts.body, '--head', opts.head, '--base', opts.base];
  if (opts.draft) args.push('--draft');
  const out = await gh(args);
  return out.trim().split('\n').pop()!.trim();
}

export async function forkRepo(repo: string): Promise<string> {
  // Idempotent: gh prints the existing fork if present.
  await gh(['repo', 'fork', repo, '--clone=false'], { timeoutMs: 60_000 });
  const login = await currentLogin();
  return `${login}/${repo.split('/')[1]}`;
}

export async function authToken(): Promise<string> {
  return (await gh(['auth', 'token'])).trim();
}
