import { html } from 'hono/html';
import { Hono } from 'hono';
import type { ServerConfig } from './config.ts';
import type { Store, UserRow } from './db.ts';
import type { GitHubClient } from './github.ts';
import { readSession, type SessionOpts } from './session.ts';
import { authRoutes } from './routes/auth.tsx';
import { apiRoutes } from './routes/api.ts';
import { Message } from './pages/Message.tsx';
import { pageRoutes } from './routes/pages.tsx';

export interface AppDeps {
  config: ServerConfig;
  store: Store;
  github: GitHubClient;
}

export type AppEnv = {
  Variables: {
    user: UserRow | null;
    deps: AppDeps;
    session: SessionOpts;
  };
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const session: SessionOpts = { secret: deps.config.sessionSecret, secure: deps.config.baseUrl.startsWith('https://') };

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('session', session);
    const payload = await readSession(c, session);
    const row = payload == null ? null : deps.store.getUser(payload.userId);
    c.set('user', payload && row && row.session_version === payload.version ? row : null);
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/', authRoutes());
  app.route('/', apiRoutes());
  app.route('/', pageRoutes());

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.html(html`${Message({ title: 'This page wandered off.', description: 'The link may have changed. Head back home or explore a project to support.' })}`, 404)));
  app.onError((err, c) => {
    console.error(err);
    const msg = err instanceof Error ? err.message : 'internal error';
    return c.req.path.startsWith('/api/') ? c.json({ error: msg }, 500) : c.html(html`${Message({ title: 'Something interrupted that.', description: 'We couldn’t load this page. Please try again in a moment.' })}`, 500);
  });
  return app;
}
