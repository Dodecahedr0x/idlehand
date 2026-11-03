# @idlehand/server

The Idlehand web service: GitHub sign-in, repo selection, the "most included" list, CLI login approval, and run reports posted by local nodes.

Bun + Hono + `bun:sqlite`. Pages are server-rendered with Hono JSX; there is no frontend build.

## Run

```sh
cp apps/server/.env.example apps/server/.env   # fill GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
bun run --cwd apps/server dev                  # http://localhost:8787
```

## Local testing without a GitHub OAuth app

```sh
IDLEHAND_DEV_LOGIN=1 IDLEHAND_DEV_REPO=owner/name bun run --cwd apps/server dev
open http://localhost:8787/auth/dev?login=octocat
```

Dev-login users see that login's public repos. Do not enable this in production.

## Tests

```sh
bun test apps/server
```

## Endpoints

- Pages: `/`, `/login`, `/dashboard`, `/install`, `/popular`, `/cli/approve?code=…`, `/logout`
- Auth: `/auth/github`, `/auth/github/callback`, `/auth/dev` (dev only)
- Browser API (cookie + `X-Requested-With: fetch` on mutations): `/api/me`, `/api/me/repos?page=`, `/api/selections` (GET/POST/DELETE `/:owner/:name`), `/api/repos/popular`, `/api/repos/search?q=`
- CLI device login: `POST /api/cli/codes`, `GET /api/cli/codes/:deviceCode`
- CLI API (`Authorization: Bearer <token>`): `/api/cli/me`, `/api/cli/repos`, `/api/cli/runs` (GET/POST)
- `/healthz`

## Web UX checks

`bun test apps/server` covers the OAuth callback, cancellation and retry destinations,
CLI confirmation after session expiry, and invalid or expired codes. For a browser
smoke check, use the dev login above, then include a repository from Your repos and
confirm that Included repos, its count, and both buttons update without a reload.
Remove it from Included repos, search for it again, and check the empty state and
keyboard focus. Check the same flows at a 375px viewport. Failed requests should
leave the saved selection intact and display a recovery message in the page.

GitHub OAuth still requires your own configured OAuth app for a live sign-in test.
The default sign-in scope remains `read:user`; the web app does not change the
local CLI's GitHub permissions.

The public `/install` guide downloads the published macOS and Linux CLI binaries (with SHA-256 checksums) and logs in to this server. Dashboard setup status confirms a CLI only after it authenticates with a still-present token. Successful contribution reports complete the first-contribution step; failed, unverified, and nothing-found results have separate guidance. Refresh the dashboard after login and `idlehand doctor` or a run to update that status.
