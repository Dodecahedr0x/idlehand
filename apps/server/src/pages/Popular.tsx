import type { FC } from 'hono/jsx';
import type { Me, PopularRepo } from '@idlehand/shared';
import { Layout } from './Layout.tsx';
import { RepoGrid } from './RepoCard.tsx';
import { Browse } from './Browse.tsx';

export const Popular: FC<{ me: Me | null; popular: PopularRepo[] }> = ({ me, popular }) => (
  <Layout me={me} title="Explore" active="popular">
    <div class="page-heading"><span class="eyebrow">Find your next contribution</span><h1>A little help goes a long way.</h1><p class="lead">Explore the community’s most included repositories, or find a project of your own.</p></div>
    {!me ? <div class="notice"><a href="/login?next=%2Fpopular">Sign in with GitHub</a> to save repositories for your local runner.</div> : null}
    <section class="section"><div class="section-heading"><h2>Find a repository</h2></div><Browse /></section>
    <section class="section"><div class="section-heading"><h2>Popular with the community</h2><span class="muted">Most included first</span></div><RepoGrid repos={popular} signedIn={!!me} empty="No projects here yet. Search above to find one you care about." /></section>
  </Layout>
);
