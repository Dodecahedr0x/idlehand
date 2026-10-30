import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Provider, TaskKind, TaskOutcome } from '@idlehand/shared';
import { STATE_PATH } from './paths.ts';

export interface TaskRow {
  id: number;
  repo: string;
  kind: TaskKind;
  target: string; // "pr:123" | "issue:45" | "codebase:<sha>"
  provider: Provider;
  outcome: TaskOutcome | 'running';
  url: string | null;
  summary: string | null;
  cost_usd: number;
  cost_estimated: number;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
}

export class State {
  readonly db: Database;
  constructor(path = STATE_PATH) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        provider TEXT NOT NULL,
        outcome TEXT NOT NULL,
        url TEXT,
        summary TEXT,
        cost_usd REAL NOT NULL DEFAULT 0,
        cost_estimated INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_repo_target ON tasks(repo, kind, target);
      CREATE TABLE IF NOT EXISTS codebase_reviews (
        repo TEXT PRIMARY KEY,
        reviewed_at TEXT NOT NULL,
        sha TEXT NOT NULL
      );
    `);
  }

  startTask(t: { repo: string; kind: TaskKind; target: string; provider: Provider }): number {
    const r = this.db
      .query(
        `INSERT INTO tasks (repo, kind, target, provider, outcome, started_at) VALUES (?, ?, ?, ?, 'running', ?) RETURNING id`,
      )
      .get(t.repo, t.kind, t.target, t.provider, new Date().toISOString()) as { id: number };
    return r.id;
  }

  finishTask(id: number, r: { outcome: TaskOutcome; url: string | null; summary: string; costUsd: number; costEstimated: boolean; durationMs: number }) {
    this.db
      .query(
        `UPDATE tasks SET outcome=?, url=?, summary=?, cost_usd=?, cost_estimated=?, duration_ms=?, finished_at=? WHERE id=?`,
      )
      .run(r.outcome, r.url, r.summary.slice(0, 4000), r.costUsd, r.costEstimated ? 1 : 0, r.durationMs, new Date().toISOString(), id);
  }

  /** Has this exact target already been handled (any terminal outcome, or currently running)? */
  seen(repo: string, kind: TaskKind, target: string): boolean {
    const r = this.db.query(`SELECT 1 FROM tasks WHERE repo=? AND kind=? AND target=? LIMIT 1`).get(repo, kind, target);
    return !!r;
  }

  /** Mark stale 'running' rows (from a crashed run) as failed. */
  reapRunning(): number {
    const r = this.db.query(`UPDATE tasks SET outcome='failed', finished_at=? WHERE outcome='running'`).run(new Date().toISOString());
    return r.changes;
  }

  lastCodebaseReview(repo: string): { reviewed_at: string; sha: string } | null {
    return (this.db.query(`SELECT reviewed_at, sha FROM codebase_reviews WHERE repo=?`).get(repo) as { reviewed_at: string; sha: string } | null) ?? null;
  }

  markCodebaseReview(repo: string, sha: string) {
    this.db
      .query(`INSERT INTO codebase_reviews (repo, reviewed_at, sha) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET reviewed_at=excluded.reviewed_at, sha=excluded.sha`)
      .run(repo, new Date().toISOString(), sha);
  }

  recent(limit = 20): TaskRow[] {
    return this.db.query(`SELECT * FROM tasks ORDER BY id DESC LIMIT ?`).all(limit) as TaskRow[];
  }

  /** Spend + task counts since an ISO timestamp. */
  totals(sinceIso: string): { spentUsd: number; tasks: number; estimated: boolean } {
    const r = this.db
      .query(`SELECT COALESCE(SUM(cost_usd),0) AS spent, COUNT(*) AS n, MAX(cost_estimated) AS est FROM tasks WHERE started_at >= ? AND outcome != 'running'`)
      .get(sinceIso) as { spent: number; n: number; est: number | null };
    return { spentUsd: r.spent, tasks: r.n, estimated: !!r.est };
  }

  close() {
    this.db.close();
  }
}
