import type { FC } from 'hono/jsx';
import type { Me, RepoCard, SelectedRepo, StoredRunReport } from '@idlehand/shared';
import { Layout } from './Layout.tsx';
import { RepoGrid } from './RepoCard.tsx';
import { Browse } from './Browse.tsx';

export const Dashboard: FC<{
  me: Me;
  baseUrl: string;
  selected: SelectedRepo[];
  mine: RepoCard[];
  page: number;
  hasMore: boolean;
  reposError: string | null;
  runsFor: (fullName: string) => StoredRunReport[];
}> = ({ me, baseUrl, selected, mine, page, hasMore, reposError, runsFor }) => (
  <Layout me={me} title="Dashboard">
    <h1>Hi, {me.name ?? me.login}.</h1>
    <p class="lead">Pick the repositories your local Idlehand node should contribute to. Everything runs on your machine with your own GitHub login.</p>

    <h2>Connect your CLI</h2>
    <pre>{`idlehand login --server ${baseUrl}\nidlehand run --budget 10%`}</pre>

    <h2>Included repos</h2>
    <RepoGrid repos={selected} signedIn empty="You have not included any repos yet. Toggle some below." runsFor={runsFor} />

    <h2>Your repos</h2>
    {reposError ? <div class="empty">Could not load your GitHub repos: {reposError}</div> : <RepoGrid repos={mine} signedIn empty="No repositories found on your account." />}
    <div class="pager">
      {page > 1 ? (
        <a class="btn small" href={`/dashboard?page=${page - 1}`}>
          ← Previous
        </a>
      ) : null}
      <span class="muted">Page {page}</span>
      {hasMore ? (
        <a class="btn small" href={`/dashboard?page=${page + 1}`}>
          Next →
        </a>
      ) : null}
    </div>

    <h2>Add any repo</h2>
    <p class="muted">Include a public repository you do not own, or browse the <a href="/popular">popular list</a>.</p>
    <Browse />
  </Layout>
);
