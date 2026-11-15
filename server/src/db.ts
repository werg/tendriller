// SQLite storage for the Tendril Durable Object (PROTOCOL section 3).

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used INTEGER);
CREATE TABLE IF NOT EXISTS socket_tickets (hash TEXT PRIMARY KEY, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS streams (name TEXT PRIMARY KEY, durability TEXT NOT NULL, readers TEXT NOT NULL,
  max_records INTEGER, max_age_seconds INTEGER, latest_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS stream_records (stream TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, producer TEXT NOT NULL, producer_key TEXT NOT NULL, id TEXT NOT NULL,
  bytes INTEGER NOT NULL, PRIMARY KEY(stream,seq), UNIQUE(stream,producer_key,id));
CREATE INDEX IF NOT EXISTS stream_records_retention ON stream_records(stream,received_at);
CREATE TABLE IF NOT EXISTS stream_producers (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, streams TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS stream_rate (principal TEXT PRIMARY KEY, minute INTEGER NOT NULL, requests INTEGER NOT NULL, bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stream_counters (name TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, key TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  label TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, created_by_agent INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS guest_accounts (account_id TEXT NOT NULL, link_id TEXT NOT NULL, approved INTEGER NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (account_id, link_id));
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
CREATE TABLE IF NOT EXISTS event_consumers (name TEXT PRIMARY KEY, handled_seq INTEGER NOT NULL, delivered_seq INTEGER NOT NULL,
  gap_from INTEGER, gap_through INTEGER, holder TEXT, lease_hash TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, device TEXT, version INTEGER,
  level TEXT NOT NULL, message TEXT NOT NULL, stack TEXT);
CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, type TEXT, size INTEGER NOT NULL, name TEXT, ts INTEGER NOT NULL,
  device TEXT, source TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS stored_files (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trusted_versions (account_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (account_id, version));
CREATE TABLE IF NOT EXISTS page_sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, role TEXT NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ws_rate (device_id TEXT PRIMARY KEY, second INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notify_rate (hour INTEGER PRIMARY KEY, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS visitor_signals (kind TEXT NOT NULL, value_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL, PRIMARY KEY (kind, value_hash));
CREATE INDEX IF NOT EXISTS visitor_signals_time ON visitor_signals (kind, first_seen);
CREATE TABLE IF NOT EXISTS release_events (at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, device TEXT, blob TEXT, by TEXT, source TEXT NOT NULL, agg_key TEXT, agg TEXT);
CREATE INDEX IF NOT EXISTS activity_agg ON activity (agg_key);
CREATE TABLE IF NOT EXISTS push_subs (device TEXT PRIMARY KEY, sub TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dedupe (key TEXT PRIMARY KEY, ts INTEGER NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, src TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS timers (id TEXT PRIMARY KEY, spec TEXT NOT NULL, next_at INTEGER NOT NULL, state TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS timers_due ON timers (state, next_at);
CREATE TABLE IF NOT EXISTS timer_runs (id TEXT PRIMARY KEY, timer_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL,
  fired_at INTEGER NOT NULL, status TEXT NOT NULL, event_seq INTEGER, notification TEXT);
CREATE TABLE IF NOT EXISTS timer_notifications (run_id TEXT PRIMARY KEY, timer_id TEXT NOT NULL, payload TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, attempt_token TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_attempt_at INTEGER, last_error TEXT,
  pending_devices TEXT, sent_devices TEXT NOT NULL DEFAULT '[]', failed_devices TEXT NOT NULL DEFAULT '[]',
  sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS timer_notifications_due ON timer_notifications (state, next_at);
CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS participant_responses (id TEXT PRIMARY KEY, participant TEXT NOT NULL, prompt_id TEXT NOT NULL,
  answer TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(participant, prompt_id));
CREATE TABLE IF NOT EXISTS participant_assignments (id TEXT PRIMARY KEY, participant TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS assignments_participant ON participant_assignments(participant, updated_at);
CREATE TABLE IF NOT EXISTS session_archives (id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL, request TEXT NOT NULL, data TEXT NOT NULL);
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
    const deviceColumns = this.sql.exec("PRAGMA table_info(devices)").toArray() as { name: string }[];
    if (!deviceColumns.some(c => c.name === "purpose")) this.sql.exec("ALTER TABLE devices ADD COLUMN purpose TEXT NOT NULL DEFAULT 'general'");
    const blobColumns = this.sql.exec("PRAGMA table_info(blobs)").toArray() as { name: string }[];
    if (!blobColumns.some((column) => column.name === "pinned")) this.sql.exec("ALTER TABLE blobs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    const columns = this.sql.exec("PRAGMA table_info(links)").toArray() as { name: string }[];
    if (!columns.some((c) => c.name === "created_by_agent")) {
      this.sql.exec("ALTER TABLE links ADD COLUMN created_by_agent INTEGER NOT NULL DEFAULT 0");
      // Existing guest/display links have no provenance. Treat them as agent
      // links on migration so they cannot silently gain owner-only privileges.
      this.sql.exec("UPDATE links SET created_by_agent = 1 WHERE role IN ('guest', 'display')");
    }
    const fileColumns = this.sql.exec("PRAGMA table_info(stored_files)").toArray() as { name: string }[];
    if (!fileColumns.some(c => c.name === "risk_score")) this.sql.exec("ALTER TABLE stored_files ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0");
    // Remove the retired URL lookup cache from existing Durable Objects.
    this.sql.exec("DROP TABLE IF EXISTS web_risk_cache");
    const versionColumns = this.sql.exec("PRAGMA table_info(versions)").toArray() as { name: string }[];
    if (!versionColumns.some(c => c.name === "risk_score")) this.sql.exec("ALTER TABLE versions ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0");
    if (!versionColumns.some(c => c.name === "risk_flags")) this.sql.exec("ALTER TABLE versions ADD COLUMN risk_flags TEXT NOT NULL DEFAULT '[]'");
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
