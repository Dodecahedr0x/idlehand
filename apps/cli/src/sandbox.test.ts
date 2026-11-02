import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxedSh } from './sandbox.ts';
import { verify } from './verify.ts';

test('an installed runner can still use Bun without exposing its private tool directory', async () => {
  const checkout = mkdtempSync(join(tmpdir(), 'idlehand-installed-runtime-'));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
  try {
    // Model a compiled runner rather than using Bun itself as process.execPath.
    Object.defineProperty(process, 'execPath', { value: '/bin/sh' });
    const result = await sandboxedSh('bun --version', checkout, 10_000);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(Bun.version);
  } finally {
    Object.defineProperty(process, 'execPath', descriptor);
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('verification denies writes and credential reads outside the checkout, including symlink escapes', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'idlehand-confinement-'));
  const checkout = join(parent, 'checkout');
  mkdirSync(checkout);
  writeFileSync(join(parent, 'credential'), 'synthetic-secret');
  symlinkSync(parent, join(checkout, 'escape'));
  try {
    const result = await sandboxedSh([
      'echo allowed > inside',
      'if echo escaped > ../outside; then exit 21; fi',
      'if echo escaped > escape/symlink-outside; then exit 22; fi',
      'if cat ../credential 2>/dev/null; then exit 23; fi',
      'if cat escape/credential 2>/dev/null; then exit 24; fi',
      'echo confined',
    ].join('\n'), checkout, 10_000);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('confined');
    expect(readFileSync(join(checkout, 'inside'), 'utf8')).toBe('allowed\n');
    expect(existsSync(join(parent, 'outside'))).toBe(false);
    expect(existsSync(join(parent, 'symlink-outside'))).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('verification discards inherited credentials and supplies a private home', async () => {
  const checkout = mkdtempSync(join(tmpdir(), 'idlehand-env-'));
  const previous = process.env.IDLEHAND_TEST_TOKEN;
  process.env.IDLEHAND_TEST_TOKEN = 'synthetic-secret';
  try {
    const result = await sandboxedSh('test -z "${IDLEHAND_TEST_TOKEN+x}" && test "$HOME" != / && echo safe > "$HOME/check" && echo restricted', checkout, 10_000);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('restricted');
  } finally {
    if (previous === undefined) delete process.env.IDLEHAND_TEST_TOKEN;
    else process.env.IDLEHAND_TEST_TOKEN = previous;
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('sandbox startup failure never confirms an expected failing reproduction', async () => {
  const checkout = mkdtempSync(join(tmpdir(), 'idlehand-unsupported-'));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'unsupported-test' });
    const result = await verify({ setup: [], command: 'exit 1' }, { exitCode: 'nonzero' }, checkout, 10_000);
    expect(result.ok).toBe(false);
    expect(result.infrastructureError).toBe(true);
    expect(result.reason).toMatch(/sandbox.*unsupported/i);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('verification can use the public network and cannot reach a local service', async () => {
  const checkout = mkdtempSync(join(tmpdir(), 'idlehand-network-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('synthetic-secret') });
  try {
    const script = [
      'if curl -fsS --max-time 15 https://example.com >/dev/null; then echo public-ok; else echo public-fail; fi',
      `if curl -fsS --max-time 3 http://127.0.0.1:${server.port}/ >/dev/null; then echo local-open; else echo local-denied; fi`,
    ].join('\n');
    const result = await sandboxedSh(script, checkout, 20_000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('public-ok');
    expect(result.stdout).toContain('local-denied');
  } finally {
    server.stop(true);
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('timed out commands and background children are terminated', async () => {
  const checkout = mkdtempSync(join(tmpdir(), 'idlehand-timeout-'));
  try {
    const timed = await sandboxedSh('(sleep 1; echo leaked > timeout-leak) & wait', checkout, 100);
    expect(timed.timedOut).toBe(true);
    const background = await sandboxedSh('(sleep 1; echo leaked > background-leak) & echo finished', checkout, 10_000);
    expect(background.code).toBe(0);
    await Bun.sleep(1200);
    expect(existsSync(join(checkout, 'timeout-leak'))).toBe(false);
    expect(existsSync(join(checkout, 'background-leak'))).toBe(false);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'darwin')('detached macOS children retain filesystem confinement', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'idlehand-session-'));
  const checkout = join(parent, 'checkout');
  mkdirSync(checkout);
  let pid = 0;
  try {
    const child = `try { await Bun.write(${JSON.stringify(join(parent, 'outside'))}, 'escaped'); } catch { } await Bun.write(${JSON.stringify(join(checkout, 'daemon'))}, 'confined'); await Bun.sleep(2000);`;
    const script = `const p = Bun.spawn([process.execPath, '-e', ${JSON.stringify(child)}], {detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'}); console.log(p.pid); p.unref();`;
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const result = await sandboxedSh(`${quote(process.execPath)} -e ${quote(script)}`, checkout, 10_000);
    pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(1);
    await Bun.sleep(300);
    expect(existsSync(join(checkout, 'daemon'))).toBe(true);
    expect(existsSync(join(parent, 'outside'))).toBe(false);
  } finally {
    if (pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(parent, { recursive: true, force: true });
  }
});
