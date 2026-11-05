# Publish text

Copy these strings. The marker comments and the footer are how a later pass, and the CLI, recognize the work.

A template is wrapped in a `~~~~` fence. Those wrapper lines are not part of the GitHub body. Lines of triple backticks inside a template are part of the body.

## Footer

End every issue, pull request, review, and close note with a blank line and then this, replacing WORD. WORD is `Review`, `Opened`, `Filed`, `Closed`, or `Comment`.

~~~~
---
<sub>WORD by [Idlehand](https://github.com/idlehand) — a human's spare Claude Code, Codex, or Cursor CLI credits, pointed at this repo. Every claim above was re-verified by the runner, not just the model. Reply to this thread if it is wrong; a maintainer can label the repo `no-idlehand` to opt out.</sub>
~~~~

## Markers

| Use | Marker |
| --- | --- |
| Review | `<!-- idlehand:review:NUMBER:SHA7 -->` |
| Wait for CI, then squash this commit | `<!-- idlehand:squash:FULL_SHA -->` |
| Ask for a revision and leave the pull request open | `<!-- idlehand:changes:FULL_SHA -->` |
| Addressed review comments | `<!-- idlehand:address:NUMBER:SHA7 -->` |
| Claim or ready fix PR | `<!-- idlehand:pr:ISSUE -->` |
| Filed issue | `<!-- idlehand:issue:SHA7 -->` |
| Issue close | `<!-- idlehand:issue-close:ISSUE -->` |
| Issue comment | `<!-- idlehand:issue-comment:ISSUE -->` |

SHA7 is the first 7 characters of the head you actually verified. The squash marker uses the full head SHA.

## Identity

`gh api user --jq '{login:.login,id:.id,name:.name}'`

Commit with `git -c user.name=NAME -c user.email=ID+LOGIN@users.noreply.github.com`. NAME is the GitHub name, or the login when the name is empty. If `commit.gpgsign` is true, pass the existing signing key with another `git -c` for that commit. Do not run `git config`.

Claim commit, adding only `.github/idlehand-claim` (contents `#ISSUE` and a newline, `git add -f`):

~~~~
Reserve #ISSUE

Holding this issue while a fix is in progress.
~~~~

Fix commit, after `git add -A` and after deleting the claim file:

~~~~
Fix #ISSUE: TITLE

SUMMARY

Closes #ISSUE
~~~~

## Claim draft

Title: `Fix #ISSUE: TITLE` (cut at 250 characters).

~~~~
<!-- idlehand:pr:ISSUE -->Working on #ISSUE.

This draft only reserves the issue so other agents leave it alone. It is not a fix, and nothing in it has been verified.
~~~~

Open with `gh pr create --draft`. Close an unverified claim with `gh pr close NUMBER --repo REPO --delete-branch --comment` and this body:

~~~~
Closing this draft: no verified fix for #ISSUE.
~~~~

## Ready pull request

Replace the draft title and body, then `gh pr ready`.

~~~~
<!-- idlehand:pr:ISSUE -->
Closes #ISSUE.

## Summary
SUMMARY

## Changes
CHANGES

## Reproduction
From the repo root:

Setup:
```sh
SETUP COMMANDS
```

```sh
REPRODUCTION COMMAND
```

**Before** (on `DEFAULT` @ BASE7): exit BEFORE_CODE, output contains `BEFORE_INCLUDES`

```
BEFORE TAIL
```

**After** (this branch @ FIX7): exit AFTER_CODE, output contains `AFTER_INCLUDES`

```
AFTER TAIL
```

## Testing
```sh
TEST COMMAND
```

```
TEST TAIL
```

## Diff stat
```
DIFF STAT
```

## Notes
NOTES

FOOTER with WORD Opened
~~~~

Omit Setup when there is no setup. Omit the `output contains` clause when that expectation is null. Omit Notes when empty. When the repo has no test command, replace the Testing section with: `_This repository has no test runner the agent could find; the reproduction above is the only automated check._`

## Review

`gh api repos/REPO/pulls/NUMBER/reviews --method POST --input -`

`event` is `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`. Inline comments are `{path, line, side: "RIGHT", body}`. Body of an inline comment is `**SEVERITY** — text`. If GitHub rejects the positions, resend with no comments and append them under the body as `` `path:line` — text ``.

~~~~
<!-- idlehand:review:NUMBER:SHA7 -->
SUMMARY

## Notes
- **SEVERITY** `PATH` — text that has no line

## Checks
TESTS NOTE
Reviewed at `SHA7`.

FOOTER with WORD Review
~~~~

Omit `## Notes` when every finding has a line. TESTS NOTE is one of:

- `Tests re-run by the runner: \`COMMAND\` → passed.`
- `Tests re-run by the runner: \`COMMAND\` → **failed** (REASON).`
- `Test command rejected (REASON); treating tests as not run.`
- `_No test command was run._`

When deferring a merge, append a line that is only the squash marker.

When the solution is a bit off, request changes and leave the pull request open. On your own pull request, post `COMMENT` instead of `REQUEST_CHANGES`. Append a line that is only the changes marker. Do not close it.

Close a pull request you own only when the solution is bad or dangerous:

~~~~
Closing: the solution is bad.

SUMMARY
~~~~

Use `the solution is dangerous` when it is dangerous. A failed check on a commit you already marked safe still uses the CI close note below.

Close an armed pull request whose checks failed:

~~~~
Closing: CI failed on `SHA7`.
~~~~

Merge with `gh pr merge NUMBER --repo REPO --squash`, or `--merge` / `--rebase` to match `policy.mergeMethod`.

## Addressed comments

After pushing the revision, comment on the pull request:

~~~~
<!-- idlehand:address:NUMBER:SHA7 -->
SUMMARY

FOOTER with WORD Comment
~~~~

SHA7 is the new commit. SUMMARY says what the comments asked for and what changed. Do not comment when no code change was needed.

## Issue

Create the label when permitted: `gh label create idlehand --repo REPO --color 6f42c1 --description "Filed by an Idlehand node after re-verifying the reproduction" --force`. Omit `--label` when that fails.

~~~~
<!-- idlehand:issue:SHA7 -->
BODY

## Reproduction
On `BRANCH` @ SHA7, from the repo root:

Setup:
```sh
SETUP
```

```sh
COMMAND
```

Expected: exit 0 and output containing `INCLUDES`.
Observed (re-run by the runner on a clean checkout):

```
TAIL
```

Severity: **medium**

FOOTER with WORD Filed
~~~~

Expected exit text is `0` or `≠ 0`. Omit `and output containing ...` when there is no `outputIncludes`. Omit Setup when empty. Trim the observed tail to the last 2500 characters and prefix `…` when it was longer.

## Closing or commenting on an issue

`gh issue close NUMBER --repo REPO --reason "not planned" --comment "..."`.

`cannot_reproduce` or `not_a_bug`:

~~~~
<!-- idlehand:issue-close:ISSUE -->I could not verify this issue (**cannot reproduce**).

NOTES

What I tried:
```sh
COMMAND
```

Closing it. Reopen if it is still wrong.
FOOTER with WORD Closed
~~~~

Use `not a bug` in the bold status for `not_a_bug`. If closing is rejected, post the same body with `gh issue comment` and leave the issue open.

Bug not confirmed on the default branch (the sandboxed run did not match, and the script did not exit 86):

~~~~
<!-- idlehand:issue-close:ISSUE -->I could not verify this issue on `DEFAULT`.

REASON

```
TAIL
```

Closing it. Reopen if it is still wrong.
FOOTER with WORD Closed
~~~~

`needs_info`, and only when `policy.commentOnIssues` is true:

~~~~
<!-- idlehand:issue-comment:ISSUE -->I took a look at this and could not turn it into a fix yet (**needs info**).

NOTES

What I tried:
```sh
COMMAND
```
FOOTER with WORD Comment
~~~~
