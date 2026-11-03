import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, saveConfig } from './config.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function mode(path: string) {
  return statSync(path).mode & 0o777;
}

test('saveConfig writes owner-only modes and tightens a looser file and directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'idlehand-config-'));
  roots.push(root);
  const dir = join(root, 'home');
  const path = join(dir, 'config.json');
  const prev = process.umask(0);
  try {
    saveConfig(DEFAULT_CONFIG, path);
    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);

    chmodSync(dir, 0o755);
    chmodSync(path, 0o644);
    saveConfig(DEFAULT_CONFIG, path);
    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  } finally {
    process.umask(prev);
  }
});
