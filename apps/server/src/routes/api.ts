import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { PROVIDERS, type RunReport, type DeviceCodeStart, type DeviceCodePoll } from '@idlehand/shared';
import type { AppEnv } from '../app.ts';
import { repoRowToCard, userToMe, type RepoInput, type UserRow } from '../db.ts';
import { GitHubError } from '../github.ts';

const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
const KINDS = new Set(['review-pr', 'fix-issue', 'review-codebase']);
const PROVIDER_NAMES = new Set<string>(PROVIDERS);
const OUTCOMES = new Set(['reviewed', 'merged', 'closed', 'pr-opened', 'issues-filed', 'nothing-found', 'unverified', 'failed']);

/** Cookie-session guard with a cheap CSRF check for mutations. */
async function requireSession(c: Context<AppEnv>, next: Next) {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  if (c.req.method !== 'GET' && c.req.header('x-requested-with') !== 'fetch') {
    return c.json({ error: 'missing X-Requested-With: fetch header' }, 403);
  }
  await next();
}

/** Bearer CLI-token guard; sets `user`. */
async function requireBearer(c: Context<AppEnv>, next: Next) {
  const auth = c.req.header('authorization') ?? '';
  const m = auth.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i);
  if (!m) return c.json({ error: 'missing bearer token' }, 401);
  const user = c.get('deps').store.userForCliToken(m[1]!);
  if (!user) return c.json({ error: 'invalid token' }, 401);
  c.set('user', user);
  await next();
}

function tokenRejected(e: unknown): e is GitHubError {
  return e instanceof GitHubError;
}

/** Repos for a user. A read:user token cannot list private repos, so fall back to the public list. */
export async function reposForUser(c: Context<AppEnv>, user: UserRow, page: number): Promise<RepoInput[]> {
  const { github } = c.get('deps');
  if (!user.access_token) return github.listPublicReposFor(user.login, page);
  try {
    return await github.listUserRepos(user.access_token, page);
  } catch (e) {
    if (!tokenRejected(e)) throw e;
    return github.listPublicReposFor(user.login, page);
  }
}

export function apiRoutes() {
  const r = new Hono<AppEnv>();

  /* ---- browser (cookie) ---- */

  r.get('/api/me', requireSession, (c) => c.json(userToMe(c.get('user')!)));

  r.get('/api/me/repos', requireSession, async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user')!;
    const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
    const inputs = await reposForUser(c, user, page);
    const cards = inputs.map((i) => repoRowToCard(store.upsertRepo(i)));
    return c.json(store.decorateCards(cards, user.id));
  });

  r.get('/api/selections', requireSession, (c) => {
    const { store } = c.get('deps');
    return c.json(store.listSelections(c.get('user')!.id));
  });

  r.post('/api/selections', requireSession, async (c) => {
    const { store, github } = c.get('deps');
    const user = c.get('user')!;
    const body = (await c.req.json().catch(() => null)) as { owner?: string; name?: string } | null;
    const owner = body?.owner?.trim();
    const name = body?.name?.trim();
    if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return c.json({ error: 'owner and name required' }, 400);
    // A read:user token is rejected for repository reads. The public repo is still includeable.
    let input: RepoInput | null = null;
    try {
      input = await github.getRepo(owner, name, user.access_token);
    } catch (e) {
      if (!user.access_token || !tokenRejected(e)) throw e;
    }
    if (!input && user.access_token) input = await github.getRepo(owner, name, null);
    if (!input) return c.json({ error: `repo ${owner}/${name} not found on GitHub` }, 404);
    const row = store.upsertRepo(input);
    store.addSelection(user.id, row.id);
    const sel = store.listSelections(user.id).find((s) => s.fullName.toLowerCase() === row.full_name.toLowerCase());
    return c.json(sel, 201);
  });

  r.delete('/api/selections/:owner/:name', requireSession, (c) => {
    const { store } = c.get('deps');
    const row = store.getRepoByFullName(`${c.req.param('owner')}/${c.req.param('name')}`);
    if (!row) return c.json({ error: 'not found' }, 404);
    const removed = store.removeSelection(c.get('user')!.id, row.id);
    return removed ? c.json({ ok: true }) : c.json({ error: 'not selected' }, 404);
  });

  r.get('/api/repos/popular', (c) => {
    const { store } = c.get('deps');
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    return c.json(store.listPopular(limit, c.get('user')?.id ?? null));
  });

  r.get('/api/repos/search', async (c) => {
    const { store, github } = c.get('deps');
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json([]);
    const user = c.get('user');
    let inputs: RepoInput[];
    try {
      inputs = await github.searchRepos(q, user?.access_token);
    } catch (e) {
      if (!user?.access_token || !tokenRejected(e)) throw e;
      inputs = await github.searchRepos(q, null);
    }
    const cards = inputs.map((i) => repoRowToCard(store.upsertRepo(i)));
    return c.json(store.decorateCards(cards, user?.id ?? null));
  });

  /* ---- CLI device flow (no auth) ---- */

  r.post('/api/cli/codes', (c) => {
    const { store, config } = c.get('deps');
    const row = store.createDeviceCode(DEVICE_CODE_TTL_MS);
    const out: DeviceCodeStart = {
      deviceCode: row.device_code,
      userCode: row.user_code,
      verificationUrl: `${config.baseUrl}/cli/approve?code=${encodeURIComponent(row.user_code)}`,
      expiresAt: row.expires_at,
      interval: 3,
    };
    return c.json(out, 201);
  });

  r.get('/api/cli/codes/:deviceCode', (c) => {
    const { store } = c.get('deps');
    const row = store.getDeviceCode(c.req.param('deviceCode'));
    if (!row) return c.json({ error: 'unknown or already consumed device code' }, 404);
    let out: DeviceCodePoll;
    switch (row.status) {
      case 'pending':
        out = { status: 'pending' };
        break;
      case 'expired':
        out = { status: 'expired' };
        break;
      case 'denied':
        store.consumeDeviceCode(row.device_code);
        out = { status: 'denied' };
        break;
      case 'approved': {
        const user = row.user_id == null ? null : store.getUser(row.user_id);
        if (!row.token || !user) return c.json({ error: 'approval record incomplete' }, 500);
        store.consumeDeviceCode(row.device_code);
        out = { status: 'approved', token: row.token, login: user.login };
        break;
      }
    }
    return c.json(out);
  });

  /* ---- CLI (bearer) ---- */

  r.get('/api/cli/me', requireBearer, (c) => c.json(userToMe(c.get('user')!)));

  r.get('/api/cli/repos', requireBearer, (c) => c.json(c.get('deps').store.listSelections(c.get('user')!.id)));

  r.get('/api/cli/runs', requireBearer, (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    return c.json(c.get('deps').store.listRunReportsForUser(c.get('user')!.id, limit));
  });

  r.post('/api/cli/runs', requireBearer, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<RunReport> | null;
    const err = validateRunReport(body);
    if (err) return c.json({ error: err }, 400);
    const report = body as RunReport;
    const stored = c.get('deps').store.addRunReport(c.get('user')!.id, {
      ...report,
      repo: { ...report.repo, fullName: report.repo.fullName || `${report.repo.owner}/${report.repo.name}` },
      summary: report.summary.slice(0, 2000),
      url: report.url ?? null,
      costUsd: Number(report.costUsd) || 0,
      costEstimated: !!report.costEstimated,
      costUnknown: !!report.costUnknown,
      durationMs: Number(report.durationMs) || 0,
      startedAt: report.startedAt || new Date().toISOString(),
    });
    return c.json(stored, 201);
  });

  return r;
}

function validateRunReport(b: Partial<RunReport> | null): string | null {
  if (!b || typeof b !== 'object') return 'body must be a JSON RunReport';
  if (!b.repo || typeof b.repo.owner !== 'string' || typeof b.repo.name !== 'string') return 'repo.owner and repo.name required';
  if (!b.kind || !KINDS.has(b.kind)) return `kind must be one of ${[...KINDS].join(', ')}`;
  if (!b.provider || !PROVIDER_NAMES.has(b.provider)) return `provider must be one of ${PROVIDERS.join(', ')}`;
  if (!b.outcome || !OUTCOMES.has(b.outcome)) return `outcome must be one of ${[...OUTCOMES].join(', ')}`;
  if (typeof b.summary !== 'string') return 'summary required';
  if (b.costUnknown !== undefined && typeof b.costUnknown !== 'boolean') return 'costUnknown must be a boolean';
  if (typeof b.costUsd !== 'number' || !Number.isFinite(b.costUsd) || b.costUsd < 0) return 'costUsd must be a finite nonnegative number';
  if (b.url != null && typeof b.url !== 'string') return 'url must be a string or null';
  return null;
}
