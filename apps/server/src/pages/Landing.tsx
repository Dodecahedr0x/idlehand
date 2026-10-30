import type { FC } from 'hono/jsx';
import type { Me, PopularRepo } from '@idlehand/shared';
import { Layout } from './Layout.tsx';
import { RepoGrid } from './RepoCard.tsx';

export const Landing: FC<{ me: Me | null; popular: PopularRepo[] }> = ({ me, popular }) => (
  <Layout me={me}>
    <h1>Put idle credits to work.</h1>
    <p class="lead">
      Point your leftover Claude Code / Codex credits at open source. Register repos here, then run <code>idlehand run</code> on your own
      machine: it reviews pull requests first, then works open issues, then reviews the codebase, and stops at the budget you set.
    </p>
    <p>
      {me ? (
        <a class="btn primary" href="/dashboard">
          Open dashboard
        </a>
      ) : (
        <a class="btn primary" href="/auth/github">
          Sign in with GitHub
        </a>
      )}{' '}
      <a class="btn" href="/popular">
        Browse popular repos
      </a>
    </p>
    <h2>Most included repos</h2>
    <RepoGrid repos={popular} signedIn={!!me} empty="No repos have been included yet. Sign in and be the first." />
  </Layout>
);
