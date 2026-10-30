import type { FC } from 'hono/jsx';
import type { Me, PopularRepo } from '@idlehand/shared';
import { Layout } from './Layout.tsx';
import { RepoGrid } from './RepoCard.tsx';

export const Popular: FC<{ me: Me | null; popular: PopularRepo[] }> = ({ me, popular }) => (
  <Layout me={me} title="Popular">
    <h1>Popular repos</h1>
    <p class="lead">Repositories other Idlehand users have included, most-selected first.{me ? ' Include any of them with one click.' : ''}</p>
    <RepoGrid repos={popular} signedIn={!!me} empty="No repos have been included yet." />
  </Layout>
);
