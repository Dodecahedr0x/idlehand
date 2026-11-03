import { describe, expect, test, beforeEach } from 'bun:test';
import type { DeviceCodePoll, DeviceCodeStart, PopularRepo, RunReport, SelectedRepo, StoredRunReport } from '@idlehand/shared';
import { createApp } from './app.ts';
import { Store, type RepoInput } from './db.ts';
import type { GitHubClient, GitHubUser } from './github.ts';
import type { ServerConfig } from './config.ts';
import { safeNext, signValue, SESSION_COOKIE, STATE_COOKIE } from './session.ts';

const config: ServerConfig = {
  port: 0,
  baseUrl: 'http://localhost:8787',
  githubClientId: 'id',
  githubClientSecret: 'secret',
  githubScopes: 'read:user',
  sessionSecret: 'test-secret',
  dbPath: ':memory:',
  devLogin: false,
  devRepos: [],
};

const REPOS: RepoInput[] = [
  { owner: 'acme', name: 'rocket', description: 'Goes up', htmlUrl: 'https://github.com/acme/rocket', private: false, defaultBranch: 'main', language: 'Rust', stars: 10 },
  { owner: 'acme', name: 'anvil', description: null, htmlUrl: 'https://github.com/acme/anvil', private: false, defaultBranch: 'main', language: 'Go', stars: 3 },
  { owner: 'other', name: 'lib', description: 'A lib', htmlUrl: 'https://github.com/other/lib', private: false, defaultBranch: 'master', language: 'TypeScript', stars: 99 },
];

class FakeGitHub implements GitHubClient {
  users: Record<string, GitHubUser> = {
    'tok-alice': { id: 1, login: 'alice', name: 'Alice', avatarUrl: null },
    'tok-bob': { id: 2, login: 'bob', name: null, avatarUrl: null },
  };
  async exchangeCode(code: string) {
    return `tok-${code}`;
  }
  async getUser(token: string) {
    const u = this.users[token];
    if (!u) throw new Error('bad token');
    return u;
  }
  async listUserRepos(_token: string, page: number) {
    return page === 1 ? REPOS.slice(0, 2) : [];
  }
  async listPublicReposFor(_login: string, page: number) {
    return page === 1 ? REPOS.slice(0, 1) : [];
  }
  async getRepo(owner: string, name: string) {
    return REPOS.find((r) => r.owner === owner && r.name === name) ?? null;
  }
  async searchRepos(q: string) {
    return REPOS.filter((r) => `${r.owner}/${r.name}`.includes(q));
  }
}

let store: Store;
let app: ReturnType<typeof createApp>;

async function cookieFor(userId: number) {
  return `${SESSION_COOKIE}=${await signValue(config.sessionSecret, `${userId}:0`)}`;
}

function req(path: string, init: RequestInit & { cookie?: string; bearer?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    headers.set('x-requested-with', 'fetch');
  }
  if (init.method && init.method !== 'GET' && !headers.has('x-requested-with')) headers.set('x-requested-with', 'fetch');
  return app.request(`http://localhost${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

beforeEach(() => {
  store = new Store(':memory:');
  app = createApp({ config, store, github: new FakeGitHub() });
  store.upsertUser({ id: 1, login: 'alice', name: 'Alice', avatarUrl: null, accessToken: 'tok-alice' });
  store.upsertUser({ id: 2, login: 'bob', name: null, avatarUrl: null, accessToken: 'tok-bob' });
});

describe('auth basics', () => {
  test('/api/me without a session is 401', async () => {
    const res = await req('/api/me');
    expect(res.status).toBe(401);
  });
  test('/api/me with a session', async () => {
    const res = await req('/api/me', { cookie: await cookieFor(1) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 1, login: 'alice' });
  });
  test('dev login is disabled by default', async () => {
    const res = await req('/auth/dev?login=octocat');
    expect(res.status).toBe(404);
  });
  test('dev login works when enabled', async () => {
    const devApp = createApp({ config: { ...config, devLogin: true }, store, github: new FakeGitHub() });
    const res = await devApp.request('http://localhost/auth/dev?login=octocat', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
    expect(res.headers.get('set-cookie')).toContain(SESSION_COOKIE);
  });
  test('dev login preloads the configured repository', async () => {
    const devApp = createApp({ config: { ...config, devLogin: true, devRepos: ['acme/rocket'] }, store, github: new FakeGitHub() });
    const res = await devApp.request('http://localhost/auth/dev?login=octocat', { redirect: 'manual' });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const selections = await devApp.request('http://localhost/api/selections', { headers: { cookie } });
    expect(selections.status).toBe(200);
    expect(await selections.json()).toMatchObject([{ fullName: 'acme/rocket', selected: true }]);
  });
  test('mutations without the fetch header are rejected', async () => {
    const res = await app.request('http://localhost/api/selections', {
      method: 'POST',
      headers: { cookie: await cookieFor(1), 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'acme', name: 'rocket' }),
    });
    expect(res.status).toBe(403);
  });
  test('/dashboard redirects anonymous users', async () => {
    const res = await app.request('http://localhost/dashboard', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });
  test('/healthz', async () => {
    expect(await (await req('/healthz')).json()).toEqual({ ok: true });
  });
});

describe('selections and popular', () => {
  test('add, list, popular counts across users, delete', async () => {
    const alice = await cookieFor(1);
    const bob = await cookieFor(2);

    let res = await req('/api/selections', { method: 'POST', cookie: alice, json: { owner: 'acme', name: 'rocket' } });
    expect(res.status).toBe(201);
    const sel = (await res.json()) as SelectedRepo;
    expect(sel.fullName).toBe('acme/rocket');
    expect(sel.selected).toBe(true);
    expect(sel.selectedBy).toBe(1);

    await req('/api/selections', { method: 'POST', cookie: alice, json: { owner: 'other', name: 'lib' } });
    await req('/api/selections', { method: 'POST', cookie: bob, json: { owner: 'acme', name: 'rocket' } });

    res = await req('/api/selections', { cookie: alice });
    expect(((await res.json()) as SelectedRepo[]).map((s) => s.fullName).sort()).toEqual(['acme/rocket', 'other/lib']);

    res = await req('/api/repos/popular');
    const popular = (await res.json()) as PopularRepo[];
    expect(popular[0]).toMatchObject({ fullName: 'acme/rocket', selectedBy: 2 });
    expect(popular[1]).toMatchObject({ fullName: 'other/lib', selectedBy: 1 });
    expect(popular[0]!.selected).toBeUndefined();

    res = await req('/api/repos/popular', { cookie: bob });
    const popBob = (await res.json()) as PopularRepo[];
    expect(popBob.find((p) => p.fullName === 'other/lib')!.selected).toBe(false);
    expect(popBob.find((p) => p.fullName === 'acme/rocket')!.selected).toBe(true);

    res = await req('/api/selections/acme/rocket', { method: 'DELETE', cookie: alice });
    expect(res.status).toBe(200);
    res = await req('/api/selections/acme/rocket', { method: 'DELETE', cookie: alice });
    expect(res.status).toBe(404);
    res = await req('/api/repos/popular');
    const after = (await res.json()) as PopularRepo[];
    expect(after.find((p) => p.fullName === 'acme/rocket')!.selectedBy).toBe(1);
    // tie on count is broken by stars, so other/lib (99 stars) now leads
    expect(after[0]!.fullName).toBe('other/lib');
  });

  test('unknown repo is 404; bad body is 400', async () => {
    const alice = await cookieFor(1);
    expect((await req('/api/selections', { method: 'POST', cookie: alice, json: { owner: 'nope', name: 'nope' } })).status).toBe(404);
    expect((await req('/api/selections', { method: 'POST', cookie: alice, json: { owner: '' } })).status).toBe(400);
  });

  test('/api/me/repos flags selections and search decorates', async () => {
    const alice = await cookieFor(1);
    await req('/api/selections', { method: 'POST', cookie: alice, json: { owner: 'acme', name: 'anvil' } });
    const mine = (await (await req('/api/me/repos', { cookie: alice })).json()) as SelectedRepo[];
    expect(mine.map((r) => [r.fullName, r.selected])).toEqual([
      ['acme/rocket', false],
      ['acme/anvil', true],
    ]);
    const found = (await (await req('/api/repos/search?q=anvil', { cookie: alice })).json()) as SelectedRepo[];
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ fullName: 'acme/anvil', selected: true, selectedBy: 1 });
    const anon = (await (await req('/api/repos/search?q=anvil')).json()) as SelectedRepo[];
    expect(anon[0]!.selected).toBeUndefined();
  });

  test('anonymous search does not persist GitHub hits as repos rows', async () => {
    expect(store.getRepoByFullName('acme/anvil')).toBeNull();
    const res = await req('/api/repos/search?q=anvil');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([{ fullName: 'acme/anvil', selectedBy: 0 }]);
    expect(store.getRepoByFullName('acme/anvil')).toBeNull();
    const alice = await cookieFor(1);
    expect((await req('/api/selections', { method: 'POST', cookie: alice, json: { owner: 'acme', name: 'anvil' } })).status).toBe(201);
    expect(store.getRepoByFullName('acme/anvil')).toMatchObject({ full_name: 'acme/anvil' });
  });

  test('anonymous search is rate-limited per client', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.10' };
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await req('/api/repos/search?q=anvil', { headers })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await req('/api/repos/search?q=anvil', { headers: { 'x-forwarded-for': '203.0.113.11' } })).status).toBe(200);
    expect((await req('/api/repos/search?q=anvil', { cookie: await cookieFor(1), headers })).status).toBe(200);
  });
});

describe('CLI device flow + bearer API', () => {
  test('end to end', async () => {
    const alice = await cookieFor(1);

    let res = await req('/api/cli/codes', { method: 'POST' });
    expect(res.status).toBe(201);
    const start = (await res.json()) as DeviceCodeStart;
    expect(start.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(start.verificationUrl).toBe(`http://localhost:8787/cli/approve?code=${start.userCode}`);

    res = await req(`/api/cli/codes/${start.deviceCode}`);
    expect((await res.json()) as DeviceCodePoll).toEqual({ status: 'pending' });

    // approval page renders for the signed-in user
    res = await req(`/cli/approve?code=${start.userCode}`, { cookie: alice });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(start.userCode);

    // anonymous approve page redirects to login
    res = await app.request(`http://localhost/cli/approve?code=${start.userCode}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?next=');

    // approve with the form
    const form = new URLSearchParams({ userCode: start.userCode.toLowerCase(), decision: 'approve' });
    res = await app.request('http://localhost/cli/approve', {
      method: 'POST',
      headers: { cookie: alice, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Return to your terminal');

    res = await req(`/api/cli/codes/${start.deviceCode}`);
    const poll = (await res.json()) as DeviceCodePoll;
    expect(poll.status).toBe('approved');
    if (poll.status !== 'approved') throw new Error('unreachable');
    expect(poll.login).toBe('alice');
    expect(poll.token).toMatch(/^[0-9a-f]{64}$/);

    // token only handed out once
    res = await req(`/api/cli/codes/${start.deviceCode}`);
    expect(res.status).toBe(404);

    // bearer-authed endpoints
    res = await req('/api/cli/me', { bearer: poll.token });
    expect(await res.json()).toMatchObject({ login: 'alice' });
    expect((await req('/api/cli/me', { bearer: 'nope' })).status).toBe(401);
    expect((await req('/api/cli/me')).status).toBe(401);

    await req('/api/selections', { method: 'POST', cookie: alice, json: { owner: 'acme', name: 'rocket' } });
    res = await req('/api/cli/repos', { bearer: poll.token });
    expect(((await res.json()) as SelectedRepo[]).map((r) => r.fullName)).toEqual(['acme/rocket']);

    const report: RunReport = {
      repo: { owner: 'acme', name: 'rocket', fullName: 'acme/rocket' },
      kind: 'review-pr',
      provider: 'claude',
      outcome: 'reviewed',
      url: 'https://github.com/acme/rocket/pull/1',
      summary: 'Looked fine. '.repeat(500),
      costUsd: 0.42,
      costEstimated: false,
      durationMs: 12345,
      startedAt: '2026-10-30T10:00:00.000Z',
    };
    res = await req('/api/cli/runs', { method: 'POST', bearer: poll.token, json: { ...report, provider: 'nope' } });
    expect(res.status).toBe(400);
    res = await req('/api/cli/runs', { method: 'POST', bearer: poll.token, json: report });
    expect(res.status).toBe(201);
    const stored = (await res.json()) as StoredRunReport;
    expect(stored).toMatchObject({ login: 'alice', outcome: 'reviewed', costUsd: 0.42, kind: 'review-pr' });
    expect(stored.summary.length).toBe(2000);

    res = await req('/api/cli/runs', { bearer: poll.token });
    expect(((await res.json()) as StoredRunReport[]).map((r) => r.id)).toEqual([stored.id]);
    res = await req('/api/cli/runs', { method: 'POST', bearer: poll.token, json: { ...report, provider: 'cursor' } });
    expect(res.status).toBe(201);
    expect((await res.json()) as StoredRunReport).toMatchObject({ provider: 'cursor' });

    expect((await req('/api/cli/runs', { method: 'POST', bearer: poll.token, json: { ...report, kind: 'dance' } })).status).toBe(400);
    expect((await req('/api/cli/runs', { method: 'POST', bearer: poll.token, json: { ...report, costUnknown: 'true' } })).status).toBe(400);
    res = await req('/api/cli/runs', { method: 'POST', bearer: poll.token, json: { ...report, costUnknown: true, costUsd: 0, costEstimated: true } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ costUsd: 0, costUnknown: true });
    res = await req('/api/cli/runs', { bearer: poll.token });
    expect((await res.json() as StoredRunReport[]).some((r) => r.costUnknown === true)).toBe(true);

    // reports show up on the dashboard under the repo
    res = await req('/dashboard', { cookie: alice });
    const html = await res.text();
    expect(html).toContain('acme/rocket');
    expect(html).toContain('Reviewed');
    expect(html).toContain('unknown (reported ≈$0.00)');
  });

  test('denied code', async () => {
    const alice = await cookieFor(1);
    const start = (await (await req('/api/cli/codes', { method: 'POST' })).json()) as DeviceCodeStart;
    await app.request('http://localhost/cli/approve', {
      method: 'POST',
      headers: { cookie: alice, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ userCode: start.userCode, decision: 'deny' }).toString(),
    });
    expect(await (await req(`/api/cli/codes/${start.deviceCode}`)).json()).toEqual({ status: 'denied' });
    expect((await req(`/api/cli/codes/${start.deviceCode}`)).status).toBe(404);
  });

  test('expired code', async () => {
    const start = (await (await req('/api/cli/codes', { method: 'POST' })).json()) as DeviceCodeStart;
    store.db.query('UPDATE device_codes SET expires_at = ? WHERE device_code = ?').run('2000-01-01T00:00:00.000Z', start.deviceCode);
    expect(await (await req(`/api/cli/codes/${start.deviceCode}`)).json()).toEqual({ status: 'expired' });
    expect(store.db.query('SELECT 1 FROM device_codes WHERE device_code = ?').get(start.deviceCode)).toBeNull();
  });

  test('abandoned expired device codes are deleted', async () => {
    const abandoned = store.createDeviceCode(60_000);
    store.db.query('UPDATE device_codes SET expires_at = ? WHERE device_code = ?').run('2000-01-01T00:00:00.000Z', abandoned.device_code);
    expect((await req('/api/cli/codes', { method: 'POST' })).status).toBe(201);
    expect(store.db.query('SELECT 1 FROM device_codes WHERE device_code = ?').get(abandoned.device_code)).toBeNull();
  });

  test('device-code creation is rate-limited per client', async () => {
    const headers = { 'x-forwarded-for': '198.51.100.4' };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await req('/api/cli/codes', { method: 'POST', headers })).status);
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect((await req('/api/cli/codes', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.5' } })).status).toBe(201);
  });

  test('unknown code', async () => {
    expect((await req('/api/cli/codes/deadbeef')).status).toBe(404);
  });
});

describe('pages', () => {
  test('landing shows popular and sign-in', async () => {
    const alice = await cookieFor(1);
    await req('/api/selections', { method: 'POST', cookie: alice, json: { owner: 'other', name: 'lib' } });
    const html = await (await req('/')).text();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('Sign in with GitHub');
    expect(html).toContain('other/lib');
    const popular = await (await req('/popular', { cookie: alice })).text();
    expect(popular).toContain('Included ✓');
  });
});

describe('first contribution setup', () => {
  test('installation is available before sign-in and dashboard provides runnable first steps', async () => {
    const install = await req('/install');
    expect(install.status).toBe(200);
    const guide = await install.text();
    expect(guide).toContain('git clone https://github.com/Dodecahedr0x/idlehand.git');
    expect(guide).toContain('bun run --cwd apps/cli build');
    expect(guide).toContain('apps/cli/dist/idlehand');
    expect(guide).toContain('gh auth login');
    expect(guide).toContain('shell profile');
    expect(await (await req('/')).text()).toContain('href="/install"');
    const dashboard = await (await req('/dashboard', { cookie: await cookieFor(1) })).text();
    expect(dashboard).toContain('href="/install"');
    expect(dashboard).toContain('idlehand login --server http://localhost:8787');
    expect(dashboard).toContain('idlehand doctor');
    expect(dashboard).toContain("idlehand run --provider codex --budget &#39;1 task&#39; --once");
    expect(dashboard).toContain("idlehand run --provider cursor --budget &#39;1 task&#39; --once");
    expect(dashboard).toContain('no dollar cap');
    expect(dashboard).toContain('CLI not connected yet');
  });

  test('connection requires actual token use and never leaks another account or stale approval', async () => {
    const alice = await cookieFor(1);
    const dashboard = async () => (await req('/dashboard', { cookie: alice })).text();
    const pending = store.createDeviceCode(60000);
    expect(await dashboard()).toContain('CLI not connected yet');
    const token = store.approveDeviceCode(pending.device_code, 1, 'test');
    expect(await dashboard()).toContain('CLI not connected yet');
    await req('/api/cli/me', { bearer: token });
    expect(await dashboard()).toContain('CLI connected');
    expect(await (await req('/dashboard', { cookie: await cookieFor(2) })).text()).toContain('CLI not connected yet');

    store.db.query('DELETE FROM cli_tokens WHERE token = ?').run(token);
    expect((await req('/api/cli/me', { bearer: token })).status).toBe(401);
    expect(await dashboard()).toContain('CLI not connected yet');
    const expired = store.createDeviceCode(-1000);
    expect(store.getDeviceCode(expired.device_code)?.status).toBe('expired');
    const denied = store.createDeviceCode(60000);
    store.denyDeviceCode(denied.device_code);
    expect(await dashboard()).toContain('CLI not connected yet');
  });

  test('task failures and empty results are distinguished from a completed contribution', async () => {
    const alice = await cookieFor(1);
    const dashboard = async () => (await req('/dashboard', { cookie: alice })).text();
    const report: RunReport = {
      repo: { owner: 'acme', name: 'rocket', fullName: 'acme/rocket' },
      kind: 'fix-issue', provider: 'claude', outcome: 'failed', url: null,
      summary: 'A result', costUsd: 0.1, costEstimated: false, durationMs: 100,
      startedAt: '2026-10-30T10:00:00.000Z',
    };
    store.addRunReport(2, { ...report, outcome: 'pr-opened' });
    expect(await dashboard()).not.toContain('First contribution completed');
    store.addRunReport(1, report);
    expect(await dashboard()).toContain('Your last task failed');
    expect(await dashboard()).not.toContain('First contribution completed');
    store.addRunReport(1, { ...report, outcome: 'unverified' });
    expect(await dashboard()).toContain('Your last result could not be verified');
    store.addRunReport(1, { ...report, outcome: 'nothing-found' });
    expect(await dashboard()).toContain('First check completed');
    expect(await dashboard()).not.toContain('First contribution completed');
    store.addRunReport(1, { ...report, outcome: 'pr-opened' });
    expect(await dashboard()).toContain('First contribution completed');
    store.addRunReport(1, report);
    expect(await dashboard()).toContain('First contribution completed');
  });
});


describe('sign-in recovery', () => {
  async function start(next = '/cli/approve?code=ABCD-EFGH') {
    const res = await req(`/auth/github?next=${encodeURIComponent(next)}`);
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(STATE_COOKIE))!.split(';')[0]!;
    return { state, cookie, next };
  }

  test('OAuth round trip preserves the CLI code and clears the state cookie', async () => {
    const flow = await start();
    const res = await req(`/auth/github/callback?code=alice&state=${flow.state}`, { cookie: flow.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(flow.next);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${STATE_COOKIE}=`) && c.includes('Max-Age=0'))).toBe(true);
  });

  test('cancelled and failed sign-ins keep a safe retry destination', async () => {
    for (const suffix of ['error=access_denied', 'code=unknown', '']) {
      const flow = await start();
      const res = await req(`/auth/github/callback?state=${flow.state}&${suffix}`, { cookie: flow.cookie });
      expect([400, 502]).toContain(res.status);
      const html = await res.text();
      expect(html).toContain(`/login?next=${encodeURIComponent(flow.next)}`);
      expect(html).toContain('Try sign-in again');
      expect(html).not.toContain('bad token');
      expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    }
  });

  test('invalid state never signs in or trusts its next destination', async () => {
    const flow = await start();
    const res = await req('/auth/github/callback?code=alice&state=wrong', { cookie: flow.cookie });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('another browser session');
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });

  test('unconfigured OAuth has a useful recovery page', async () => {
    const unconfigured = createApp({ config: { ...config, githubClientSecret: '' }, store, github: new FakeGitHub() });
    const res = await unconfigured.request('http://localhost/auth/github');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Explore repositories');
  });

  test('redirects stay on this site, including browser-normalized backslashes', async () => {
    for (const value of ['https://example.com', '//example.com', '/\\example.com', '/ /example.com', '/\n/example.com', '']) {
      expect(safeNext(value)).toBe('/dashboard');
    }
    expect(safeNext('/dashboard?page=2#your-repos')).toBe('/dashboard?page=2#your-repos');
    const res = await req('/dashboard?page=2');
    expect(res.headers.get('location')).toBe('/login?next=%2Fdashboard%3Fpage%3D2');
    const html = await (await req('/login?next=%2Fcli%2Fapprove%3Fcode%3DABCD-EFGH')).text();
    expect(html).toContain('After sign-in');
    expect(html).toContain('/auth/github?next=%2Fcli%2Fapprove%3Fcode%3DABCD-EFGH');
  });

  test('session expiry during CLI confirmation preserves the code without approving it', async () => {
    const start = store.createDeviceCode(60000);
    const res = await req('/cli/approve', { method: 'POST', body: new URLSearchParams({ userCode: start.user_code, decision: 'approve' }) });
    expect(res.headers.get('location')).toBe(`/login?next=${encodeURIComponent(`/cli/approve?code=${start.user_code}`)}`);
    expect(store.getDeviceCode(start.device_code)?.status).toBe('pending');
    const invalid = await req('/cli/approve', { method: 'POST', cookie: await cookieFor(1), body: new URLSearchParams({ userCode: start.user_code, decision: 'unknown' }) });
    expect(invalid.status).toBe(400);
    expect(store.getDeviceCode(start.device_code)?.status).toBe('pending');
  });

  test('CLI code entry and expired-code recovery are available', async () => {
    const cookie = await cookieFor(1);
    const entry = await (await req('/cli/approve', { cookie })).text();
    expect(entry).toContain('Terminal code');
    const code = store.createDeviceCode(-1000);
    const expired = await (await req(`/cli/approve?code=${code.user_code}`, { cookie })).text();
    expect(expired).toContain('This code has expired.');
  });
});
