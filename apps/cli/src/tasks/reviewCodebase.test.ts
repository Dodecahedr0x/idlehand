import { expect, test } from 'bun:test';

test('codebase review rejects missing fixtures instead of copying agent symlinks on the host', async () => {
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  // Isolate module mocks from the rest of the test suite, but use real verification.
  const source = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const root = mkdtempSync(join(tmpdir(), 'idlehand-scratch-copy-'));
    const agent = join(root, 'agent'), clean = join(root, 'clean');
    mkdirSync(agent); mkdirSync(clean);
    writeFileSync(join(root, 'credential'), 'synthetic-secret');
    symlinkSync(join(root, 'credential'), join(agent, 'scratch'));
    assert.equal(Bun.spawnSync(['git', 'init', '-q', agent]).exitCode, 0);
    let worktrees = 0, published = 0;
    mock.module(${path('../workspace.ts')}, () => ({
      ensureBase: async () => root, headSha: async () => 'abcdef',
      makeWorktree: async () => ({path: worktrees++ === 0 ? agent : clean, remove: async () => {}}),
      attachWorktree: (_base, path) => ({path, remove: async () => {}}),
    }));
    mock.module(${path('../gh.ts')}, () => ({
      issueBodies: async () => [], ensureLabel: async () => true,
      createIssue: async () => {published++; return 'https://github.com/o/r/issues/1';},
    }));
    const { reviewCodebase } = await import(${path('./reviewCodebase.ts')});
    const { DEFAULT_CONFIG } = await import(${path('../config.ts')});
    try {
      const ctx = {repo: 'o/r', info: {default_branch: 'main'}, cfg: structuredClone(DEFAULT_CONFIG),
        state: {markCodebaseReview() {}}, log() {}, maxBudgetUsd: null,
        provider: {run: async () => ({costUsd: 0, costEstimated: true, exhausted: false,
          output: {findings: [{title: 'Needs a fixture', severity: 'high', body: 'bug',
            reproduction: {setup: [], command: 'cat scratch'}, expect: {exitCode: 'zero', outputIncludes: 'synthetic-secret'}, observed: 'bug'}]}})},
      };
      const result = await reviewCodebase(ctx);
      assert.equal(result.outcome, 'unverified');
      assert.equal(published, 0);
      assert.equal(existsSync(join(clean, 'scratch')), false);
    } finally { rmSync(root, {recursive: true, force: true}); }
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
});
