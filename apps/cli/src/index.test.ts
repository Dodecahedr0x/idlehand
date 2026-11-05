import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, saveConfig, type Config } from './config.ts';
import { State } from './state.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(config?: Config) {
  const root = mkdtempSync(join(tmpdir(), 'idlehand-cli-test-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const calls = join(root, 'calls');
  mkdirSync(bin);
  if (config) saveConfig(config, join(home, 'config.json'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$1 $2" in
  'auth status')
    if [ -f "$GH_LOGGED_IN" ]; then exit 0; fi
    if [ "$GH_AUTH" = invalid ]; then echo "The token in keyring is invalid." >&2; exit 1; fi
    if [ "$GH_AUTH" = missing ]; then echo "You are not logged into any GitHub hosts." >&2; exit 1; fi
    exit 0 ;;
  'auth login'|'auth refresh') touch "$GH_LOGGED_IN"; exit 0 ;;
  'auth token') printf '%s\\n' "\${GH_TOKEN:-gho_test}" ;;
  'api user') printf 'tester\\n' ;;
  'api repos/'*)
    if [ "$SLOW_SCAN" = 1 ]; then sleep 0.3; fi
    printf '%s\\n' '{"full_name":"o/r","default_branch":"main","archived":false}' ;;
  'pr list')
    if [ "$GH_OWN_PR" = 1 ]; then printf '%s\\n' '[{"number":1,"title":"mine","author":{"login":"tester"},"isDraft":false,"createdAt":"2026-01-01T00:00:00Z","reviews":[],"labels":[]}]'; else printf '[]\\n'; fi ;;
  'issue list') printf '[]\\n' ;;
  *) exit 90 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf "git %s\\n" "$*" >> "$GH_CALLS"\nexit 90\n', { mode: 0o755 });
  const env = { ...process.env, IDLEHAND_HOME: home, GH_CALLS: calls, GH_LOGGED_IN: join(root, 'logged-in'), PATH: `${bin}:/usr/bin:/bin` };
  const spawn = (args: string[], extraEnv: Record<string, string> = {}) => Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts'), ...args], {
    env: { ...env, ...extraEnv }, stdout: 'pipe', stderr: 'pipe',
  });
  const run = async (...args: string[]) => {
    const proc = spawn(args);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  return { home, calls, run, spawn };
}

function config(): Config {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server.url = 'http://127.0.0.1:1';
  cfg.claude.bin = 'idlehand-test-missing-claude';
  cfg.codex.bin = 'idlehand-test-missing-codex';
  cfg.cursor.bin = 'idlehand-test-missing-cursor';
  cfg.repos = ['o/r'];
  return cfg;
}

test('help offers a safe first run, and bare config shows defaults without creating settings', async () => {
  const f = fixture();
  for (const args of [[], ['--plain'], ['--help'], ['run', '--help']]) {
    const r = await f.run(...args);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain("'$2'");
    if (args[0] === 'run') {
      expect(r.stdout).toContain('cursor');
      expect(r.stdout).toContain('--jobs');
    }
    expect(r.stderr).toBe('');
  }
  const r = await f.run('config', '--json');
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(DEFAULT_CONFIG);
  expect(existsSync(f.home)).toBe(false);
});

test('invalid arguments fail before tool checks and leave settings alone', async () => {
  const f = fixture();
  const cases = [
    ['run', '--provider', 'typo'],
    ['run', '--only', 'fix-issues'],
    ['run', '--only', ''],
    ['run', '--repo', 'https://github.com/o/r'],
    ['run', '--repo', '../r'],
    ['repos', 'add', 'missing-owner'],
    ['status', '-n', 'nope'],
    ['status', '--limit', '-1'],
    ['status', '--limit', '0'],
    ['run', '--jobs', '0'],
    ['run', '--jobs', 'nope'],
    ['run', '--budget', '10%'],
    ['run', '--budget', '0m'],
    ['--unknown-option'],
    ['run', '--unknown-option'],
  ];
  for (const args of cases) {
    const r = await f.run(...args, '--json');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr)).toMatchObject({ type: 'error', message: expect.any(String) });
  }
  const typo = await f.run('stats');
  expect(typo.stderr).toContain('Did you mean status?');
  expect(typo.stderr).toContain('--help');
  expect(existsSync(f.home)).toBe(false);
  expect(existsSync(f.calls)).toBe(false);
});

test('JSON mode stays parseable across settings and repo mutations, including duplicate selections', async () => {
  const f = fixture();
  for (const args of [
    ['config', 'path'], ['config', 'get', 'provider'], ['config', 'keys'],
    ['config', 'set', 'budget', '$2'], ['logout'],
  ]) {
    const r = await f.run(...args, '--json');
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stderr).toBe('');
  }
  expect(JSON.parse((await f.run('repos', 'add', 'o/r', '--json')).stdout)).toEqual({ repo: 'o/r', added: true });
  expect(JSON.parse((await f.run('repos', 'add', 'o/r', '--json')).stdout)).toEqual({ repo: 'o/r', added: false });
  expect(JSON.parse((await f.run('repos', 'remove', 'o/r', '--json')).stdout)).toEqual({ repo: 'o/r', removed: true });
  expect(JSON.parse((await f.run('repos', 'remove', 'o/r', '--json')).stdout)).toEqual({ repo: 'o/r', removed: false });
});

test('broken settings name the file and explain how to recover without a stack trace', async () => {
  const f = fixture(config());
  const path = join(f.home, 'config.json');
  writeFileSync(path, '{broken');
  const r = await f.run('config');
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(path);
  expect(r.stderr).toContain('move it aside');
  expect(r.stderr).not.toContain('at loadConfig');
  expect(readFileSync(path, 'utf8')).toBe('{broken');
});

test('doctor returns the same failure status in human and JSON output; optional tools do not block', async () => {
  const cfg = config();
  const f = fixture(cfg);
  for (const args of [[], ['--json']]) expect((await f.run('doctor', ...args)).code).toBe(1);
  cfg.claude.bin = '/bin/echo';
  saveConfig(cfg, join(f.home, 'config.json'));
  for (const args of [[], ['--json']]) expect((await f.run('doctor', ...args)).code).toBe(0);
  cfg.budget = '0m';
  saveConfig(cfg, join(f.home, 'config.json'));
  expect((await f.run('doctor', '--json')).code).toBe(1);
});

test('login uses the signed-in GitHub CLI and does not ask for a browser', async () => {
  const seen: { path: string; token: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === 'POST' ? await req.json().catch(() => null) as { token?: string } | null : null;
      seen.push({ path, token: body?.token ?? '' });
      if (req.method === 'POST' && path === '/api/cli/github' && body?.token === 'gho_test') {
        return Response.json({ token: 'ab'.repeat(32), login: 'tester' }, { status: 201 });
      }
      return Response.json({ error: 'nope' }, { status: 404 });
    },
  });
  try {
    const f = fixture(config());
    const r = await f.run('login', '--server', `http://127.0.0.1:${server.port}`, '--json');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).not.toContain('gho_test');
    expect(r.stdout).not.toContain('verification');
    expect(JSON.parse(r.stdout)).toEqual({ type: 'logged-in', login: 'tester', server: `http://127.0.0.1:${server.port}` });
    expect(seen).toEqual([{ path: '/api/cli/github', token: 'gho_test' }]);
    expect(JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')).server).toMatchObject({ token: 'ab'.repeat(32), login: 'tester' });
    expect(readFileSync(f.calls, 'utf8')).toContain('auth token');
    expect(readFileSync(f.calls, 'utf8')).not.toContain('open ');
  } finally {
    server.stop(true);
  }
});

test('a run signs the GitHub CLI in instead of asking for it first', async () => {
  const missing = fixture(config());
  const missingProc = missing.spawn(['run', '--dry-run', '--repo', 'o/r', '--json'], { GH_AUTH: 'missing' });
  const [missingOut, missingErr, missingCode] = await Promise.all([new Response(missingProc.stdout).text(), new Response(missingProc.stderr).text(), missingProc.exited]);
  expect(missingCode).toBe(0);
  expect(missingErr).toBe('');
  expect(missingOut).toContain('dry run: nothing executed');
  expect(readFileSync(missing.calls, 'utf8')).toContain('auth login -h github.com -p https -w');
  const invalid = fixture(config());
  const invalidProc = invalid.spawn(['run', '--dry-run', '--repo', 'o/r', '--json'], { GH_AUTH: 'invalid' });
  const invalidCode = await invalidProc.exited;
  await new Response(invalidProc.stdout).text();
  expect(invalidCode).toBe(0);
  expect(readFileSync(invalid.calls, 'utf8')).toContain('auth refresh -h github.com');
});

test('a run is continuous by default, so your own pull request stays in the queue', async () => {
  const f = fixture(config());
  const included = f.spawn(['run', '--dry-run', '--repo', 'o/r', '--only', 'review-pr', '--json'], { GH_OWN_PR: '1' });
  const [includedOut, includedErr, includedCode] = await Promise.all([new Response(included.stdout).text(), new Response(included.stderr).text(), included.exited]);
  expect(includedCode).toBe(0);
  expect(includedErr).toBe('');
  expect(includedOut.trim().split('\n').map((line) => JSON.parse(line)).find((e) => e.type === 'plan').tasks.map((t: { target: string }) => t.target)).toEqual(['pr:1']);
  const skipped = f.spawn(['run', '--dry-run', '--repo', 'o/r', '--only', 'review-pr', '--no-continuous', '--json'], { GH_OWN_PR: '1' });
  const [skippedOut, skippedCode] = await Promise.all([new Response(skipped.stdout).text(), skipped.exited]);
  expect(skippedCode).toBe(0);
  expect(skippedOut.trim().split('\n').map((line) => JSON.parse(line)).find((e) => e.type === 'plan').tasks).toEqual([]);
});

test('dry run works without an agent, deduplicates repos, and leaves running tasks and checkouts alone', async () => {
  const f = fixture(config());
  mkdirSync(join(f.home, 'repos', 'o', 'r'), { recursive: true });
  const path = join(f.home, 'state.sqlite');
  const state = new State(path);
  state.startTask({ repo: 'o/r', kind: 'fix-issue', target: 'issue:1', provider: 'claude' });
  state.close();
  const r = await f.run('run', '--dry-run', '--repo', 'o/r', 'o/r', '--json');
  expect(r.code).toBe(0);
  expect(r.stderr).toBe('');
  const events = r.stdout.trim().split('\n').map((line) => JSON.parse(line));
  expect(events.find((e) => e.type === 'plan').tasks).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'dry run: nothing executed', usage: { tasksCompleted: 0, spentUsd: 0 } });
  const after = new State(path);
  expect(after.recent()).toHaveLength(1);
  expect(after.recent()[0]!.outcome).toBe('running');
  after.close();
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n');
  expect(calls.filter((line) => line === 'api repos/o/r')).toHaveLength(1);
  expect(calls.some((line) => line.startsWith('git '))).toBe(false);
});

test('Cursor monetary budgets fail before tool checks, while a task budget can be selected', async () => {
  const cfg = config();
  cfg.provider = 'cursor';
  cfg.subscription.monthlyUsd = 200;
  const f = fixture(cfg);
  for (const cap of ['$0.01', '10%']) {
    const result = await f.run('run', '--budget', cap, '--json');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).message).toContain('Cursor cannot enforce');
    expect(existsSync(f.calls)).toBe(false);
  }
  const selected = await f.run('config', 'set', 'provider', 'cursor', '--json');
  expect(selected.code).toBe(0);
  expect(JSON.parse(selected.stdout).value).toBe('cursor');
  const doctor = await f.run('doctor', '--json');
  expect(doctor.code).toBe(1);
  expect(JSON.parse(doctor.stdout).find((c: { name: string }) => c.name === 'budget')).toMatchObject({ ok: false, detail: expect.stringContaining('Cursor cannot enforce') });
  expect(JSON.parse(doctor.stdout).find((c: { name: string }) => c.name === 'cursor')).toMatchObject({ ok: false });
});

test('Codex monetary budgets fail before tool checks, while dry runs remain available', async () => {
  const cfg = config();
  cfg.provider = 'codex';
  cfg.subscription.monthlyUsd = 200;
  const f = fixture(cfg);
  for (const cap of ['$0.01', '10%']) {
    const result = await f.run('run', '--budget', cap, '--json');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).message).toContain('Codex cannot enforce');
    expect(existsSync(f.calls)).toBe(false);
  }
  const preview = await f.run('run', '--dry-run', '--json');
  expect(preview.code).toBe(0);
  cfg.codex.bin = '/bin/echo';
  saveConfig(cfg, join(f.home, 'config.json'));
  const doctor = await f.run('doctor', '--json');
  expect(doctor.code).toBe(1);
  expect(JSON.parse(doctor.stdout).find((c: { name: string }) => c.name === 'budget')).toMatchObject({ ok: false, detail: expect.stringContaining('Codex cannot enforce') });
});

test('status identifies unknown historical spending in totals and task rows', async () => {
  const f = fixture(config());
  const state = new State(join(f.home, 'state.sqlite'));
  const id = state.startTask({ repo: 'o/r', kind: 'fix-issue', target: 'issue:1', provider: 'claude' });
  state.finishTask(id, { outcome: 'failed', url: null, summary: 'missing accounting', costUsd: 0, costEstimated: true, costUnknown: true, durationMs: 1 });
  state.close();
  const human = await f.run('status');
  expect(human.code).toBe(0);
  expect(human.stdout.match(/unknown \(reported ≈\$0\.00\)/g)).toHaveLength(2);
  const json = await f.run('status', '--json');
  expect(JSON.parse(json.stdout)).toMatchObject({ month: { spentUsd: 0, costUnknown: true }, recent: [{ cost_unknown: 1 }] });
});

test('Ctrl+C during discovery finishes with a structured stopped message and starts no tasks', async () => {
  const f = fixture(config());
  const proc = f.spawn(['run', '--dry-run', '--json'], { SLOW_SCAN: '1' });
  let stdout = '';
  let stopped = false;
  const output = (async () => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      stdout += new TextDecoder().decode(chunk);
      if (!stopped && stdout.includes('scanning o/r')) { stopped = true; proc.kill('SIGINT'); }
    }
  })();
  try {
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), output]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stopped).toBe(true);
    const events = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stopped by user' });
    expect(events.some((e) => e.type === 'task-start')).toBe(false);
  } finally { proc.kill(); }
});
