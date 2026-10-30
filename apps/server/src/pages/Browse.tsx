import type { FC } from 'hono/jsx';

/** Search box + results container; the Layout client script does the fetching. */
export const Browse: FC<{ placeholder?: string }> = ({ placeholder }) => (
  <>
    <form id="search-form" class="search" action="/api/repos/search" method="get">
      <input type="search" name="q" placeholder={placeholder ?? 'Search GitHub, e.g. "hono" or "org:anthropics"'} autocomplete="off" />
      <button class="btn" type="submit">
        Search
      </button>
    </form>
    <div id="search-results" />
  </>
);
