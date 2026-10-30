import { Hono } from 'hono';
import type { ServerConfig } from './config.ts';
import type { Store, UserRow } from './db.ts';
import type { GitHubClient } from './github.ts';
import { readSessionUserId, type SessionOpts } from './session.ts';
import { authRoutes } from './routes/auth.ts';
import { apiRoutes } from './routes/api.ts';
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
    await next();
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/', authRoutes());
  app.route('/', apiRoutes());
  app.route('/', pageRoutes());

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.text('Not found', 404)));
  app.onError((err, c) => {
    console.error(err);
    const msg = err instanceof Error ? err.message : 'internal error';
    return c.req.path.startsWith('/api/') ? c.json({ error: msg }, 500) : c.text(`Error: ${msg}`, 500);
  });
  return app;
}
