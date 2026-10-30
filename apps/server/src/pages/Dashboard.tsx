import type { FC } from 'hono/jsx';
import type { Me, RepoCard, SelectedRepo, StoredRunReport } from '@idlehand/shared';
import { Layout } from './Layout.tsx';
import { RepoCardView, RepoGrid } from './RepoCard.tsx';
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
  <Layout me={me} title="Dashboard" active="dashboard">
    <div class="page-heading">
      <span class="eyebrow">Your contribution space</span>
      <h1>A little help from you, {me.name || me.login}.</h1>
      <p class="lead">Choose where your spare credits go. Your local runner takes it from here.</p>
    </div>
    <section class="setup panel" aria-labelledby="setup-title">
      <div>
        <span class="eyebrow">Start here</span><h2 id="setup-title">Your first contribution.</h2>
        <ol class="checklist">
          <li><span class="check" id="choose-step">{selected.length ? '✓' : '1'}</span><span><a href="#included">Choose a repository</a><br />Include your own project or find a public one below.</span></li>
          <li><span class="check">2</span><span>Connect the CLI<br />With Idlehand installed, run the login command and confirm its code in your browser.</span></li>
          <li><span class="check">3</span><span>Preview, then contribute<br />Check the plan before starting with a small budget.</span></li>
        </ol>
      </div>
      <div>
        <div class="command"><code>{`idlehand login --server ${baseUrl}`}</code><button class="btn small" type="button" data-copy={`idlehand login --server ${baseUrl}`} aria-label="Copy CLI login command">Copy</button></div>
        <div class="command"><code>idlehand run --dry-run</code><button class="btn small" type="button" data-copy="idlehand run --dry-run" aria-label="Copy preview command">Copy</button></div>
        <div class="command"><code>idlehand run --budget '$2'</code><button class="btn small" type="button" data-copy="idlehand run --budget '$2'" aria-label="Copy contribution command">Copy</button></div>
        <p class="fine-print">Requires the Idlehand CLI, GitHub CLI, and Claude Code or Codex, installed and signed in on your machine. Dollar budgets measure usage at list prices; Codex cost is estimated.</p>
      </div>
    </section>
    <nav class="section-nav" aria-label="Dashboard sections"><a href="#included">Included repos</a><a href="#your-repos">Your repos</a><a href="#discover">Find a project</a></nav>
    <section id="included" class="section">
      <div class="section-heading"><h2>Included repos <span id="included-count" class="pill">{selected.length}</span></h2><span class="muted">Used by your next local run</span></div>
      <div id="included-grid" class="grid">{selected.map((repo) => <RepoCardView repo={repo} signedIn runs={runsFor(repo.fullName)} />)}</div>
      <div id="included-empty" class="empty" hidden={selected.length > 0}><h3>Your shortlist starts here.</h3><p>Include a repository below, or <a href="#discover">search for a project</a> you’d like to support.</p></div>
    </section>
    <section id="your-repos" class="section">
      <div class="section-heading"><h2>Your repositories</h2><span class="muted">From your GitHub account</span></div>
      {reposError ? <div class="empty" role="alert"><h3>GitHub repositories are unavailable.</h3><p>Your saved list is still here. <a href={`/dashboard?page=${page}`}>Try loading again</a> or <a href="/login?next=%2Fdashboard">reconnect GitHub</a>.</p></div> : <RepoGrid repos={mine} signedIn empty={page > 1 ? 'No more repositories on this page. Go back to see earlier results.' : 'No repositories on this account yet. You can still include public projects below.'} />}
      {!reposError && (page > 1 || hasMore) ? <nav class="pager" aria-label="Repository pages">
        {page > 1 ? <a class="btn small" href={`/dashboard?page=${page - 1}#your-repos`}>← Previous</a> : null}
        <span class="muted" aria-current="page">Page {page}</span>
        {hasMore ? <a class="btn small" href={`/dashboard?page=${page + 1}#your-repos`}>Next →</a> : null}
      </nav> : null}
    </section>
    <section id="discover" class="section">
      <div class="section-heading"><div><span class="eyebrow">Open source is better together</span><h2>Find another project.</h2></div><a class="text-link" href="/popular">Explore popular repos →</a></div>
      <Browse />
    </section>
  </Layout>
);
