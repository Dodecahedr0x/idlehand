import type { FC } from 'hono/jsx';
import type { RepoCard as Card, StoredRunReport } from '@idlehand/shared';

const GOOD = new Set(['reviewed', 'merged', 'pr-opened', 'issues-filed']);
const MEH = new Set(['nothing-found', 'unverified']);

export const RunList: FC<{ runs: StoredRunReport[] }> = ({ runs }) =>
  runs.length === 0 ? null : (
    <ul class="runs">
      {runs.map((r) => (
        <li>
          <span class={`outcome ${GOOD.has(r.outcome) ? 'good' : MEH.has(r.outcome) ? 'meh' : 'bad'}`}>{r.outcome}</span>
          <span class="muted">{r.kind}</span>
          {r.url ? (
            <a href={r.url} target="_blank" rel="noopener">
              link
            </a>
          ) : null}
          <span class="muted">
            {r.costEstimated ? '≈' : ''}${r.costUsd.toFixed(2)} · {r.provider}
          </span>
        </li>
      ))}
    </ul>
  );

export const RepoCardView: FC<{ repo: Card; signedIn: boolean; runs?: StoredRunReport[] }> = ({ repo, signedIn, runs }) => (
  <div class="card">
    <div class="row">
      <a class="name" href={repo.htmlUrl} target="_blank" rel="noopener">
        {repo.fullName}
      </a>
      {signedIn ? (
        <button class={`btn small toggle${repo.selected ? ' on' : ''}`} data-owner={repo.owner} data-name={repo.name} data-on={repo.selected ? '1' : '0'}>
          {repo.selected ? 'Included ✓' : 'Include'}
        </button>
      ) : (
        <button class="btn small toggle" data-owner={repo.owner} data-name={repo.name} data-on="0">
          Include
        </button>
      )}
    </div>
    <div class="desc">{repo.description ?? ''}</div>
    <div class="meta">
      {repo.language ? (
        <span>
          <span class="dot" />
          {repo.language}
        </span>
      ) : null}
      <span>★ {repo.stars}</span>
      <span class="count">
        {repo.selectedBy ?? 0} user{repo.selectedBy === 1 ? '' : 's'}
      </span>
      {repo.private ? <span class="pill">private</span> : null}
    </div>
    {runs ? <RunList runs={runs} /> : null}
  </div>
);

export const RepoGrid: FC<{ repos: Card[]; signedIn: boolean; empty?: string; runsFor?: (fullName: string) => StoredRunReport[] }> = ({
  repos,
  signedIn,
  empty,
  runsFor,
}) =>
  repos.length === 0 ? (
    <div class="empty">{empty ?? 'Nothing here yet.'}</div>
  ) : (
    <div class="grid">
      {repos.map((r) => (
        <RepoCardView repo={r} signedIn={signedIn} runs={runsFor ? runsFor(r.fullName) : undefined} />
      ))}
    </div>
  );
