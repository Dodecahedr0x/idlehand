import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { clearSession, newState, readStateCookie, safeNext, setSession, setStateCookie } from '../session.ts';

export function authRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/auth/github', async (c) => {
    const { config } = c.get('deps');
    if (!config.githubClientId) return c.text('GitHub OAuth is not configured (GITHUB_CLIENT_ID missing). See .env.example', 500);
    const next = safeNext(c.req.query('next'));
    const state = newState();
    await setStateCookie(c, c.get('session'), state, next);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', config.githubClientId);
    url.searchParams.set('redirect_uri', `${config.baseUrl}/auth/github/callback`);
    url.searchParams.set('scope', config.githubScopes.replace(/,/g, ' '));
    url.searchParams.set('state', state);
    return c.redirect(url.toString());
  });

  r.get('/auth/github/callback', async (c) => {
    const { config, store, github } = c.get('deps');
    const code = c.req.query('code');
    const state = c.req.query('state');
    const saved = await readStateCookie(c, c.get('session'));
    if (!code || !state || !saved || saved.state !== state) return c.text('OAuth state mismatch. Please try signing in again.', 400);
    const token = await github.exchangeCode(code);
    const ghUser = await github.getUser(token);
    const user = store.upsertUser({ id: ghUser.id, login: ghUser.login, name: ghUser.name, avatarUrl: ghUser.avatarUrl, accessToken: token });
    await setSession(c, c.get('session'), user.id);
    void config;
    return c.redirect(safeNext(saved.next));
  });

  // Dev-only login without OAuth so the UI can be exercised locally.
  r.get('/auth/dev', async (c) => {
    const { config, store } = c.get('deps');
    if (!config.devLogin) return c.text('Not found', 404);
    const login = (c.req.query('login') ?? 'octocat').replace(/[^A-Za-z0-9-]/g, '');
    if (!login) return c.text('bad login', 400);
    // Stable fake id derived from the login so repeated dev logins hit the same row.
    let hash = 0;
    for (const ch of login) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const id = 900_000_000 + (hash % 90_000_000);
    const user = store.upsertUser({ id, login, name: login, avatarUrl: `https://github.com/${login}.png`, accessToken: null });
    await setSession(c, c.get('session'), user.id);
    return c.redirect(safeNext(c.req.query('next')));
  });

  const logout = (c: any) => {
    clearSession(c);
    return c.redirect('/');
  };
  r.post('/logout', logout);
  r.get('/logout', logout);

  return r;
}
