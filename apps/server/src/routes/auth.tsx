import { Hono } from 'hono';
import { Message } from '../pages/Message.tsx';
import type { AppEnv } from '../app.ts';
import { clearSession, newState, readStateCookie, safeNext, setSession, setStateCookie } from '../session.ts';

export function authRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/auth/github', async (c) => {
    const { config } = c.get('deps');
    const next = safeNext(c.req.query('next'));
    if (!config.githubClientId || !config.githubClientSecret) return c.html(<Message title="GitHub sign-in isn’t ready yet." description="Sign-in is temporarily unavailable. You can explore public repositories while the service is being configured." href="/popular" action="Explore repositories" />, 503);
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
    const { store, github } = c.get('deps');
    const code = c.req.query('code');
    const state = c.req.query('state');
    const saved = await readStateCookie(c, c.get('session'));
    if (!state || !saved || saved.state !== state) return c.html(<Message title="Let’s try signing in again." description="This sign-in link has expired or belongs to another browser session. Start again from this browser to continue safely." href="/login" action="Try sign-in again" />, 400);
    const next = safeNext(saved.next);
    const retry = `/login?next=${encodeURIComponent(next)}`;
    if (c.req.query('error')) return c.html(<Message title="Sign-in was cancelled." description="You haven’t connected your GitHub account. You can try again whenever you’re ready." href={retry} action="Try sign-in again" />, 400);
    if (!code) return c.html(<Message title="Sign-in didn’t finish." description="GitHub did not return a sign-in code. Please start again." href={retry} action="Try sign-in again" />, 400);
    try {
      const token = await github.exchangeCode(code);
      const ghUser = await github.getUser(token);
      const user = store.upsertUser({ id: ghUser.id, login: ghUser.login, name: ghUser.name, avatarUrl: ghUser.avatarUrl, accessToken: token });
      await setSession(c, c.get('session'), user.id, user.session_version);
      return c.redirect(next);
    } catch {
      return c.html(<Message title="We couldn’t connect to GitHub." description="Your sign-in could not be completed. Please try again in a moment; you’ll return to where you left off." href={retry} action="Try sign-in again" />, 502);
    }
  });

  // Dev-only login without OAuth so the UI can be exercised locally.
  r.get('/auth/dev', async (c) => {
    const { config, store, github } = c.get('deps');
    if (!config.devLogin) return c.text('Not found', 404);
    const login = (c.req.query('login') ?? 'octocat').replace(/[^A-Za-z0-9-]/g, '');
    if (!login) return c.text('bad login', 400);
    // Stable fake id derived from the login so repeated dev logins hit the same row.
    let hash = 0;
    for (const ch of login) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const id = 900_000_000 + (hash % 90_000_000);
    const user = store.upsertUser({ id, login, name: login, avatarUrl: `https://github.com/${login}.png`, accessToken: null });
    for (const full of config.devRepos) {
      const [owner, name] = full.split('/') as [string, string];
      let input = null;
      try { input = await github.getRepo(owner, name, null); } catch { input = null; }
      const row = store.upsertRepo(input ?? { owner, name, description: null, htmlUrl: `https://github.com/${full}`, private: false, defaultBranch: null, language: null, stars: 0 });
      store.addSelection(user.id, row.id);
    }
    await setSession(c, c.get('session'), user.id, user.session_version);
    return c.redirect(safeNext(c.req.query('next')));
  });

  const logout = async (c: any) => {
    const { store, github } = c.get('deps');
    const user = c.get('user');
    if (user) {
      const token = user.access_token;
      store.clearAccessToken(user.id);
      store.bumpSessionVersion(user.id);
      if (token && github.revokeAccessToken) {
        try {
          await github.revokeAccessToken(token);
        } catch {
          // GitHub no longer accepts this token; the local copy is already gone.
        }
      }
    }
    clearSession(c);
    return c.redirect('/');
  };
  r.post('/logout', logout);
  r.get('/logout', logout);

  return r;
}
