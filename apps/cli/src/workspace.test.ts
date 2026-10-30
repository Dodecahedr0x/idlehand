import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from './shell.ts';
import { diffStat, stageChanges } from './workspace.ts';

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
