/**
 * Local checkouts. One base clone per repo under ~/.idlehand/repos/<owner>/<name>,
 * and a throwaway git worktree per task under ~/.idlehand/work/.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from './shell.ts';
import { REPOS_DIR, WORK_DIR } from './paths.ts';

export class GitError extends Error {}

async function git(args: string[], cwd?: string, timeoutMs = 300_000): Promise<string> {
  const r = await exec(['git', ...args], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } });
  if (r.code !== 0) throw new GitError(`git ${args.slice(0, 2).join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export function baseDir(repo: string): string {
  const [owner, name] = repo.split('/');
  return join(REPOS_DIR, owner!, name!);
}

/** Clone (first time) or fetch the base checkout. Returns its path. */
export async function ensureBase(repo: string, defaultBranch: string, log: (l: string) => void): Promise<string> {
  const dir = baseDir(repo);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    log(`cloning ${repo}…`);
    await git(['clone', '--quiet', `https://github.com/${repo}.git`, dir], undefined, 900_000);
  } else {
    log(`fetching ${repo}…`);
    await git(['fetch', '--quiet', '--prune', 'origin'], dir);
  }
  // Make sure the PR refs are fetchable.
  await git(['config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*'], dir).catch(() => {});
  await git(['fetch', '--quiet', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], dir);
  return dir;
}

export async function headSha(dir: string, ref = 'HEAD'): Promise<string> {
  return (await git(['rev-parse', ref], dir)).trim();
}

export interface Worktree {
  path: string;
  remove: () => Promise<void>;
}

/** Create a detached worktree at `ref`, optionally on a fresh branch. */
export async function makeWorktree(repo: string, base: string, ref: string, slug: string, branch?: string): Promise<Worktree> {
  mkdirSync(WORK_DIR, { recursive: true });
  const path = join(WORK_DIR, `${repo.replace('/', '-')}-${slug}-${Date.now().toString(36)}`);
  const args = ['worktree', 'add', '--quiet'];
  if (branch) args.push('-B', branch);
  else args.push('--detach');
  args.push(path, ref);
  await git(args, base);
  return {
    path,
    remove: async () => {
      await git(['worktree', 'remove', '--force', path], base).catch(() => {});
      rmSync(path, { recursive: true, force: true });
      if (branch) await git(['branch', '-D', branch], base).catch(() => {});
      await git(['worktree', 'prune'], base).catch(() => {});
    },
  };
}

/** Fetch a PR head into the base clone and return the ref name. */
export async function fetchPrRef(base: string, number: number): Promise<string> {
  await git(['fetch', '--quiet', 'origin', `+refs/pull/${number}/head:refs/remotes/origin/pr/${number}`], base);
  return `origin/pr/${number}`;
}

export async function hasChanges(dir: string): Promise<boolean> {
  const out = await git(['status', '--porcelain'], dir);
  return out.trim().length > 0;
}

export async function diffStat(dir: string, base: string): Promise<string> {
  return (await git(['diff', '--stat', base], dir)).trim();
}

/** Include new source and tests; Git's ignore rules exclude generated artifacts. */
export async function stageChanges(dir: string): Promise<void> {
  await git(['add', '-A'], dir);
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await stageChanges(dir);
  await git(['-c', 'user.name=idlehand', '-c', 'user.email=idlehand@users.noreply.github.com', 'commit', '--quiet', '-m', message], dir);
  return headSha(dir);
}

/** Push `branch` from `dir` to `https://github.com/<target>.git` using the gh token for this one push. */
export async function pushBranch(dir: string, target: string, branch: string, token: string): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${target}.git`;
  const r = await exec(['git', 'push', '--force-with-lease', '--quiet', url, `HEAD:refs/heads/${branch}`], { cwd: dir, timeoutMs: 300_000, env: { GIT_TERMINAL_PROMPT: '0' } });
  if (r.code !== 0) throw new GitError(`git push failed: ${r.stderr.replace(token, '***').trim()}`);
}

/** Drop any worktrees left behind by a crashed run. */
export async function pruneWorktrees(repo: string): Promise<void> {
  const base = baseDir(repo);
  if (!existsSync(base)) return;
  await git(['worktree', 'prune'], base).catch(() => {});
}
