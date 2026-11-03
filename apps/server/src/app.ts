import { html } from 'hono/html';
import { Hono } from 'hono';
import type { ServerConfig } from './config.ts';
import type { Store, UserRow } from './db.ts';
import type { GitHubClient } from './github.ts';
import { readSessionUserId, type SessionOpts } from './session.ts';
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
    const uid = await readSessionUserId(c, session);
    c.set('user', uid == null ? null : deps.store.getUser(uid));
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
    return c.req.path.startsWith('/api/') ? c.json({ error: 'internal error' }, 500) : c.html(html`${Message({ title: 'Something interrupted that.', description: 'We couldn’t load this page. Please try again in a moment.' })}`, 500);
  });
  return app;
}
