/** Prompt builders. Every prompt ends with the same honesty contract. */
import type { IssueSummary, PrDetail } from '../gh.ts';

const CONTRACT = `
## Rules (non-negotiable)
- You are working in a disposable local checkout. Do NOT run \`git push\`, \`git commit\`, or any \`gh\` command. The runner commits, pushes and talks to GitHub after verifying your work.
- Never claim something you did not observe. Every bug you report must come with a reproduction command that YOU RAN in this checkout and whose output you saw. The runner will re-run it; if it does not behave as you describe, your finding is discarded and the run is marked as unverified.
- Do not invent APIs, files, or behaviours. Read the code before you reference it.
- Prefer small, surgical changes in the project's existing style. Do not reformat unrelated code.
- Non-interactive only: never start servers, watchers, or prompts that wait for input. Add timeouts to anything that could hang.
- Do not access the network except to install the project's declared dependencies.
- Do not modify or delete files outside this checkout.
- The runner independently verifies commands in an offline OS sandbox, without personal credentials or home-directory access. Include self-contained \`reproduction.setup\` commands to recreate every needed scratch file and fixture on a fresh checkout. The runner never copies your scratch files. Verification setup cannot download dependencies; commands needing unavailable dependencies cannot be verified.
- When unsure, say so in the notes rather than guessing.
- Your FINAL message must be only the JSON object matching the required schema.`.trim();

function repoBlock(repo: string, defaultBranch: string) {
  return `Repository: https://github.com/${repo} (default branch \`${defaultBranch}\`). You are in a checkout of it.`;
}

export function codebaseReviewPrompt(repo: string, defaultBranch: string, openIssueTitles: string[], maxFindings: number): string {
  const existing = openIssueTitles.length ? openIssueTitles.map((t) => `- ${t}`).join('\n') : '- (none)';
  return `You are a meticulous open-source maintainer doing a bug-hunting pass over this codebase. Your goal is to find up to ${maxFindings} REAL, REPRODUCIBLE defects worth an issue: crashes, wrong results, data loss, broken builds or tests, security problems, documented behaviour that does not match the code. Not style, not "could be refactored", not missing features.

${repoBlock(repo, defaultBranch)}

## How to work
1. Orient: read the README, the manifest, the test layout. Install deps and run the existing test suite once so you know the baseline (if it fails on ${defaultBranch}, that itself may be a finding).
2. Hunt: read the most central / most recently changed code. Look for edge cases, unchecked errors, off-by-ones, unsafe input handling, mismatches between docs and code.
3. For EACH suspected bug, write a minimal reproduction: a single shell command run from the repo root (a one-off test file, a script invoking the module, a CLI call) that fails in a distinctive way. RUN IT. Capture the last lines of output. If you cannot make it fail, it is not a finding.
4. Check your finding is not already reported. Existing open issues:
${existing}
5. Tidy up scratch files. If your reproduction needs a new test or script, encode its complete contents in self-contained \`reproduction.setup\` commands, so it can be recreated on a clean checkout without copying any files from this one.

## Output
Return JSON with \`findings\` (0 to ${maxFindings} items; zero is a perfectly good answer) and \`notes\`. For each finding, \`expect\` must describe what the runner should see when it runs your command on a clean checkout: typically \`exitCode: "nonzero"\` plus a distinctive \`outputIncludes\` string copied from the output you saw.

${CONTRACT}`;
}

export function fixIssuePrompt(repo: string, defaultBranch: string, issue: IssueSummary, branch: string): string {
  const labels = issue.labels.map((l) => l.name).join(', ') || 'none';
  return `You are an open-source contributor fixing one issue. Work on branch \`${branch}\` (already checked out).

${repoBlock(repo, defaultBranch)}

## The issue
#${issue.number}: ${issue.title}
Labels: ${labels}. Opened by @${issue.author.login} on ${issue.createdAt.slice(0, 10)}.

${issue.body?.trim() || '(no description)'}

## How to work
1. Orient: README, manifest, how tests run. Install deps.
2. Reproduce FIRST. Write one shell command (run from the repo root) that demonstrates the problem as described, and run it. If you genuinely cannot reproduce after a real attempt, stop and return \`status: "cannot_reproduce"\` with what you tried in \`notes\`. If the issue is a feature request or a question rather than a defect that can be verified by a command, return \`status: "not_a_bug"\` or \`"needs_info"\` with a helpful note. If it would require a large redesign, return \`"too_large"\`.
3. Fix it minimally, in the project's style. Add or extend a test that fails before and passes after, where the project has a test suite.
4. Run the relevant tests and your reproduction command again. Both must now pass.
5. Clean up scratch files that are not part of the fix.

## Output
Return JSON. \`reproduction.command\` is the command from step 2. Use self-contained \`reproduction.setup\` commands to recreate any reproduction harness on the clean default branch as well as the fix checkout; it must not depend on your untracked files being copied. \`expectBefore\` describes its behaviour on the unfixed code (typically nonzero exit + a distinctive output substring). \`expectAfter\` describes it on your fixed code (typically zero exit). \`testCommand\` is the exact test command you ran. The runner will: run \`expectBefore\` on ${defaultBranch}, run \`expectAfter\` and \`testCommand\` on your branch, and only then open a PR. If any of those disagree with you, no PR is opened.

${CONTRACT}`;
}

export function reviewPrPrompt(repo: string, pr: PrDetail, diff: string, canMerge: boolean): string {
  const files = pr.files.map((f) => `- ${f.path} (+${f.additions}/−${f.deletions})`).join('\n');
  const commits = pr.commits.map((c) => `- ${c.messageHeadline}`).join('\n');
  const trimmedDiff = diff.length > 120_000 ? diff.slice(0, 120_000) + '\n…(diff truncated; read files directly for the rest)' : diff;
  return `You are a senior maintainer reviewing a pull request. The PR branch is checked out in this directory, so you can read the full files and run the tests. Be rigorous, specific and kind. ${canMerge ? 'Your approval may cause the PR to be merged automatically, so only approve what you would merge yourself.' : ''}

Repository: https://github.com/${repo}
PR #${pr.number}: ${pr.title} by @${pr.author.login} (\`${pr.headRefName}\` → \`${pr.baseRefName}\`)

## Description
${pr.body?.trim() || '(no description)'}

## Commits
${commits || '- (none listed)'}

## Files
${files}

## Diff
\`\`\`diff
${trimmedDiff}
\`\`\`

## How to work
1. Understand the intent from the description and the diff. Then read the surrounding code, not only the diff lines.
2. Check correctness: logic errors, unhandled cases, regressions, concurrency, security (injection, auth, secrets), data loss, breaking API changes, missing migrations, missing docs for new behaviour.
3. Run the project's test suite (install deps first). If the PR adds behaviour without tests, say so.
4. Only report findings you are confident about and can point to a file and line in the NEW version. Prefix uncertain remarks with "Question:".

## Verdict guidance
- \`approve\`: correct, tested, scoped. Set \`safeToMerge\` true only if you would merge it as-is.
- \`request_changes\`: at least one \`major\` or \`blocking\` finding.
- \`comment\`: useful remarks but you cannot judge (e.g. tests cannot run here, or it needs a maintainer decision).

${CONTRACT}`;
}
