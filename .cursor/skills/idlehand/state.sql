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
  finished_at TEXT,
  checkpoint TEXT
);
CREATE INDEX IF NOT EXISTS tasks_repo_target ON tasks(repo, kind, target);
CREATE TABLE IF NOT EXISTS codebase_reviews (
  repo TEXT PRIMARY KEY,
  reviewed_at TEXT NOT NULL,
  sha TEXT NOT NULL
);
