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
IDLEHAND_DEV_LOGIN=1 bun run --cwd apps/server dev
open http://localhost:8787/auth/dev?login=octocat
```

Dev-login users see that login's public repos. Do not enable this in production.

## Tests

```sh
bun test apps/server
```

## Endpoints

- Pages: `/`, `/dashboard`, `/popular`, `/cli/approve?code=…`, `/logout`
- Auth: `/auth/github`, `/auth/github/callback`, `/auth/dev` (dev only)
- Browser API (cookie + `X-Requested-With: fetch` on mutations): `/api/me`, `/api/me/repos?page=`, `/api/selections` (GET/POST/DELETE `/:owner/:name`), `/api/repos/popular`, `/api/repos/search?q=`
- CLI device login: `POST /api/cli/codes`, `GET /api/cli/codes/:deviceCode`
- CLI API (`Authorization: Bearer <token>`): `/api/cli/me`, `/api/cli/repos`, `/api/cli/runs` (GET/POST)
- `/healthz`
