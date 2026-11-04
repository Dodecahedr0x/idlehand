---
name: idlehand
description: >-
  Contributes to GitHub repositories the way the Idlehand CLI does: review
  open pull requests, fix open issues, and file only bugs re-verified on a
  clean checkout. Use when the user asks to run Idlehand, replace or skip the
  idlehand CLI, spend a contribution budget, or work selected repos under
  Idlehand rules. Does not apply when the task is to change Idlehand's own
  source.
---

# Idlehand

You are the runner. Do the contributor loop yourself with `git`, `gh`, and `scripts/sandboxed_sh.py` next to this skill. Do not invoke the `idlehand` binary, and do not spawn `claude`, `codex`, or another agent CLI.

## When

Use this when the user asks to run Idlehand, contribute under its rules, or do that work without the CLI. Developing Idlehand (editing this repo's apps or packages) is not a run.

## Rules that override your judgment

- A command you already ran does not verify a claim. The only run that counts is `sandboxed_sh.py` on a clean worktree, after the claim is written down.
- Exit 86 (stderr starts with `sandbox-`) is infrastructure. Stop that task. Do not close the issue, do not file, and do not treat the bug as absent.
- Exit 87 (stderr starts with `rejected:`) means the claim is discarded. Do not publish it.
- Publish to GitHub only after the sandboxed run matches the claim. Copy the text in [publish.md](publish.md).
- Zero findings is a valid codebase review. Style, refactors, and hunches are not findings.
- Do one task at a time. Finish pull requests before issues, and issues before a codebase review.

## Setup

Read `$IDLEHAND_HOME` if set, otherwise `~/.idlehand`. Config is `config.json` in that directory. Missing keys use these defaults: `policy.merge` `when-authorized`, `policy.mergeMethod` `squash`, `policy.issueLabels` empty (any issue), `policy.skipIssueLabels` `question`, `discussion`, `wontfix`, `duplicate`, `invalid`, `needs-design`, `epic`, `policy.maxIssuesPerReview` 3, `policy.codebaseReviewIntervalHours` 72, `policy.commentOnIssues` false, `policy.commandTimeoutSec` 600.

Repos for this session are the ones the user named. Otherwise use `repos` from config, plus `GET {server.url}/api/cli/repos` with `Authorization: Bearer {server.token}` when a token is set. Skip archived repos and repos `gh` cannot read.

`gh auth status` must succeed. If it does not, run `gh auth login -h github.com -p https -w` and wait. Do not ask the user to log in first.

Preflight before any publish: `git`, `gh`, and `python3` exist, and this exits 0:

```sh
python3 scripts/sandboxed_sh.py --cwd "$WORKDIR" --timeout 30 -- true
```

`WORKDIR` is a directory you created. Do not use the skill directory. If the sandbox cannot start, stop. Never verify by running a claim unsandboxed.

If an `idlehand` process is already running, leave `state.sqlite` alone and let that process own the queue. Otherwise apply [state.sql](state.sql) to `state.sqlite` in the Idlehand home, then:

```sql
UPDATE tasks SET outcome='failed', cost_unknown=1, cost_estimated=1, finished_at=datetime('now') WHERE outcome='running';
```

Skip a target when a row for that repo, kind, and target has an outcome other than `failed`, or when it already has 3 failed rows. Insert `outcome='running'` when a task starts and update it when the task finishes. Use provider `cursor`, `cost_usd` 0, `cost_unknown` 1. This session does not meter dollars.

Targets are `pr:N`, `squash:N:FULLSHA`, `close:N:FULLSHA`, `dispose:N:FULLSHA`, `issue:N`, and `codebase:YYYY-MM-DD`.

## Queue

1. Open, non-draft pull requests. Skip labels matching `no-idlehand` or `no-bots?`. Skip a head you already reviewed unless you are merging or closing it.
2. Open issues. Skip `skipIssueLabels`. If `issueLabels` is non-empty, require one of them. Skip an issue whose number appears as `#N` or `issue-N` in an open PR title or head ref. On one pass, also skip an issue assigned to someone else.
3. One codebase review per repo. On one pass, skip a repo whose `codebase_reviews.reviewed_at` is inside the interval. Record the review when it finishes, including when nothing is filed, but not after exit 86.

Pull requests first: if your review body on this full head SHA contains `<!-- idlehand:squash:FULLSHA -->`, merge or close it before reviewing anything else. Green or absent checks can merge. Pending checks wait. Red checks close it. Merging and closing require `policy.merge` `when-authorized`, push permission, and a PR that is not held. Held means the title matches `WIP` or `do not merge`, or a label matches `do not merge`, `wip`, or `hold`.

Within pull requests, do squash and close before new reviews, then oldest `createdAt`. Within issues, prefer labels `bug`, `good first issue`, `good-first-issue`, `help wanted`, `help-wanted`, `regression`, `crash`, then older issues.

While any pull request still needs review, merge, or close, do not start issues or a codebase review.

## Stop

One pass, then stop, unless the user says otherwise. `once` or `1 task` is a single task. `N tasks` counts finished tasks, including `nothing-found`, `unverified`, and `failed`. `keep going` scans again until the user stops you; retry a failure immediately, still at most 3 times, and do not sleep between tries. Do not invent a dollar cap. Say that `$` and `%` budgets are not metered here.

A dry run prints the queue and does not clone, commit, push, or comment.

## Workspace

Keep clones under `~/.idlehand/agent-work/owner/name/`. Do not reuse the CLI's `repos` or `work` directories. Fetch before each task. Remove worktrees when the task ends. If the user stops you during a fix, leave the draft claim open.

Verification uses a new worktree at the ref the claim is about. Do not copy scratch files into it. Setup commands recreate any harness.

## Verify

```sh
python3 scripts/sandboxed_sh.py --cwd CLEAN_WORKTREE --timeout SECONDS -- 'command'
```

Run each setup command the same way and require exit 0, then the reproduction. Default timeout is 600 seconds. The script rejects an empty command, `sudo` / `doas`, `rm -rf` of `/` or `~`, `git push`, `gh pr|issue|release|repo`, a download piped into a shell, and `shutdown`, `reboot`, `mkfs`, or `dd if=`.

Judge only the sandboxed stdout, stderr, and exit code:

- `zero` means exit 0. `nonzero` means any other exit.
- `outputIncludes`, when set, must appear in the combined output, case-insensitive.
- `outputExcludes`, when set, must not appear.
- Exit 0 when you expected a failure is a failed claim, not infrastructure.

The sandbox can reach the public internet so setup can install declared dependencies. It gets a temporary home, no inherited credentials, and it cannot write outside the worktree. On macOS it cannot connect to localhost. A child that starts its own session can outlive the timeout there; do not publish if you are unsure the command finished inside the sandbox.

## Review a pull request

Read the description, the diff, and the surrounding code. Run the tests. Approve only a correct, tested fix of a demonstrated defect. Set `safeToMerge` only when you would merge it yourself. A feature, an unrelated refactor, missing tests, or a change that does not fix a demonstrated defect is not safe to merge. Use `request_changes` for a major or blocking finding, and `comment` when you cannot judge.

Re-run the test command in the sandbox on the PR worktree, expecting exit 0. Then post the review from [publish.md](publish.md).

- Approve becomes `COMMENT` when that re-run did not exit 0.
- Approve becomes `REQUEST_CHANGES` when a finding is major or blocking.
- Your own PR cannot be `APPROVE`. Post `COMMENT`. You may still merge when you concluded approve, the re-run passed, and `safeToMerge` is true.

Disposition, after re-reading the PR. If the head SHA moved, leave it. Otherwise, only when merge is `when-authorized`, you can push, and the PR is not held:

- Safe, checks green or absent, and `MERGEABLE`: merge with `policy.mergeMethod`.
- Safe, and checks are pending or mergeability is still `UNKNOWN` while checks are not red: do not merge. Put the squash marker for this full SHA in the review body.
- Otherwise, if you authored the PR or its head starts with `idlehand/`: close it.
- Otherwise leave it open.

No check rollup means absent. A queued, in-progress, pending, waiting, or requested check means pending. Every conclusion `SUCCESS`, `NEUTRAL`, or `SKIPPED` means green. Anything else is red.

"Safe" means the posted verdict is approve, or this is your own PR and you concluded approve, and the sandboxed tests exited 0, and `safeToMerge` is true.

## Fix an issue

1. If `idlehand/issue-N` already has an open pull request from someone else, stop.
2. Otherwise commit only `.github/idlehand-claim`, push without force, and open a draft. If the push or the create races, stop and leave the winner. Without push permission, `gh repo fork --clone=false` and set the PR head to `login:idlehand/issue-N`.
3. Reproduce the reported defect with one shell command before editing. If it does not fail, stop. Do not switch bugs.
4. A feature, question, docs, packaging, installer, deployment, or workflow request is `not_a_bug`. The statuses are `fixed`, `cannot_reproduce`, `not_a_bug`, `needs_info`, and `too_large`. `fixed` is a small change in the project's style. Add a regression test when the repo has a suite. Do not weaken a test.
5. Delete the claim file. On a clean worktree of the default branch, the sandboxed reproduction must match the before-expectation. On the fix worktree, it must match the after-expectation, and the test command must exit 0. Setup runs in both places.
6. Only then commit, push, replace the draft body, and `gh pr ready`.

`not_a_bug` and `cannot_reproduce` close the issue (comment if close is rejected). `needs_info` comments only when `policy.commentOnIssues` is true. `too_large` does neither. Any path that is not a verified fix closes the draft and deletes its branch. Exit 86 does not close the issue; it still closes the unverified draft.

## Review a codebase

Look for crashes, wrong results, data loss, a broken build or test, security problems, and docs that contradict the code. At most `maxIssuesPerReview` findings. Skip a title whose words overlap an open issue: Jaccard at least 0.6 on case-folded tokens longer than 2 characters, after dropping other punctuation.

File a finding only when the sandboxed re-run on a clean default-branch worktree matches. Then use the issue template in [publish.md](publish.md).

## When your own attempt fails

Do not file a provider limit, a missing credential, a timeout, your own confusion, the issue you were already fixing, or a defect that exists only on the pull request under review. If a real defect on the default branch caused the failure, propose at most one finding and file it only through the codebase rules.

## Report

End with one line per task: repo, kind, outcome, URL. Outcomes are `reviewed`, `merged`, `closed`, `pr-opened`, `issues-filed`, `nothing-found`, `unverified`, and `failed`.
