import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { repoRowToCard, userToMe } from '../db.ts';
import { reposForUser } from './api.ts';
import { Landing } from '../pages/Landing.tsx';
import { Popular } from '../pages/Popular.tsx';
import { Dashboard } from '../pages/Dashboard.tsx';
import { Install } from '../pages/Install.tsx';
import { SignIn } from '../pages/Message.tsx';
import { safeNext } from '../session.ts';
import { CliApprove } from '../pages/CliApprove.tsx';

export function pageRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/login', (c) => {
    const user = c.get('user');
    return c.html(<SignIn next={safeNext(c.req.query('next'))} me={user ? userToMe(user) : null} />);
  });

  r.get('/', (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    return c.html(<Landing me={user ? userToMe(user) : null} popular={store.listPopular(12, user?.id ?? null)} />);
  });

  r.get('/popular', (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    return c.html(<Popular me={user ? userToMe(user) : null} popular={store.listPopular(200, user?.id ?? null)} />);
  });

  r.get('/install', (c) => {
    const user = c.get('user');
    return c.html(<Install me={user ? userToMe(user) : null} />);
  });

  r.get('/dashboard', async (c) => {
    const user = c.get('user');
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(c.req.path + new URL(c.req.url).search)}`);
    const { store, config } = c.get('deps');
    const page = Math.min(1000, Math.max(1, Math.floor(Number(c.req.query('page') ?? 1) || 1)));
    let mine: ReturnType<typeof repoRowToCard>[] = [];
    let reposError: string | null = null;
    try {
      const inputs = await reposForUser(c, user, page);
      mine = store.decorateCards(inputs.map((i) => repoRowToCard(store.upsertRepo(i))), user.id);
    } catch (e) {
      reposError = e instanceof Error ? e.message : String(e);
    }
    return c.html(
      <Dashboard
        me={userToMe(user)}
        baseUrl={config.baseUrl}
        {...store.getSetupStatus(user.id)}
        selected={store.listSelections(user.id)}
        mine={mine}
        page={page}
        hasMore={mine.length >= 50}
        reposError={reposError}
        runsFor={(fullName) => store.listRunReportsForRepo(fullName, 5)}
      />,
    );
  });

  r.get('/cli/approve', (c) => {
    const user = c.get('user');
    const code = (c.req.query('code') ?? '').trim().toUpperCase();
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/cli/approve?code=${code}`)}`);
    const { store } = c.get('deps');
    const row = code ? store.getDeviceCodeByUserCode(code) : null;
    return c.html(<CliApprove me={userToMe(user)} userCode={code} status={row ? row.status : 'missing'} />);
  });

  r.post('/cli/approve', async (c) => {
    const user = c.get('user');
    const form = await c.req.parseBody();
    const code = String(form.userCode ?? '').trim().toUpperCase();
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/cli/approve?code=${code}`)}`);
    const { store } = c.get('deps');
    const decision = String(form.decision ?? '');
    if (decision !== 'approve' && decision !== 'deny') return c.text('Choose connect or deny.', 400);
    const row = code ? store.getDeviceCodeByUserCode(code) : null;
    if (!row || row.status !== 'pending') {
      return c.html(<CliApprove me={userToMe(user)} userCode={code} status={row ? row.status : 'missing'} />, 400);
    }
    if (decision === 'approve') {
      store.approveDeviceCode(row.device_code, user.id, `cli ${new Date().toISOString().slice(0, 10)}`);
      return c.html(<CliApprove me={userToMe(user)} userCode={code} status="approved" />);
    }
    store.denyDeviceCode(row.device_code);
    return c.html(<CliApprove me={userToMe(user)} userCode={code} status="denied" />);
  });

  return r;
}
