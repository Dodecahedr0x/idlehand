/** Small subprocess helpers built on Bun.spawn. */

export class Stopped extends Error {
  constructor() {
    super('stopped');
    this.name = 'Stopped';
  }
}

export function isStopped(error: unknown): boolean {
  return error instanceof Stopped || (error instanceof Error && error.name === 'Stopped');
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Use only env rather than inheriting the runner's credentials and settings. */
  inheritEnv?: boolean;
  /** Kill this command's process group on exit/timeout; detached sessions can escape cleanup. */
  killProcessGroup?: boolean;
  timeoutMs?: number;
  stdin?: string;
  /** Called with each chunk of combined output as it arrives. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Cap stored output (we always keep the tail). */
  maxBytes?: number;
  /** Hand the terminal to an interactive command such as `gh auth login`. */
  stdio?: 'pipe' | 'inherit';
  /** Abort the child. The returned promise rejects with `Stopped`. */
  signal?: AbortSignal;
}

export async function exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (opts.signal?.aborted) throw new Stopped();
  const started = Date.now();
  const inherit = opts.stdio === 'inherit';
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: (opts.inheritEnv === false ? opts.env ?? {} : { ...process.env, ...(opts.env ?? {}) }) as Record<string, string>,
    stdin: inherit ? 'inherit' : opts.stdin != null ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: inherit ? 'inherit' : 'pipe',
    stderr: inherit ? 'inherit' : 'pipe',
    detached: opts.killProcessGroup,
  });
  const killGroup = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} };
  // Close inherited pipes even when a shell exits while background children run.
  if (opts.killProcessGroup) void proc.exited.then(killGroup);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      if (opts.killProcessGroup) { killGroup(); return; }
      try {
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      } catch {}
    }, opts.timeoutMs);
  }
  const max = opts.maxBytes ?? 512 * 1024;
  const collect = async (stream: ReadableStream<Uint8Array> | null, name: 'stdout' | 'stderr') => {
    if (!stream) return '';
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      const s = dec.decode(chunk, { stream: true });
      opts.onOutput?.(s, name);
      buf += s;
      if (buf.length > max) buf = buf.slice(buf.length - max);
    }
    return buf;
  };
  let killLater: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    killLater = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already exited */ } }, 2000);
    killLater.unref?.();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let stdout = '';
  let stderr = '';
  try {
    if (!inherit) [stdout, stderr] = await Promise.all([collect(proc.stdout ?? null, 'stdout'), collect(proc.stderr ?? null, 'stderr')]);
    const code = await proc.exited;
    if (opts.signal?.aborted) throw new Stopped();
    return { code, stdout, stderr, timedOut, durationMs: Date.now() - started };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (killLater) clearTimeout(killLater);
    if (timer) clearTimeout(timer);
  }
}

/** Run a shell command string through `sh -c` (for user/agent supplied commands). */
export function sh(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return exec(['/bin/sh', '-c', command], opts);
}

export function tail(s: string, lines = 40, maxChars = 4000): string {
  const t = s.split('\n').slice(-lines).join('\n');
  return t.length > maxChars ? '…' + t.slice(-maxChars) : t;
}

export async function which(bin: string): Promise<string | null> {
  const r = await exec(['/bin/sh', '-c', `command -v ${JSON.stringify(bin)}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}
