import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from './shell.ts';
import { githubCommitIdentity } from './gh.ts';
import { commitAll, commitArgs, diffStat, stageChanges, stageForced } from './workspace.ts';

test('a fix commit is authored as the logged-in GitHub user', () => {
  const author = githubCommitIdentity({ login: 'octocat', id: 7, name: 'The Octocat' });
  expect(author).toEqual({ name: 'The Octocat', email: '7+octocat@users.noreply.github.com' });
  expect(githubCommitIdentity({ login: 'octocat', id: 7, name: '  ' }).name).toBe('octocat');
  const args = commitArgs(author, { sign: false, key: null }, 'Fix #1');
  expect(args).toContain('user.name=The Octocat');
  expect(args).toContain('user.email=7+octocat@users.noreply.github.com');
  expect(args.join(' ')).not.toContain('idlehand');
  expect(commitArgs(author, { sign: true, key: 'ABC' }, 'Fix #1')).toContain('user.signingkey=ABC');
});

test('commitAll records the GitHub author on the commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlehand-author-'));
  const git = async (...args: string[]) => {
    const result = await exec(['git', ...args], { cwd: dir });
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  try {
    await git('init', '--quiet');
    await git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'fix.ts'), 'export const fixed = true;\n');
    const author = githubCommitIdentity({ login: 'octocat', id: 7, name: null });
    await commitAll(dir, 'Fix #1: example', author);
    expect(await git('log', '-1', '--format=%an <%ae>')).toBe('octocat <7+octocat@users.noreply.github.com>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a claim file is committed even when its directory is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlehand-claim-'));
  const git = async (...args: string[]) => {
    const result = await exec(['git', ...args], { cwd: dir });
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  try {
    await git('init', '--quiet');
    await git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, '.gitignore'), '.github/\n');
    await git('add', '-A');
    await git('-c', 'user.name=idlehand', '-c', 'user.email=idlehand@users.noreply.github.com', 'commit', '--quiet', '-m', 'init');
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github/idlehand-claim'), '#7\n');
    await stageForced(dir, '.github/idlehand-claim');
    await commitAll(dir, 'Reserve #7', { name: 'octocat', email: '7+octocat@users.noreply.github.com' });
    expect(await git('ls-tree', '-r', '--name-only', 'HEAD')).toContain('.github/idlehand-claim');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preparing a fix preserves new source and tests while ignoring build artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlehand-publish-'));
  const git = async (...args: string[]) => {
    const result = await exec(['git', ...args], { cwd: dir });
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  try {
    await git('init', '--quiet');
    writeFileSync(join(dir, '.gitignore'), 'generated.log\n');
    writeFileSync(join(dir, 'existing.ts'), 'export const fixed = false;\n');
    await git('add', '-A');
    const baseline = await git('write-tree');
    writeFileSync(join(dir, 'existing.ts'), 'export const fixed = true;\n');
    writeFileSync(join(dir, 'new-module.ts'), 'export const result = 42;\n');
    writeFileSync(join(dir, 'regression.test.ts'), 'test("regression", () => {});\n');
    writeFileSync(join(dir, 'generated.log'), 'ignored build output\n');

    await stageChanges(dir);
    expect(await git('diff', '--cached', '--name-only', baseline)).toBe('existing.ts\nnew-module.ts\nregression.test.ts');
    const stat = await diffStat(dir, baseline);
    expect(stat).toContain('new-module.ts');
    expect(stat).toContain('regression.test.ts');
    expect(readFileSync(join(dir, 'regression.test.ts'), 'utf8')).toContain('regression');
    expect(existsSync(join(dir, 'generated.log'))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parallel tasks on one repo get distinct worktrees', async () => {
  const home = mkdtempSync(join(tmpdir(), 'idlehand-worktrees-'));
  const file = (name: string) => JSON.stringify(new URL(name, import.meta.url).pathname);
  const source = `
    import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import assert from 'node:assert/strict';
    const { exec } = await import(${file('./shell.ts')});
    const { makeWorktree } = await import(${file('./workspace.ts')});
    const root = mkdtempSync(join(tmpdir(), 'idlehand-base-'));
    const git = async (...args) => {
      const result = await exec(['git', ...args], { cwd: root });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    };
    const trees = [];
    try {
      await git('init', '--quiet', '-b', 'main');
      writeFileSync(join(root, 'README'), 'base\\n');
      await git('add', 'README');
      await git('-c', 'user.name=idlehand', '-c', 'user.email=idlehand@users.noreply.github.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'init');
      trees.push(...await Promise.all([
        makeWorktree('o/r', root, 'HEAD', 'pr-1'),
        makeWorktree('o/r', root, 'HEAD', 'pr-1'),
        makeWorktree('o/r', root, 'HEAD', 'issue-2', 'idlehand/issue-2'),
        makeWorktree('o/r', root, 'HEAD', 'issue-3', 'idlehand/issue-3'),
      ]));
      const [a, b] = trees;
      assert.equal(new Set(trees.map((tree) => tree.path)).size, trees.length);
      assert.notEqual(a.path, b.path);
      assert.equal(readFileSync(join(a.path, 'README'), 'utf8'), 'base\\n');
      assert.equal(readFileSync(join(b.path, 'README'), 'utf8'), 'base\\n');
      writeFileSync(join(a.path, 'a.txt'), 'a\\n');
      writeFileSync(join(b.path, 'b.txt'), 'b\\n');
      assert.equal(existsSync(join(a.path, 'b.txt')), false);
      assert.equal(existsSync(join(b.path, 'a.txt')), false);
    } finally {
      for (const tree of trees) await tree.remove();
      rmSync(root, { recursive: true, force: true });
    }
  `;
  const child = Bun.spawn([process.execPath, '-e', source], { env: { ...process.env, IDLEHAND_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  rmSync(home, { recursive: true, force: true });
  expect(stderr).toBe('');
  expect(stdout).toBe('');
  expect(code).toBe(0);
});
