/** GitHub CLI sign-in and remote parsing. Setup runs this; callers do not ask the user to log in first. */
import { exec, which } from './shell.ts';

export function githubRepoFromRemote(url: string): string | null {
  const m = url.trim().replace(/\.git$/, '').match(/github\.com[:/]([\w.-]+\/[\w.-]+)$/);
  return m?.[1] ?? null;
}

export async function ensureGhAuth(): Promise<void> {
  if (!(await which('gh'))) {
    throw new Error('gh (GitHub CLI) not found. Install it from https://cli.github.com, then run this command again. Idlehand will sign it in.');
  }
  const status = () => exec(['gh', 'auth', 'status'], { timeoutMs: 20_000 });
  let current = await status();
  if (current.code === 0) return;
  const invalid = /invalid|refresh/i.test(`${current.stderr}\n${current.stdout}`);
  const cmd = invalid
    ? ['gh', 'auth', 'refresh', '-h', 'github.com']
    : ['gh', 'auth', 'login', '-h', 'github.com', '-p', 'https', '-w'];
  const signedIn = await exec(cmd, { timeoutMs: 10 * 60_000, stdio: 'inherit' });
  if (signedIn.code !== 0) throw new Error(`GitHub sign-in did not finish (${cmd.slice(0, 3).join(' ')}). Run this command again to retry.`);
  current = await status();
  if (current.code !== 0) throw new Error('GitHub CLI is still not signed in.');
}
