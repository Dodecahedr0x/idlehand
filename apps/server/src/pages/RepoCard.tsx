import type { FC } from 'hono/jsx';
import type { RepoCard as Card, StoredRunReport } from '@idlehand/shared';

const GOOD = new Set(['reviewed', 'merged', 'pr-opened', 'issues-filed']);
const MEH = new Set(['nothing-found', 'unverified']);
const LABELS: Record<string, string> = {
  reviewed: 'Reviewed', merged: 'Merged', 'pr-opened': 'PR opened', 'issues-filed': 'Issues filed',
  'nothing-found': 'No changes needed', unverified: 'Could not verify', failed: 'Failed',
  'review-pr': 'Pull request review', 'fix-issue': 'Issue fix', 'review-codebase': 'Codebase review',
};

export const RunList: FC<{ runs: StoredRunReport[] }> = ({ runs }) =>
  runs.length === 0 ? <p class="fine-print">No activity yet. Reports will appear after a local run.</p> : (
    <ul class="runs" aria-label="Recent contributions">
      {runs.map((r) => (
        <li>
          <div class="run-meta"><span class={`outcome ${GOOD.has(r.outcome) ? 'good' : MEH.has(r.outcome) ? 'meh' : 'bad'}`}>{LABELS[r.outcome] ?? r.outcome}</span><span class="muted">{LABELS[r.kind] ?? r.kind}</span></div>
          <p class="run-summary">{r.summary}</p>
          <div class="run-meta">
            {r.url ? <a href={r.url} target="_blank" rel="noopener">View on GitHub ↗</a> : null}
            <span class="muted">{r.costEstimated ? '≈' : ''}${r.costUsd.toFixed(2)} · {r.provider}</span>
            <time class="muted" dateTime={r.startedAt}>{r.startedAt.slice(0, 10)}</time>
          </div>
        </li>
      ))}
    </ul>
  );

export const RepoCardView: FC<{ repo: Card; signedIn: boolean; runs?: StoredRunReport[] }> = ({ repo, signedIn, runs }) => (
  <article class="card" data-repo={repo.fullName.toLowerCase()}>
    <div class="row">
      <a class="name" href={repo.htmlUrl} target="_blank" rel="noopener">{repo.fullName}</a>
      {signedIn ? <button type="button" class={`btn small toggle${repo.selected ? ' on' : ''}`} data-owner={repo.owner} data-name={repo.name} data-on={repo.selected ? '1' : '0'} aria-pressed={!!repo.selected} aria-label={`${repo.selected ? 'Remove' : 'Include'} ${repo.fullName}`}>
        {repo.selected ? 'Included ✓' : 'Include +'}
      </button> : <a class="btn small" href="/login?next=%2Fpopular" aria-label={`Sign in to include ${repo.fullName}`}>Include +</a>}
    </div>
    <div class="desc">{repo.description || 'No description provided.'}</div>
    <div class="meta">
      {repo.language ? <span><span class="dot" />{repo.language}</span> : null}
      <span aria-label={`${repo.stars} GitHub stars`}>☆ {repo.stars.toLocaleString('en-US')}</span>
      <span class="count" data-count={repo.selectedBy ?? 0}>Included by {repo.selectedBy ?? 0}</span>
      {repo.private ? <span class="pill">Private</span> : null}
    </div>
    {runs ? <RunList runs={runs} /> : null}
  </article>
);

export const RepoGrid: FC<{ repos: Card[]; signedIn: boolean; empty?: string }> = ({ repos, signedIn, empty }) =>
  repos.length === 0 ? <div class="empty">{empty ?? 'Nothing here yet.'}</div> : (
    <div class="grid">{repos.map((r) => <RepoCardView repo={r} signedIn={signedIn} />)}</div>
  );
