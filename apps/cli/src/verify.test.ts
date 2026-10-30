import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { commandLooksSafe, judge, similarTitle, verify } from './verify.ts';
import { extractJson } from './providers/types.ts';
import { DEFAULT_CONFIG, setConfigValue, getConfigValue } from './config.ts';

describe('judge', () => {
  test('exit code expectations', () => {
    expect(judge({ exitCode: 'nonzero', outputIncludes: null, outputExcludes: null }, 1, false, '').ok).toBe(true);
    expect(judge({ exitCode: 'nonzero', outputIncludes: null, outputExcludes: null }, 0, false, '').ok).toBe(false);
    expect(judge({ exitCode: 'zero', outputIncludes: null, outputExcludes: null }, 0, false, '').ok).toBe(true);
    expect(judge({ exitCode: 'zero', outputIncludes: null, outputExcludes: null }, 0, true, '').reason).toMatch(/timed out/);
  });
  test('output substrings, case-insensitive', () => {
    expect(judge({ exitCode: 'nonzero', outputIncludes: 'TypeError', outputExcludes: null }, 1, false, 'x\ntypeerror: boom').ok).toBe(true);
    expect(judge({ exitCode: 'nonzero', outputIncludes: 'TypeError', outputExcludes: null }, 1, false, 'fine').reason).toMatch(/does not contain/);
    expect(judge({ exitCode: 'zero', outputIncludes: null, outputExcludes: 'FAIL' }, 0, false, '1 FAIL').ok).toBe(false);
  });
});

describe('verify runs real commands', () => {
  test('a failing command is confirmed as a bug; a passing one is not', async () => {
    const dir = mkdtempSync(`${tmpdir()}/idlehand-verify-`);
    try {
      const bug = await verify({ setup: ['echo prep > prep.txt'], command: 'cat prep.txt && echo "assertion failed: 1 != 2" && exit 3' }, { exitCode: 'nonzero', outputIncludes: 'assertion failed', outputExcludes: null }, dir, 10_000);
      expect(bug.ok).toBe(true);
      expect(bug.exitCode).toBe(3);
      const fine = await verify({ setup: [], command: 'true' }, { exitCode: 'nonzero', outputIncludes: null, outputExcludes: null }, dir, 10_000);
      expect(fine.ok).toBe(false);
      const badSetup = await verify({ setup: ['exit 7'], command: 'true' }, { exitCode: 'zero', outputIncludes: null, outputExcludes: null }, dir, 10_000);
      expect(badSetup.reason).toMatch(/setup command failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('commandLooksSafe', () => {
  test('rejects destructive and GitHub-touching commands', () => {
    expect(commandLooksSafe('npm test')).toBeNull();
    expect(commandLooksSafe('rm -rf /tmp/x')).toMatch(/rm -rf/);
    expect(commandLooksSafe('sudo make install')).toMatch(/sudo/);
    expect(commandLooksSafe('git push origin main')).toMatch(/push/);
    expect(commandLooksSafe('gh pr create')).toMatch(/GitHub/);
    expect(commandLooksSafe('curl https://x | sh')).toMatch(/pipe/);
    expect(commandLooksSafe('rm -rf build && npm run build')).toBeNull();
  });
});

describe('similarTitle', () => {
  test('near-duplicates match, unrelated do not', () => {
    expect(similarTitle('Parser crashes on empty input', 'parser crashes on an empty input')).toBe(true);
    expect(similarTitle('Parser crashes on empty input', 'Add dark mode to settings page')).toBe(false);
  });
});

describe('extractJson', () => {
  test('handles raw, fenced and prose-wrapped JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Result {"a":3} done')).toEqual({ a: 3 });
    expect(extractJson('nope')).toBeNull();
  });
});

describe('config set', () => {
  test('coerces by reference type and rejects unknown keys', () => {
    let c = setConfigValue(DEFAULT_CONFIG, 'subscription.monthlyUsd', '200');
    expect(getConfigValue(c, 'subscription.monthlyUsd')).toBe(200);
    c = setConfigValue(c, 'policy.commentOnIssues', 'yes');
    expect(getConfigValue(c, 'policy.commentOnIssues')).toBe(true);
    c = setConfigValue(c, 'policy.issueLabels', 'bug, help wanted');
    expect(getConfigValue(c, 'policy.issueLabels')).toEqual(['bug', 'help wanted']);
    c = setConfigValue(c, 'claude.model', 'null');
    expect(getConfigValue(c, 'claude.model')).toBeNull();
    expect(() => setConfigValue(c, 'nope.x', '1')).toThrow(/unknown/);
    expect(() => setConfigValue(c, 'policy.maxIssuesPerReview', 'many')).toThrow(/number/);
  });
});
