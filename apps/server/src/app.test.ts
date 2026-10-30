import { describe, expect, test, beforeEach } from 'bun:test';
import type { DeviceCodePoll, DeviceCodeStart, PopularRepo, RunReport, SelectedRepo, StoredRunReport } from '@idlehand/shared';
import { createApp } from './app.ts';
import { Store, type RepoInput } from './db.ts';
import type { GitHubClient, GitHubUser } from './github.ts';
import type { ServerConfig } from './config.ts';
import { signValue, SESSION_COOKIE } from './session.ts';

const config: ServerConfig = {
  port: 0,
  baseUrl: 'http://localhost:8787',
  githubClientId: 'id',
  githubClientSecret: 'secret',
  githubScopes: 'read:user',
  sessionSecret: 'test-secret',
  dbPath: ':memory:',
  devLogin: false,
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
    expect(res.headers.get('location')).toContain('/auth/github?next=');

    // approve with the form
    const form = new URLSearchParams({ userCode: start.userCode.toLowerCase(), decision: 'approve' });
    res = await app.request('http://localhost/cli/approve', {
      method: 'POST',
      headers: { cookie: alice, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Go back to your terminal');

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
    res = await req('/api/cli/runs', { method: 'POST', bearer: poll.token, json: report });
    expect(res.status).toBe(201);
    const stored = (await res.json()) as StoredRunReport;
    expect(stored).toMatchObject({ login: 'alice', outcome: 'reviewed', costUsd: 0.42, kind: 'review-pr' });
    expect(stored.summary.length).toBe(2000);

    res = await req('/api/cli/runs', { bearer: poll.token });
    expect(((await res.json()) as StoredRunReport[]).map((r) => r.id)).toEqual([stored.id]);

    expect((await req('/api/cli/runs', { method: 'POST', bearer: poll.token, json: { ...report, kind: 'dance' } })).status).toBe(400);

    // reports show up on the dashboard under the repo
    res = await req('/dashboard', { cookie: alice });
    const html = await res.text();
    expect(html).toContain('acme/rocket');
    expect(html).toContain('reviewed');
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
    expect(html).toContain('Sign in with GitHub');
    expect(html).toContain('other/lib');
    const popular = await (await req('/popular', { cookie: alice })).text();
    expect(popular).toContain('Included ✓');
  });
});
