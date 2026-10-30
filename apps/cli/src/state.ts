import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Provider, TaskKind, TaskOutcome } from '@idlehand/shared';
import { STATE_PATH } from './paths.ts';

// ponytail: bounded retries across runs; expose policy settings if projects need different limits.
export const MAX_TASK_ATTEMPTS = 3;
export const TASK_RETRY_DELAY_MS = 15 * 60_000;

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
  cost_unknown: number;
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
        cost_unknown INTEGER NOT NULL DEFAULT 0,
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
    if (!(this.db.query('PRAGMA table_info(tasks)').all() as { name: string }[]).some((c) => c.name === 'cost_unknown')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN cost_unknown INTEGER NOT NULL DEFAULT 0');
    }
  }

  startTask(t: { repo: string; kind: TaskKind; target: string; provider: Provider }): number {
    const r = this.db
      .query(
        `INSERT INTO tasks (repo, kind, target, provider, outcome, started_at) VALUES (?, ?, ?, ?, 'running', ?) RETURNING id`,
      )
      .get(t.repo, t.kind, t.target, t.provider, new Date().toISOString()) as { id: number };
    return r.id;
  }

  finishTask(id: number, r: { outcome: TaskOutcome; url: string | null; summary: string; costUsd: number; costEstimated: boolean; costUnknown?: boolean; durationMs: number }) {
    this.db
      .query(
        `UPDATE tasks SET outcome=?, url=?, summary=?, cost_usd=?, cost_estimated=?, cost_unknown=?, duration_ms=?, finished_at=? WHERE id=?`,
      )
      .run(r.outcome, r.url, r.summary.slice(0, 4000), r.costUsd, r.costEstimated ? 1 : 0, r.costUnknown ? 1 : 0, r.durationMs, new Date().toISOString(), id);
  }

  /** Completed work stays handled. Tool/agent failures get bounded retries after a cooldown. */
  seen(repo: string, kind: TaskKind, target: string, now = new Date()): boolean {
    const rows = this.db.query(`SELECT outcome, finished_at FROM tasks WHERE repo=? AND kind=? AND target=? ORDER BY id DESC`)
      .all(repo, kind, target) as Pick<TaskRow, 'outcome' | 'finished_at'>[];
    if (!rows.length) return false;
    if (rows.some((r) => r.outcome !== 'failed')) return true;
    if (rows.length >= MAX_TASK_ATTEMPTS) return true;
    const finishedAt = Date.parse(rows[0]!.finished_at ?? '');
    return !Number.isFinite(finishedAt) || now.getTime() - finishedAt < TASK_RETRY_DELAY_MS;
  }

  /** Mark stale 'running' rows (from a crashed run) as failed. */
  reapRunning(): number {
    const r = this.db.query(`UPDATE tasks SET outcome='failed', cost_unknown=1, cost_estimated=1, finished_at=? WHERE outcome='running'`).run(new Date().toISOString());
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
  totals(sinceIso: string): { spentUsd: number; tasks: number; estimated: boolean; costUnknown: boolean } {
    const r = this.db
      .query(`SELECT COALESCE(SUM(cost_usd),0) AS spent, COUNT(*) AS n, MAX(cost_estimated) AS est, MAX(cost_unknown) AS unknown_cost FROM tasks WHERE started_at >= ? AND outcome != 'running'`)
      .get(sinceIso) as { spent: number; n: number; est: number | null; unknown_cost: number | null };
    return { spentUsd: r.spent, tasks: r.n, estimated: !!r.est, costUnknown: !!r.unknown_cost };
  }

  close() {
    this.db.close();
  }
}
