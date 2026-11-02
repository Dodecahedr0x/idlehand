import { createApp } from './src/app.ts';
import { Store } from './src/db.ts';
import type { GitHubClient, GitHubUser } from './src/github.ts';
import type { ServerConfig } from './src/config.ts';
import { signValue, SESSION_COOKIE } from './src/session.ts';
import type { RepoInput } from './src/db.ts';

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

class FakeGitHub implements GitHubClient {
  users: Record<string, GitHubUser> = { 'tok-alice': { id: 1, login: 'alice', name: 'Alice', avatarUrl: null } };
  revoked: string[] = [];
  async exchangeCode(code: string) { return `tok-${code}`; }
  async getUser(token: string) {
    const u = this.users[token];
    if (!u) throw new Error('bad token');
    return u;
  }
  async listUserRepos(_token: string, _page: number): Promise<RepoInput[]> { return []; }
  async listPublicReposFor(_login: string, _page: number): Promise<RepoInput[]> { return []; }
  async getRepo() { return null; }
  async searchRepos() { return []; }
  async revokeAccessToken(token: string) { this.revoked.push(token); }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const store = new Store(':memory:', config.sessionSecret);
const github = new FakeGitHub();
const app = createApp({ config, store, github });
store.upsertUser({ id: 1, login: 'alice', name: 'Alice', avatarUrl: null, accessToken: 'tok-alice' });

const stale = `${SESSION_COOKIE}=${await signValue(config.sessionSecret, `1:${Date.now() - 31 * 24 * 60 * 60 * 1000}`)}`;
let res = await app.request('http://localhost/api/me', { headers: { cookie: stale } });
if (res.status !== 401) fail(`stale session cookie accepted: ${res.status}`);

const raw = store.db.query<{ access_token: string | null }, [number]>('SELECT access_token FROM users WHERE id = ?').get(1);
if (raw?.access_token === 'tok-alice') fail('access_token stored in plaintext');

const version = store.getUser(1)?.session_version ?? 0;
const fresh = `${SESSION_COOKIE}=${await signValue(config.sessionSecret, `1:${Date.now()}:${version}`)}`;
res = await app.request('http://localhost/api/me', { headers: { cookie: fresh } });
if (res.status !== 200) fail(`fresh session rejected: ${res.status}`);

res = await app.request('http://localhost/logout', { method: 'POST', headers: { cookie: fresh }, redirect: 'manual' });
res = await app.request('http://localhost/api/me', { headers: { cookie: fresh } });
if (res.status !== 401) fail(`copied session cookie still valid after logout: ${res.status}`);
if (store.getUser(1)?.access_token) fail('access_token still present after logout');
if (!github.revoked.includes('tok-alice')) fail('GitHub token was not revoked on logout');

if (typeof store.revokeCliToken !== 'function') fail('Store has no revokeCliToken');
const token = store.approveDeviceCode(store.createDeviceCode(60_000).device_code, 1, 'repro');
res = await app.request('http://localhost/api/cli/me', { headers: { authorization: `Bearer ${token}` } });
if (res.status !== 200) fail(`valid CLI token rejected: ${res.status}`);
store.revokeCliToken(token);
res = await app.request('http://localhost/api/cli/me', { headers: { authorization: `Bearer ${token}` } });
if (res.status !== 401) fail(`revoked CLI token accepted: ${res.status}`);

const cols = store.db.query<{ name: string }, []>('PRAGMA table_info(cli_tokens)').all();
if (!cols.some((c) => c.name === 'expires_at')) fail('cli_tokens has no expiry column');
const token2 = store.approveDeviceCode(store.createDeviceCode(60_000).device_code, 1, 'repro-exp');
store.db.query('UPDATE cli_tokens SET expires_at = ? WHERE token = ?').run('2000-01-01T00:00:00.000Z', token2);
res = await app.request('http://localhost/api/cli/me', { headers: { authorization: `Bearer ${token2}` } });
if (res.status !== 401) fail(`expired CLI token accepted: ${res.status}`);

console.log('OK: credentials expire and revoke');
store.close();
