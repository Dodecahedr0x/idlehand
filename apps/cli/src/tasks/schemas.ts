/** JSON schemas the agent's final answer must satisfy, per task kind. */

const expectation = {
  type: 'object',
  additionalProperties: false,
  properties: {
    exitCode: { type: 'string', enum: ['zero', 'nonzero'], description: 'Expected exit status of the command.' },
    outputIncludes: { type: ['string', 'null'], description: 'A short, distinctive substring that must appear in stdout/stderr. Prefer an error message or assertion text. null if exit code alone is enough.' },
    outputExcludes: { type: ['string', 'null'], description: 'A substring that must NOT appear. Usually null.' },
  },
  required: ['exitCode', 'outputIncludes', 'outputExcludes'],
} as const;

const reproduction = {
  type: 'object',
  additionalProperties: false,
  properties: {
    setup: { type: 'array', items: { type: 'string' }, description: 'Shell commands to run first from the repo root (install deps, build). Empty array if none needed. Must be non-interactive.' },
    command: { type: 'string', description: 'ONE non-interactive shell command, run from the repo root, whose result demonstrates the bug. Must finish in under a few minutes. Must not use the network except for dependency installs in setup. Must not touch files outside the repo.' },
  },
  required: ['setup', 'command'],
} as const;

export const CODEBASE_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', maxLength: 120, description: 'Issue title, specific and searchable.' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          body: { type: 'string', description: 'Markdown: what is wrong, where (file:line), why it matters, suggested fix. Do not include the reproduction section; it is appended automatically.' },
          reproduction,
          expect: expectation,
          observed: { type: 'string', description: 'The last ~10 lines of output you actually saw when you ran the command.' },
        },
        required: ['title', 'severity', 'body', 'reproduction', 'expect', 'observed'],
      },
    },
    notes: { type: 'string', description: 'What you inspected and ruled out; one paragraph.' },
  },
  required: ['findings', 'notes'],
} as const;

export const FIX_ISSUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['fixed', 'cannot_reproduce', 'not_a_bug', 'needs_info', 'too_large'], description: 'fixed only for a small correction of a defect you reproduced. Use not_a_bug for a feature, documentation, packaging, an installer, deployment, or a workflow.' },
    summary: { type: 'string', description: 'One paragraph for the PR description: what was wrong and what changed.' },
    changes: { type: 'string', description: 'Markdown bullet list of the changes made, by file.' },
    reproduction,
    expectBefore: expectation,
    expectAfter: expectation,
    testCommand: { type: ['string', 'null'], description: 'The command that runs the relevant tests (including any test you added). null only if the repo has no test runner at all.' },
    notes: { type: 'string', description: 'Anything a reviewer should know: tradeoffs, follow-ups, or why the status is not fixed.' },
  },
  required: ['status', 'summary', 'changes', 'reproduction', 'expectBefore', 'expectAfter', 'testCommand', 'notes'],
} as const;

export const REVIEW_PR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
    solution: {
      type: 'string',
      enum: ['sound', 'off', 'bad', 'dangerous'],
      description: 'sound: a correct fix. off: a bit wrong and should be revised, not closed. bad: the approach should not land. dangerous: merging could cause a security problem, data loss, or other harm.',
    },
    summary: { type: 'string', description: 'Markdown review body: what the PR does, what you checked, overall assessment. 1-3 paragraphs.' },
    findings: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          line: { type: ['integer', 'null'], description: 'Line number in the NEW version of the file, or null.' },
          severity: { type: 'string', enum: ['nit', 'minor', 'major', 'blocking'] },
          body: { type: 'string' },
        },
        required: ['path', 'line', 'severity', 'body'],
      },
    },
    tests: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: ['string', 'null'], description: 'Test command you ran from the repo root, or null if none exists.' },
        passed: { type: 'boolean' },
        outputTail: { type: 'string' },
      },
      required: ['command', 'passed', 'outputTail'],
    },
    safeToMerge: { type: 'boolean', description: 'true only if you would merge this yourself: correct, tested, scoped, no security or data-loss risk.' },
  },
  required: ['verdict', 'solution', 'summary', 'findings', 'tests', 'safeToMerge'],
} as const;

export const ADDRESS_PR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['addressed', 'nothing'], description: 'addressed only when you changed the branch to answer the comments. nothing when the comments need no code change.' },
    summary: { type: 'string', description: 'What the comments asked for and what you changed, or why nothing was required.' },
    testCommand: { type: ['string', 'null'], description: 'The test command you ran from the repo root, or null if the repo has no test runner.' },
  },
  required: ['action', 'summary', 'testCommand'],
} as const;
