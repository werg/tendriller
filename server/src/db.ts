// SQLite storage for the Tendril Durable Object (PROTOCOL section 3).

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used INTEGER);
CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, key TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  label TEXT, created_at INTEGER NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, name TEXT, role TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0, pair_code TEXT, link TEXT, ua TEXT, caps TEXT,
  created_at INTEGER NOT NULL, last_seen INTEGER, last_active INTEGER);
CREATE TABLE IF NOT EXISTS versions (version INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL,
  message TEXT, errors TEXT, first_served_at INTEGER, by TEXT, failed_event INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS version_files (version INTEGER NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
  type TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (version, path));
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL,
  data TEXT, device TEXT, role TEXT, wake INTEGER NOT NULL, withheld INTEGER NOT NULL, by TEXT);
CREATE INDEX IF NOT EXISTS events_wake ON events (wake, seq);
CREATE TABLE IF NOT EXISTS logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, device TEXT, version INTEGER,
  level TEXT NOT NULL, message TEXT NOT NULL, stack TEXT);
CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, type TEXT, size INTEGER NOT NULL, name TEXT, ts INTEGER NOT NULL,
  device TEXT, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, device TEXT, blob TEXT, by TEXT, source TEXT NOT NULL, agg_key TEXT, agg TEXT);
CREATE INDEX IF NOT EXISTS activity_agg ON activity (agg_key);
CREATE TABLE IF NOT EXISTS push_subs (device TEXT PRIMARY KEY, sub TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dedupe (key TEXT PRIMARY KEY, ts INTEGER NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, src TEXT NOT NULL, text TEXT NOT NULL);
`;

type Bindable = string | number | null | ArrayBuffer;

function norm(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || v instanceof ArrayBuffer) return v;
  return JSON.stringify(v);
}

export class Db {
  private cache = new Map<string, unknown>();

  constructor(private sql: SqlStorage) {}

  init(): void {
    this.sql.exec(SCHEMA);
  }

  all<T = Record<string, any>>(query: string, ...args: unknown[]): T[] {
    return this.sql.exec(query, ...args.map(norm)).toArray() as T[];
  }

  one<T = Record<string, any>>(query: string, ...args: unknown[]): T | null {
    return (this.all<T>(query, ...args)[0] ?? null) as T | null;
  }

  run(query: string, ...args: unknown[]): void {
    this.sql.exec(query, ...args.map(norm)).toArray();
  }

  get<T>(k: string, def: T): T {
    if (this.cache.has(k)) return this.cache.get(k) as T;
    const row = this.one<{ v: string }>("SELECT v FROM meta WHERE k = ?", k);
    const v = row ? (JSON.parse(row.v) as T) : def;
    if (row) this.cache.set(k, v);
    return v;
  }

  set(k: string, v: unknown): void {
    if (v === undefined || v === null) {
      this.del(k);
      return;
    }
    this.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
    this.cache.set(k, v);
  }

  del(k: string): void {
    this.run("DELETE FROM meta WHERE k = ?", k);
    this.cache.delete(k);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
