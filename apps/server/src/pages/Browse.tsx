import type { FC } from 'hono/jsx';

export const Browse: FC<{ placeholder?: string }> = ({ placeholder }) => (
  <>
    <form id="search-form" class="search" action="/api/repos/search" method="get" role="search">
      <label class="sr-only" for="repo-search">Search GitHub repositories</label>
      <input id="repo-search" type="search" name="q" required maxlength={256} placeholder={placeholder ?? 'Repository name or org:your-organization'} autocomplete="off" aria-describedby="search-hint" />
      <button class="btn primary" type="submit">Search GitHub <span aria-hidden="true">→</span></button>
    </form>
    <p id="search-hint" class="fine-print">Search public projects by name, owner, or GitHub search filters.</p>
    <p id="search-status" class="muted" role="status" aria-live="polite" />
    <div id="search-results" />
  </>
);
