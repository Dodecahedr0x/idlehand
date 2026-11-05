import type { FC } from 'hono/jsx';
import type { Me, RepoCard, SelectedRepo, StoredRunReport, TaskOutcome } from '@idlehand/shared';
import { Layout } from './Layout.tsx';
import { RepoCardView, RepoGrid } from './RepoCard.tsx';
import { Browse } from './Browse.tsx';

export const Dashboard: FC<{
  me: Me;
  baseUrl: string;
  cliConnected: boolean;
  contributionOutcome: TaskOutcome | null;
  selected: SelectedRepo[];
  mine: RepoCard[];
  page: number;
  hasMore: boolean;
  reposError: string | null;
  runsFor: (fullName: string) => StoredRunReport[];
}> = ({ me, baseUrl, cliConnected, contributionOutcome, selected, mine, page, hasMore, reposError, runsFor }) => {
  const contributed = contributionOutcome !== null && !['failed', 'unverified', 'nothing-found'].includes(contributionOutcome);
  return (
    <Layout me={me} title="Dashboard" active="dashboard">
      <div class="page-heading">
        <span class="eyebrow">Your contribution space</span>
        <h1>A little help from you, {me.name || me.login}.</h1>
        <p class="lead">Choose where your spare credits go. Your local runner takes it from here.</p>
      </div>
      <details class="setup panel" id="setup-title">
        <summary>
          <span class="setup-label"><span class="eyebrow">Start here</span><h2>Your first contribution.</h2></span>
        </summary>
        <div class="setup-body">
          <div>
          <ol class="checklist">
            <li><span class="check" id="choose-step">{selected.length ? '✓' : '1'}</span><span><a href="#included">Choose a repository</a><br />Include your own project or find a public one below.</span></li>
            <li><span class="check">{cliConnected ? '✓' : '2'}</span><span><a href="/install">Install the CLI</a><br />Build Idlehand for your machine with our installation guide.</span></li>
            <li><span class="check">{cliConnected ? '✓' : '3'}</span><span><strong>{cliConnected ? 'CLI connected' : 'CLI not connected yet'}</strong><br />{cliConnected ? 'A CLI has authenticated with this account. This does not mean it is running now.' : 'Run the login command, confirm its browser code, then run idlehand doctor.'}</span></li>
            <li><span class="check">{contributed ? '✓' : '4'}</span><span><strong>{contributed ? 'First contribution completed' : contributionOutcome === 'nothing-found' ? 'First check completed' : 'Preview, then contribute'}</strong><br />{contributed ? 'Your local runner has reported a verified contribution.' : contributionOutcome === 'failed' ? 'Your last task failed. Check its terminal output, run idlehand doctor, and try again.' : contributionOutcome === 'unverified' ? 'Your last result could not be verified. No contribution was published; try another task.' : contributionOutcome === 'nothing-found' ? 'Your runner found nothing actionable. Include another repository or try again later.' : 'Check the plan before starting with a small budget.'}</span></li>
          </ol>
          <a class="text-link" href="/dashboard#setup-title">Refresh setup status →</a>
          </div>
          <div>
          <p class="fine-print">After <a href="/install">installing Idlehand</a>, connect and check your setup:</p>
          <div class="command"><code>{`idlehand login --server ${baseUrl}`}</code><button class="btn small" type="button" data-copy={`idlehand login --server ${baseUrl}`} aria-label="Copy CLI login command">Copy</button></div>
          <div class="command"><code>idlehand doctor</code><button class="btn small" type="button" data-copy="idlehand doctor" aria-label="Copy setup check command">Copy</button></div>
          <div class="command"><code>idlehand run --dry-run</code><button class="btn small" type="button" data-copy="idlehand run --dry-run" aria-label="Copy preview command">Copy</button></div>
          <p class="fine-print">First contribution with Claude Code:</p>
          <div class="command"><code>idlehand run --provider claude --budget '$2' --once</code><button class="btn small" type="button" data-copy="idlehand run --provider claude --budget '$2' --once" aria-label="Copy Claude contribution command">Copy</button></div>
          <p class="fine-print">Or one task with Codex or the Cursor CLI:</p>
          <div class="command"><code>idlehand run --provider codex --budget '1 task' --once</code><button class="btn small" type="button" data-copy="idlehand run --provider codex --budget '1 task' --once" aria-label="Copy Codex contribution command">Copy</button></div>
          <div class="command"><code>idlehand run --provider cursor --budget '1 task' --once</code><button class="btn small" type="button" data-copy="idlehand run --provider cursor --budget '1 task' --once" aria-label="Copy Cursor contribution command">Copy</button></div>
          <p class="fine-print">Claude dollar budgets use an estimated spending threshold; in-flight calls can exceed it, so leave headroom. Codex and Cursor spending is estimated and has no dollar cap; one task can vary in cost. Setup status updates when you refresh, using reports from your account.</p>
          </div>
        </div>
      </details>
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
};
