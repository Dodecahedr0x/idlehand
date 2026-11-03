# Idlehand

Point your leftover Claude Code, Codex, or Cursor CLI credits at open source.

You register GitHub repos on the Idlehand web service (yours, or any public repo you care about). On your own machine, `idlehand run` spends a budget you set by spawning your local `claude`, `codex`, or Cursor `agent` CLI as a contributor. Billing follows the account configured in that provider CLI. Idlehand checks the budget before each task; provider spending thresholds have the limits described below.

```
idlehand run --provider claude --budget 10%  # threshold from your declared plan value
idlehand run --provider claude --budget '$5' # five-dollar estimated-spend threshold
idlehand run --budget remaining  # keep going until the provider says stop
```

## What a run does, in priority order

1. **Review open pull requests.** Checks out the PR, reads the full diff and surrounding code, runs the test suite, posts a review. If the GitHub account has push rights, the PR is approved and marked safe-to-merge by the agent, the runner's own re-run of the tests is green, and GitHub reports the PR mergeable with green checks, it merges. Set `policy.merge never` to only review.
2. **Work open issues.** Reproduces the issue first, fixes it on a branch, adds a test, then opens a PR. If the account cannot push, it pushes to a fork.
3. **Review the codebase** for real, reproducible defects and files them as issues. A run keeps scanning until the budget is spent. `--no-continuous` makes one pass, and then waits 72 hours before reviewing that codebase again.

Dollar and percent budgets use Claude Code's native spending threshold, passing the exact remaining amount without rounding it up. In-flight calls can overshoot; leave headroom. Codex and the Cursor CLI cannot enforce a dollar threshold, so Idlehand refuses dollar and percent budgets before starting them. Choose an explicit task, time, or `remaining` budget to use either one without a dollar cap.

## No hallucinated issues

The agent is never trusted on its word. Every claim comes with a shell command, and the runner re-runs that command itself before anything reaches GitHub:

- A **codebase finding** becomes an issue only if its reproduction command fails the way the agent said it does, on a clean checkout. The issue body contains the exact command, the expected signal, and the output the runner observed.
- An **issue fix** becomes a PR only if the reproduction command fails on the default branch, passes on the fix branch, and the test command passes on the fix branch. The PR summary contains a Reproduction section with before and after output, plus the test output.
- A **PR review** can only approve if the runner re-ran the test command and it passed. Otherwise the verdict is downgraded to a comment.

Findings that do not survive are logged as `unverified` and discarded. Commands that would touch GitHub, use sudo, or delete outside the checkout are rejected before they run.

The runner executes every setup, reproduction and test command inside an OS sandbox: `sandbox-exec` on macOS, or [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`, with user namespaces enabled) on Linux. Install bubblewrap using your distribution's package manager, such as `sudo apt install bubblewrap` on Debian/Ubuntu. If the sandbox is missing or cannot start, verification fails closed and the runner cannot approve or publish that contribution.

Verification can write only inside its checkout. It gets a temporary home, no inherited credentials, and no access to your home directory. It can use the public internet, so setup commands can install the project's declared dependencies, and it cannot use your personal package caches. On macOS it also cannot connect to localhost. The runner kills each command's process group after completion or timeout. On macOS, children that deliberately start a separate session can outlive this cleanup, while retaining the filesystem and network restrictions. Linux bubblewrap also isolates the process namespace, but shares the network namespace. This boundary applies to runner verification; the contribution agent still uses its provider's configured permissions.

## Layout

| Path | What |
| --- | --- |
| `apps/server` | Web service and UI: GitHub sign-in, pick repos, browse and add any public repo, most-included repos, CLI login approval, run reports. Bun, Hono, SQLite. |
| `apps/cli` | The `idlehand` CLI: Ink dashboard in a terminal, `--plain` or `--json` line output for scripts and agents. Bun, commander, Ink. |
| `packages/shared` | Budget model and API types shared by both. |

## Quick start

Prerequisites: [Bun](https://bun.sh), the [GitHub CLI](https://cli.github.com), and Claude Code, Codex, or the [Cursor CLI](https://cursor.com/docs/cli/overview) installed and logged in. Idlehand signs the GitHub CLI in itself; you do not run `gh auth login` first.

```sh
bun install

# Local service in dev mode, with this checkout's GitHub repo already included.
# Signs in to the GitHub CLI if needed, then opens the dashboard.
bun run dev

# Keep working on that repo until the budget is spent.
bun run cli run --budget '$5'
```

Published macOS and Linux binaries (with SHA-256 checksums) are on [GitHub Releases](https://github.com/Dodecahedr0x/idlehand/releases). A version tag such as `v0.1.0` builds and publishes those archives. To build a standalone binary from this checkout: `bun run --cwd apps/cli build` writes `apps/cli/dist/idlehand`.
The standalone build excludes Ink's optional React DevTools connection.

Without the web service, add repos locally: `idlehand repos add owner/name`.

## CLI reference

```
idlehand dev [--repo owner/name]    start the local service in dev mode, preloaded with this repo
idlehand login [--server URL]        connect this machine to your account; signs in to GitHub if needed
idlehand logout
idlehand config show|get|set|keys    settings live in ~/.idlehand/config.json
idlehand repos [list|add|remove]     selections from the server plus local repos
idlehand run [options]               spend the budget
    -b, --budget   '$10' | '10%' | '3 tasks' | '45m' | 'remaining'
    -p, --provider claude | codex | cursor
    -r, --repo     owner/name ...      restrict this run
    --only         review-pr,fix-issue,review-codebase
    --once           stop after one task
    -j, --jobs       tasks to run at once (default 4); each gets its own worktree
    --no-continuous  one pass through the current queue, then stop
    --dry-run        plan only
idlehand status [--limit 15]         spend this month and recent tasks (-n also works)
idlehand doctor                      environment checks
```

Run `idlehand` for a quick start, or `idlehand <command> --help` for examples. Bare `idlehand config` shows the effective settings, with the token redacted. Quote dollar budgets with **single quotes** (for example, `--budget '$2'`) so the shell does not expand the dollar sign.

Global flags: `--plain` for line output, `--json` for one JSON value per line. Without terminal input and output the CLI picks `--plain` automatically. In JSON mode, errors and warnings are JSON records on stderr, leaving stdout available for command results and run events. Exit codes are `0` for success, `1` for a command or setup error, and `2` when one or more run tasks failed. `doctor` uses the same exit status in human and JSON modes; an unavailable server or unselected provider is optional.

Use `--dry-run` to preview the queue using your GitHub login. It does not require Claude Code, Codex, or the Cursor CLI, spend credits, change saved task outcomes, or prune checkouts. During a run, press **Ctrl+C** (or **q** in the dashboard) to stop after the running tasks finish; no further tasks start. The dashboard shows live elapsed time and marks estimated spending with `≈`.

Useful settings (`idlehand config keys` lists them all):

A run keeps scanning until the budget is spent. It retries a failure immediately, ignores who opened a pull request or who is assigned to an issue, and does not wait between codebase reviews. It still skips a target after three failures so one broken task cannot consume the budget. Completed work is not repeated. `--no-continuous` makes one pass and then stops; on that pass, failures wait 15 minutes before another attempt, up to three attempts, and a codebase review waits 72 hours. Failed attempts still count toward spending and task budgets.

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `claude` | Which agent CLI to spawn: `claude`, `codex`, or `cursor`. |
| `budget` | `$5` | Default budget for `run`. |
| `subscription.monthlyUsd` | unset | What your plan is worth per month; required for `10%`-style budgets. |
| `policy.merge` | `when-authorized` | `never` to review without merging. |
| `policy.issueLabels` | any | Only attempt issues with one of these labels, e.g. `bug,help wanted`. |
| `policy.maxIssuesPerReview` | 3 | Cap on issues filed per codebase review. |
| `policy.commentOnIssues` | false | Comment when an issue cannot be reproduced or is not a bug. |
| `claude.permissionMode` | `acceptEdits` | Agents run inside a throwaway checkout; `bypassPermissions` is available if you accept the risk. |
| `codex.pricing.*` | GPT-5 list | Codex reports tokens, not dollars, so its spend is an estimate. |
| `cursor.bin` | `agent` | Cursor CLI binary. The current installer exposes the command as `agent`. |
| `cursor.pricing.*` | token estimate | Cursor reports tokens, not dollars. Includes cache reads and cache writes. |

## How budgets are measured

Claude Code reports its client-side dollar estimate in `total_cost_usd`; [its native budget flag](https://code.claude.com/docs/en/cli-reference) stops at a spending threshold and can overshoot during in-flight calls. Codex and the [Cursor CLI](https://cursor.com/docs/cli/reference/output-format) report tokens only; Idlehand estimates dollars with the configured price table. Estimates are marked with `≈` and can differ from a bill. Codex and Cursor dollar and percent budgets are rejected because neither interface has a dollar stopping threshold. The Cursor provider appends the task JSON schema to the prompt, since that CLI has no schema flag. Missing final accounting stops the run instead of allowing more untracked spending; any reported partial usage is retained, and zero without accounting does not mean the task was free.

Neither CLI exposes a subscription's live quota, so `10%` means ten percent of the monthly value you declare. Task and time budgets are checked between tasks, so a current task can finish after a time budget expires. `remaining` means no cap of our own: the run ends when the provider refuses to continue. A normal run keeps scanning after the queue is empty, so an idle dollar budget does not end the process; stop it with Ctrl+C. `--no-continuous` stops when the current queue is done.

## Opting out

Maintainers who do not want Idlehand contributions can add a `no-idlehand` label to a PR. Every issue, PR and review carries a footer saying it came from an Idlehand node and that the runner re-verified the claim.

## Development

```sh
bun test                              # shared, server and cli unit tests
bun run typecheck
bun test apps/server                  # includes an end-to-end device-login flow
```
