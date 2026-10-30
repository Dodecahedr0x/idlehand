/**
 * Runner-side verification. The agent *claims* a bug exists or is fixed; we
 * re-run its reproduction command ourselves and only act when the observed
 * behaviour matches the claim. This is the anti-hallucination gate.
 */
import { sh, tail } from './shell.ts';

export interface Expectation {
  exitCode: 'zero' | 'nonzero';
  /** Substring (case-insensitive) that must appear in stdout+stderr. */
  outputIncludes?: string | null;
  /** Substring that must NOT appear. */
  outputExcludes?: string | null;
}

export interface Reproduction {
  /** Commands run once before `command` (e.g. install deps). May be empty. */
  setup: string[];
  /** The command whose behaviour demonstrates the bug. */
  command: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Human-readable reason when not ok. */
  reason: string | null;
  exitCode: number;
  timedOut: boolean;
  outputTail: string;
  durationMs: number;
}

const SAFE_ENV = { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' };

export async function runSetup(setup: string[], cwd: string, timeoutMs: number, log?: (l: string) => void): Promise<VerifyResult | null> {
  for (const cmd of setup) {
    log?.(`setup: ${cmd}`);
    const r = await sh(cmd, { cwd, timeoutMs, env: SAFE_ENV });
    if (r.code !== 0 || r.timedOut) {
      return {
        ok: false,
        reason: r.timedOut ? `setup command timed out: ${cmd}` : `setup command failed (${r.code}): ${cmd}`,
        exitCode: r.code,
        timedOut: r.timedOut,
        outputTail: tail(r.stdout + '\n' + r.stderr),
        durationMs: r.durationMs,
      };
    }
  }
  return null;
}

export async function verify(repro: Reproduction, expect: Expectation, cwd: string, timeoutMs: number, log?: (l: string) => void): Promise<VerifyResult> {
  const setupFail = await runSetup(repro.setup ?? [], cwd, timeoutMs, log);
  if (setupFail) return setupFail;
  log?.(`run: ${repro.command}`);
  const r = await sh(repro.command, { cwd, timeoutMs, env: SAFE_ENV });
  const out = r.stdout + '\n' + r.stderr;
  return judge(expect, r.code, r.timedOut, out, r.durationMs);
}

export function judge(expect: Expectation, code: number, timedOut: boolean, out: string, durationMs = 0): VerifyResult {
  const base = { exitCode: code, timedOut, outputTail: tail(out), durationMs };
  if (timedOut) return { ...base, ok: false, reason: 'command timed out' };
  if (expect.exitCode === 'zero' && code !== 0) return { ...base, ok: false, reason: `expected exit 0, got ${code}` };
  if (expect.exitCode === 'nonzero' && code === 0) return { ...base, ok: false, reason: 'expected a non-zero exit, got 0' };
  const lower = out.toLowerCase();
  if (expect.outputIncludes && !lower.includes(expect.outputIncludes.toLowerCase())) {
    return { ...base, ok: false, reason: `output does not contain "${expect.outputIncludes}"` };
  }
  if (expect.outputExcludes && lower.includes(expect.outputExcludes.toLowerCase())) {
    return { ...base, ok: false, reason: `output still contains "${expect.outputExcludes}"` };
  }
  return { ...base, ok: true, reason: null };
}

/** Reject reproduction commands that reach outside the checkout or are obviously destructive. */
export function commandLooksSafe(command: string): string | null {
  const c = command.trim();
  if (!c) return 'empty command';
  if (/\brm\s+-rf\s+[\/~]/.test(c)) return 'refuses to run rm -rf on an absolute or home path';
  if (/\b(sudo|doas)\b/.test(c)) return 'refuses to run sudo';
  if (/\bgit\s+push\b|\bgh\s+(pr|issue|release|repo)\b/.test(c)) return 'reproduction commands may not push or talk to GitHub';
  if (/curl[^|]*\|\s*(ba)?sh\b/.test(c)) return 'refuses to pipe a download into a shell';
  if (/\b(shutdown|reboot|mkfs|dd\s+if=)/.test(c)) return 'refuses obviously destructive commands';
  return null;
}

/** Cheap title de-dup: normalized token Jaccard. */
export function similarTitle(a: string, b: string): boolean {
  const norm = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const A = norm(a), B = norm(b);
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.6;
}
