// SQLite storage for the Tendril Durable Object (PROTOCOL section 3).

/** Persistent storage identity, independent of runtime and workflow releases. */
export const STORAGE_SCHEMA_REVISION = 2;

export class StorageSchemaError extends Error {
  readonly code = 'storage_schema_mismatch';

  constructor(reason: string) {
    super(`Incompatible Tendriller storage schema: ${reason}. Expected revision ${STORAGE_SCHEMA_REVISION}. Deploy this release to a fresh Durable Object namespace; existing data was not changed.`);
    this.name = 'StorageSchemaError';
  }
}

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
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, name TEXT, role TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'general',
  pending INTEGER NOT NULL DEFAULT 0, pair_code TEXT, link TEXT, ua TEXT, caps TEXT,
  created_at INTEGER NOT NULL, last_seen INTEGER, last_active INTEGER);
CREATE TABLE IF NOT EXISTS versions (version INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL, runtime_id TEXT NOT NULL, runtime_version TEXT NOT NULL, runtime_features TEXT NOT NULL,
  message TEXT, errors TEXT, by TEXT, failed_event INTEGER NOT NULL DEFAULT 0, risk_score INTEGER NOT NULL DEFAULT 0, risk_flags TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS publication_leases (device TEXT NOT NULL, version INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(device,version));
CREATE TABLE IF NOT EXISTS version_files (version INTEGER NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
  type TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (version, path));
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL,
  context TEXT, data TEXT, device TEXT, role TEXT, wake INTEGER NOT NULL, withheld INTEGER NOT NULL, by TEXT);
CREATE INDEX IF NOT EXISTS events_wake ON events (wake, seq);
CREATE TABLE IF NOT EXISTS event_consumers (name TEXT PRIMARY KEY, handled_seq INTEGER NOT NULL, delivered_seq INTEGER NOT NULL,
  gap_from INTEGER, gap_through INTEGER, holder TEXT, lease_hash TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, device TEXT, version INTEGER,
  level TEXT NOT NULL, message TEXT NOT NULL, stack TEXT);
CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, type TEXT, size INTEGER NOT NULL, name TEXT, ts INTEGER NOT NULL,
  device TEXT, source TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS stored_files (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL, risk_score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('writing','ready','deleting')));
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
CREATE TABLE IF NOT EXISTS transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL, src TEXT NOT NULL, text TEXT NOT NULL, cid TEXT, device TEXT, in_reply_to INTEGER);
CREATE TABLE IF NOT EXISTS timers (id TEXT PRIMARY KEY, spec TEXT NOT NULL, next_at INTEGER NOT NULL, state TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS timers_due ON timers (state, next_at);
CREATE TABLE IF NOT EXISTS timer_runs (id TEXT PRIMARY KEY, timer_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL,
  fired_at INTEGER NOT NULL, status TEXT NOT NULL, event_seq INTEGER);
CREATE TABLE IF NOT EXISTS timer_notifications (run_id TEXT PRIMARY KEY, timer_id TEXT NOT NULL, payload TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, attempt_token TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_attempt_at INTEGER, last_error TEXT,
  pending_devices TEXT, sent_devices TEXT NOT NULL DEFAULT '[]', failed_devices TEXT NOT NULL DEFAULT '[]',
  sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS timer_notifications_due ON timer_notifications (state, next_at);
CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, generation TEXT NOT NULL, paths TEXT NOT NULL, operations TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, owner TEXT);
CREATE TABLE IF NOT EXISTS commands (actor TEXT NOT NULL, cid TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(actor,cid));
CREATE TABLE IF NOT EXISTS command_usage (id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL, bytes INTEGER NOT NULL);
INSERT OR IGNORE INTO command_usage(id,count,bytes) VALUES(1,0,0);
CREATE TABLE IF NOT EXISTS workflow_records (module TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(module,collection,key));
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
  private readonly sql: SqlStorage;

  constructor(private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>) {
    this.sql = storage.sql;
  }

  init(): void {
    this.storage.transactionSync(() => {
      // SQLite and the storage implementation own their reserved internal objects.
      // Every application schema must identify itself before any initialization.
      const objects = this.all<{ name: string; type: string }>(
        "SELECT name,type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'",
      );
      const identity = objects.find(object => object.name === 'storage_schema');
      if (identity) {
        if (identity.type !== 'table') throw new StorageSchemaError('the schema identity is not a table');
        let rows: { id: number; revision: number }[];
        try { rows = this.all('SELECT id,revision FROM storage_schema'); }
        catch { throw new StorageSchemaError('the schema identity is malformed'); }
        if (rows.length !== 1 || rows[0].id !== 1 || rows[0].revision !== STORAGE_SCHEMA_REVISION)
          throw new StorageSchemaError('the stored schema identity does not match this release');
        return;
      }
      if (objects.length) throw new StorageSchemaError('existing application tables have no schema identity');

      this.sql.exec(SCHEMA);
      this.sql.exec('CREATE TABLE storage_schema (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)');
      this.sql.exec('INSERT INTO storage_schema(id,revision) VALUES(1,?)', STORAGE_SCHEMA_REVISION);
    });
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
