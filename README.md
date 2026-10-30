# Idlehand

Point your leftover Claude Code or Codex credits at open source.

You register GitHub repos on the Idlehand web service (yours, or any public repo you care about). On your own machine, `idlehand run` spends a budget you set by spawning your local `claude` or `codex` as a contributor. Nothing is billed separately: it uses the subscription you already pay for, and stops when the budget is reached.

```
idlehand run --budget 10%        # 10% of your subscription this run
idlehand run --budget '$5'       # five dollars of list-price usage
idlehand run --budget remaining  # keep going until the provider says stop
```

## What a run does, in priority order

1. **Review open pull requests.** Checks out the PR, reads the full diff and surrounding code, runs the test suite, posts a review. If the GitHub account has push rights, the PR is approved and marked safe-to-merge by the agent, the runner's own re-run of the tests is green, and GitHub reports the PR mergeable with green checks, it merges. Set `policy.merge never` to only review.
2. **Work open issues.** Reproduces the issue first, fixes it on a branch, adds a test, then opens a PR. If the account cannot push, it pushes to a fork.
3. **Review the codebase** for real, reproducible defects and files them as issues (at most every 72 hours per repo).

The budget is checked before every task and passed down to the agent as a hard dollar cap, so a single task cannot overshoot.

## No hallucinated issues

The agent is never trusted on its word. Every claim comes with a shell command, and the runner re-runs that command itself before anything reaches GitHub:

- A **codebase finding** becomes an issue only if its reproduction command fails the way the agent said it does, on a clean checkout. The issue body contains the exact command, the expected signal, and the output the runner observed.
- An **issue fix** becomes a PR only if the reproduction command fails on the default branch, passes on the fix branch, and the test command passes on the fix branch. The PR summary contains a Reproduction section with before and after output, plus the test output.
- A **PR review** can only approve if the runner re-ran the test command and it passed. Otherwise the verdict is downgraded to a comment.

Findings that do not survive are logged as `unverified` and discarded. Commands that would touch GitHub, use sudo, or delete outside the checkout are rejected before they run.

## Layout

| Path | What |
| --- | --- |
| `apps/server` | Web service and UI: GitHub sign-in, pick repos, browse and add any public repo, most-included repos, CLI login approval, run reports. Bun, Hono, SQLite. |
| `apps/cli` | The `idlehand` CLI: Ink dashboard in a terminal, `--plain` or `--json` line output for scripts and agents. Bun, commander, Ink. |
| `packages/shared` | Budget model and API types shared by both. |

## Quick start

Prerequisites: [Bun](https://bun.sh), the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`), and Claude Code or Codex installed and logged in.

```sh
bun install

# 1. Web service (see apps/server/.env.example for the GitHub OAuth app)
bun run server                      # http://localhost:8787

# 2. CLI, on the machine whose credits you want to spend
bun run cli doctor                  # checks gh, claude/codex, server
bun run cli login                   # approve the code in the browser
bun run cli config set subscription.monthlyUsd 200   # needed for percent budgets
bun run cli run --dry-run           # see what it would do, spend nothing
bun run cli run --budget '$2'
```

To build a standalone binary: `bun run --cwd apps/cli build` writes `apps/cli/dist/idlehand`.
The standalone build excludes Ink's optional React DevTools connection.

Without the web service, add repos locally: `idlehand repos add owner/name`.

## CLI reference

```
idlehand login [--server URL]        connect this machine to your account
idlehand logout
idlehand config show|get|set|keys    settings live in ~/.idlehand/config.json
idlehand repos [list|add|remove]     selections from the server plus local repos
idlehand run [options]               spend the budget
    -b, --budget   '$10' | '10%' | '3 tasks' | '45m' | 'remaining'
    -p, --provider claude | codex
    -r, --repo     owner/name ...      restrict this run
    --only         review-pr,fix-issue,review-codebase
    --once         stop after one task
    --dry-run      plan only
idlehand status [--limit 15]         spend this month and recent tasks (-n also works)
idlehand doctor                      environment checks
```

Run `idlehand` for a quick start, or `idlehand <command> --help` for examples. Bare `idlehand config` shows the effective settings, with the token redacted. Quote dollar budgets with **single quotes** (for example, `--budget '$2'`) so the shell does not expand the dollar sign.

Global flags: `--plain` for line output, `--json` for one JSON value per line. Without terminal input and output the CLI picks `--plain` automatically. In JSON mode, errors and warnings are JSON records on stderr, leaving stdout available for command results and run events. Exit codes are `0` for success, `1` for a command or setup error, and `2` when one or more run tasks failed. `doctor` uses the same exit status in human and JSON modes; an unavailable server or unselected provider is optional.

Use `--dry-run` to preview the queue using your GitHub login. It does not require Claude Code or Codex, spend credits, change saved task outcomes, or prune checkouts. During a run, press **Ctrl+C** (or **q** in the dashboard) to stop after the current task finishes; no further tasks start. The dashboard shows live elapsed time and marks estimated spending with `≈`.

Useful settings (`idlehand config keys` lists them all):

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `claude` | Which agent CLI to spawn. |
| `budget` | `$5` | Default budget for `run`. |
| `subscription.monthlyUsd` | unset | What your plan is worth per month; required for `10%`-style budgets. |
| `policy.merge` | `when-authorized` | `never` to review without merging. |
| `policy.issueLabels` | any | Only attempt issues with one of these labels, e.g. `bug,help wanted`. |
| `policy.maxIssuesPerReview` | 3 | Cap on issues filed per codebase review. |
| `policy.commentOnIssues` | false | Comment when an issue cannot be reproduced or is not a bug. |
| `claude.permissionMode` | `acceptEdits` | Agents run inside a throwaway checkout; `bypassPermissions` is available if you accept the risk. |
| `codex.pricing.*` | GPT-5 list | Codex reports tokens, not dollars, so its spend is an estimate. |

## How budgets are measured

Claude Code reports `total_cost_usd` for each headless run, so dollar and percent budgets are exact at list price. Codex reports tokens only; the CLI estimates dollars with the configured price table and marks those figures with `≈`. Neither CLI exposes a subscription's live quota, so `10%` means ten percent of the monthly value you declare. `remaining` means no cap of our own: the run ends when the provider refuses to continue or there is no more work.

## Opting out

Maintainers who do not want Idlehand contributions can add a `no-idlehand` label to a PR. Every issue, PR and review carries a footer saying it came from an Idlehand node and that the runner re-verified the claim.

## Development

```sh
bun test                              # shared, server and cli unit tests
bun run typecheck
bun test apps/server                  # includes an end-to-end device-login flow
```
