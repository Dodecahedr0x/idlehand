import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunReport } from '@idlehand/shared';
import { Store } from './db.ts';

test('server accounting migrates existing reports and preserves unknown costs across reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'idlehand-server-accounting-'));
  const path = join(root, 'server.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(path);
    store.upsertUser({ id: 1, login: 'tester', name: null, avatarUrl: null, accessToken: null });
    const report: RunReport = {
      repo: { owner: 'o', name: 'r', fullName: 'o/r' }, kind: 'fix-issue', provider: 'codex', outcome: 'failed',
      url: null, summary: 'legacy', costUsd: 1.25, costEstimated: true, durationMs: 1, startedAt: new Date().toISOString(),
    };
    const legacy = store.addRunReport(1, report);
    store.db.exec('ALTER TABLE run_reports DROP COLUMN cost_unknown');
    store.close();
    store = new Store(path);
    expect(store.getRunReport(legacy.id)).toMatchObject({ costUsd: 1.25, costUnknown: false });
    const unknown = store.addRunReport(1, { ...report, costUnknown: true });
    store.close();
    store = new Store(path);
    expect(store.getRunReport(unknown.id)).toMatchObject({ costUsd: 1.25, costUnknown: true });
    expect(store.listRunReportsForUser(1, 10).find((r) => r.id === unknown.id)?.costUnknown).toBe(true);
    expect(store.listRunReportsForRepo(1, 'o/r', 10).find((r) => r.id === unknown.id)?.costUnknown).toBe(true);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
