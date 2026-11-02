import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { Me, PopularRepo, RepoCard, RunReport, SelectedRepo, StoredRunReport, TaskOutcome } from '@idlehand/shared';

export interface UserRow {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  access_token: string | null;
  session_version: number;
  created_at: string;
}

export interface RepoRow {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  private: number;
  default_branch: string | null;
  language: string | null;
  stars: number;
  updated_at: string;
}

export interface DeviceCodeRow {
  device_code: string;
  user_code: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  user_id: number | null;
  token: string | null;
  created_at: string;
  expires_at: string;
}

export interface RepoInput {
  owner: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string | null;
  language: string | null;
  stars: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  access_token TEXT,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  description TEXT,
  html_url TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  language TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS selections (
  user_id INTEGER NOT NULL REFERENCES users(id),
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, repo_id)
);
CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id INTEGER,
  token TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cli_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS run_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  repo_full_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  outcome TEXT NOT NULL,
  url TEXT,
  summary TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_estimated INTEGER NOT NULL DEFAULT 0,
  cost_unknown INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_run_reports_user ON run_reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_reports_repo ON run_reports(repo_full_name, created_at DESC);
`;

export const CLI_TOKEN_TTL_MS = 60 * 60 * 24 * 30 * 1000;
const SEALED_TOKEN_PREFIX = 'enc:';

function nowIso(): string {
  return new Date().toISOString();
}

function tokenKey(secret: string): Buffer {
  return createHash('sha256').update('idlehand.access_token.v1\0').update(secret).digest();
}

function sealToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${SEALED_TOKEN_PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function openToken(stored: string, key: Buffer): string | null {
  if (!stored.startsWith(SEALED_TOKEN_PREFIX)) return stored;
  const [ivB64, tagB64, dataB64] = stored.slice(SEALED_TOKEN_PREFIX.length).split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const chars = Array.from(buf, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export function repoRowToCard(r: RepoRow): RepoCard {
  return {
    owner: r.owner,
    name: r.name,
    fullName: r.full_name,
    description: r.description,
    htmlUrl: r.html_url,
    private: !!r.private,
    defaultBranch: r.default_branch,
    language: r.language,
    stars: r.stars,
  };
}

export function userToMe(u: UserRow): Me {
  return { id: u.id, login: u.login, avatarUrl: u.avatar_url, name: u.name };
}

export class Store {
  readonly db: Database;
  private readonly tokenKey: Buffer | null;

  constructor(path: string = ':memory:', tokenSecret = '') {
    this.db = new Database(path, { create: true });
    this.tokenKey = tokenSecret ? tokenKey(tokenSecret) : null;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.ensureColumn('run_reports', 'cost_unknown', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('users', 'session_version', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('cli_tokens', 'expires_at', 'TEXT');
    this.ensureColumn('cli_tokens', 'revoked_at', 'TEXT');
    this.resealPlaintextTokens();
  }

  private resealPlaintextTokens(): void {
    if (!this.tokenKey) return;
    const rows = this.db
      .query<{ id: number; access_token: string }, []>("SELECT id, access_token FROM users WHERE access_token IS NOT NULL AND access_token NOT LIKE 'enc:%'")
      .all();
    for (const row of rows) {
      this.db.query('UPDATE users SET access_token = ? WHERE id = ?').run(sealToken(row.access_token, this.tokenKey), row.id);
    }
  }

  private ensureColumn(table: string, name: string, spec: string): void {
    if ((this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === name)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${spec}`);
  }

  private encodeAccessToken(token: string | null): string | null {
    if (token == null) return null;
    return this.tokenKey ? sealToken(token, this.tokenKey) : token;
  }

  private decodeAccessToken(stored: string | null): string | null {
    if (stored == null) return null;
    return this.tokenKey ? openToken(stored, this.tokenKey) : stored;
  }

  private hydrateUser(row: UserRow | null): UserRow | null {
    if (!row) return null;
    return { ...row, session_version: row.session_version ?? 0, access_token: this.decodeAccessToken(row.access_token) };
  }

  close(): void {
    this.db.close();
  }

  /* ---- users ---- */

  upsertUser(u: { id: number; login: string; name: string | null; avatarUrl: string | null; accessToken: string | null }): UserRow {
    this.db
      .query(
        `INSERT INTO users (id, login, name, avatar_url, access_token) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
           access_token = COALESCE(excluded.access_token, users.access_token)`,
      )
      .run(u.id, u.login, u.name, u.avatarUrl, this.encodeAccessToken(u.accessToken));
    return this.getUser(u.id)!;
  }

  getUser(id: number): UserRow | null {
    return this.hydrateUser(this.db.query<UserRow, [number]>('SELECT * FROM users WHERE id = ?').get(id) ?? null);
  }

  clearAccessToken(userId: number): void {
    this.db.query('UPDATE users SET access_token = NULL WHERE id = ?').run(userId);
  }

  bumpSessionVersion(userId: number): number {
    this.db.query('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(userId);
    return this.getUser(userId)?.session_version ?? 0;
  }

  /* ---- repos ---- */

  upsertRepo(r: RepoInput): RepoRow {
    const fullName = `${r.owner}/${r.name}`;
    this.db
      .query(
        `INSERT INTO repos (owner, name, full_name, description, html_url, private, default_branch, language, stars, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(full_name) DO UPDATE SET owner = excluded.owner, name = excluded.name, description = excluded.description,
           html_url = excluded.html_url, private = excluded.private, default_branch = excluded.default_branch,
           language = excluded.language, stars = excluded.stars, updated_at = excluded.updated_at`,
      )
      .run(r.owner, r.name, fullName, r.description, r.htmlUrl, r.private ? 1 : 0, r.defaultBranch, r.language, r.stars, nowIso());
    return this.getRepoByFullName(fullName)!;
  }

  getRepoByFullName(fullName: string): RepoRow | null {
    return this.db.query<RepoRow, [string]>('SELECT * FROM repos WHERE full_name = ? COLLATE NOCASE').get(fullName) ?? null;
  }

  selectedByCount(repoId: number): number {
    const row = this.db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM selections WHERE repo_id = ?').get(repoId);
    return row?.n ?? 0;
  }

  /** Attach `selected` / `selectedBy` to cards given the signed-in user (or null). */
  decorateCards(cards: RepoCard[], userId: number | null): RepoCard[] {
    return cards.map((c) => {
      const row = this.getRepoByFullName(c.fullName);
      if (!row) return { ...c, selected: userId == null ? undefined : false, selectedBy: 0 };
      const selected =
        userId == null
          ? undefined
          : !!this.db
              .query<{ x: number }, [number, number]>('SELECT 1 AS x FROM selections WHERE user_id = ? AND repo_id = ?')
              .get(userId, row.id);
      return { ...c, selected, selectedBy: this.selectedByCount(row.id) };
    });
  }

  /* ---- selections ---- */

  addSelection(userId: number, repoId: number): void {
    this.db.query('INSERT OR IGNORE INTO selections (user_id, repo_id) VALUES (?, ?)').run(userId, repoId);
  }

  removeSelection(userId: number, repoId: number): boolean {
    const res = this.db.query('DELETE FROM selections WHERE user_id = ? AND repo_id = ?').run(userId, repoId);
    return res.changes > 0;
  }

  isSelected(userId: number, repoId: number): boolean {
    return !!this.db.query('SELECT 1 FROM selections WHERE user_id = ? AND repo_id = ?').get(userId, repoId);
  }

  listSelections(userId: number): SelectedRepo[] {
    const rows = this.db
      .query<RepoRow & { selected_at: string }, [number]>(
        `SELECT r.*, s.created_at AS selected_at FROM selections s JOIN repos r ON r.id = s.repo_id
         WHERE s.user_id = ? ORDER BY s.created_at DESC`,
      )
      .all(userId);
    return rows.map((r) => ({
      ...repoRowToCard(r),
      selected: true,
      selectedBy: this.selectedByCount(r.id),
      selectedAt: r.selected_at,
    }));
  }

  listPopular(limit: number, userId: number | null): PopularRepo[] {
    const rows = this.db
      .query<RepoRow & { n: number }, [number]>(
        `SELECT r.*, COUNT(s.user_id) AS n FROM repos r JOIN selections s ON s.repo_id = r.id
         GROUP BY r.id ORDER BY n DESC, r.stars DESC, r.full_name ASC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => ({
      ...repoRowToCard(r),
      selectedBy: r.n,
      selected: userId == null ? undefined : this.isSelected(userId, r.id),
    }));
  }

  /* ---- device codes ---- */

  createDeviceCode(ttlMs: number): DeviceCodeRow {
    const deviceCode = randomHex(32);
    let userCode = randomUserCode();
    // extremely unlikely collision; retry a few times
    for (let i = 0; i < 5 && this.getDeviceCodeByUserCode(userCode); i++) userCode = randomUserCode();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db
      .query('INSERT INTO device_codes (device_code, user_code, status, expires_at) VALUES (?, ?, ?, ?)')
      .run(deviceCode, userCode, 'pending', expiresAt);
    return this.getDeviceCode(deviceCode)!;
  }

  getDeviceCode(deviceCode: string): DeviceCodeRow | null {
    const row = this.db.query<DeviceCodeRow, [string]>('SELECT * FROM device_codes WHERE device_code = ?').get(deviceCode);
    return row ? this.expireIfNeeded(row) : null;
  }

  getDeviceCodeByUserCode(userCode: string): DeviceCodeRow | null {
    const row = this.db
      .query<DeviceCodeRow, [string]>('SELECT * FROM device_codes WHERE user_code = ? COLLATE NOCASE')
      .get(userCode.trim().toUpperCase());
    return row ? this.expireIfNeeded(row) : null;
  }

  private expireIfNeeded(row: DeviceCodeRow): DeviceCodeRow {
    if (row.status === 'pending' && new Date(row.expires_at).getTime() < Date.now()) {
      this.db.query('UPDATE device_codes SET status = ? WHERE device_code = ?').run('expired', row.device_code);
      return { ...row, status: 'expired' };
    }
    return row;
  }

  approveDeviceCode(deviceCode: string, userId: number, label: string, ttlMs = CLI_TOKEN_TTL_MS): string {
    const token = randomHex(32);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.query('INSERT INTO cli_tokens (token, user_id, label, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, label, expiresAt);
    this.db
      .query('UPDATE device_codes SET status = ?, user_id = ?, token = ? WHERE device_code = ?')
      .run('approved', userId, token, deviceCode);
    return token;
  }

  denyDeviceCode(deviceCode: string): void {
    this.db.query('UPDATE device_codes SET status = ? WHERE device_code = ?').run('denied', deviceCode);
  }

  /** Hand out the token once; afterwards the row is deleted. */
  consumeDeviceCode(deviceCode: string): void {
    this.db.query('DELETE FROM device_codes WHERE device_code = ?').run(deviceCode);
  }

  /* ---- cli tokens ---- */

  userForCliToken(token: string): UserRow | null {
    const row = this.db
      .query<{ user_id: number; expires_at: string | null; revoked_at: string | null }, [string]>(
        'SELECT user_id, expires_at, revoked_at FROM cli_tokens WHERE token = ?',
      )
      .get(token);
    if (!row || row.revoked_at) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    this.db.query('UPDATE cli_tokens SET last_used_at = ? WHERE token = ?').run(nowIso(), token);
    return this.getUser(row.user_id);
  }

  revokeCliToken(token: string): boolean {
    const res = this.db.query('UPDATE cli_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL').run(nowIso(), token);
    return res.changes > 0;
  }

  getSetupStatus(userId: number): { cliConnected: boolean; contributionOutcome: TaskOutcome | null } {
    // Approval alone does not confirm the CLI received and used its token.
    const cliConnected = !!this.db
      .query(
        `SELECT 1 FROM cli_tokens WHERE user_id = ? AND last_used_at IS NOT NULL AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
      )
      .get(userId, nowIso());
    const result = this.db.query<{ outcome: TaskOutcome }, [number]>(
      `SELECT outcome FROM run_reports WHERE user_id = ?
       ORDER BY CASE WHEN outcome IN ('reviewed', 'merged', 'pr-opened', 'issues-filed') THEN 0 ELSE 1 END, id DESC LIMIT 1`,
    ).get(userId);
    return { cliConnected, contributionOutcome: result?.outcome ?? null };
  }

  /* ---- run reports ---- */

  addRunReport(userId: number, r: RunReport): StoredRunReport {
    const res = this.db
      .query(
        `INSERT INTO run_reports (user_id, repo_full_name, kind, provider, outcome, url, summary, cost_usd, cost_estimated, cost_unknown, duration_ms, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        r.repo.fullName,
        r.kind,
        r.provider,
        r.outcome,
        r.url,
        r.summary,
        r.costUsd,
        r.costEstimated ? 1 : 0,
        r.costUnknown ? 1 : 0,
        r.durationMs,
        r.startedAt,
      );
    return this.getRunReport(Number(res.lastInsertRowid))!;
  }

  getRunReport(id: number): StoredRunReport | null {
    const row = this.db.query<RunReportRow, [number]>(`${RUN_REPORT_SELECT} WHERE rr.id = ?`).get(id);
    return row ? runReportRowToStored(row) : null;
  }

  listRunReportsForUser(userId: number, limit: number): StoredRunReport[] {
    return this.db
      .query<RunReportRow, [number, number]>(`${RUN_REPORT_SELECT} WHERE rr.user_id = ? ORDER BY rr.created_at DESC LIMIT ?`)
      .all(userId, limit)
      .map(runReportRowToStored);
  }

  listRunReportsForRepo(fullName: string, limit: number): StoredRunReport[] {
    return this.db
      .query<RunReportRow, [string, number]>(
        `${RUN_REPORT_SELECT} WHERE rr.repo_full_name = ? COLLATE NOCASE ORDER BY rr.created_at DESC LIMIT ?`,
      )
      .all(fullName, limit)
      .map(runReportRowToStored);
  }
}

interface RunReportRow {
  id: number;
  login: string;
  repo_full_name: string;
  kind: string;
  provider: string;
  outcome: string;
  url: string | null;
  summary: string;
  cost_usd: number;
  cost_estimated: number;
  cost_unknown: number;
  duration_ms: number;
  started_at: string;
}

const RUN_REPORT_SELECT = `SELECT rr.*, u.login AS login FROM run_reports rr JOIN users u ON u.id = rr.user_id`;

function runReportRowToStored(r: RunReportRow): StoredRunReport {
  const [owner = '', name = ''] = r.repo_full_name.split('/');
  return {
    id: r.id,
    login: r.login,
    repo: { owner, name, fullName: r.repo_full_name },
    kind: r.kind as StoredRunReport['kind'],
    provider: r.provider as StoredRunReport['provider'],
    outcome: r.outcome as StoredRunReport['outcome'],
    url: r.url,
    summary: r.summary,
    costUsd: r.cost_usd,
    costEstimated: !!r.cost_estimated,
    costUnknown: !!r.cost_unknown,
    durationMs: r.duration_ms,
    startedAt: r.started_at,
  };
}
