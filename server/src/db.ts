// SQLite storage for the Tendril Durable Object (PROTOCOL section 3).

/** Persistent host storage identity, independent of runtime and application releases. */
export const STORAGE_SCHEMA_REVISION = 9;

export class StorageSchemaError extends Error {
  readonly code = 'storage_schema_mismatch';

  constructor(reason: string) {
    super(`Incompatible Tendriller storage schema: ${reason}. Expected revision ${STORAGE_SCHEMA_REVISION}. Deploy this release to a fresh Durable Object namespace; existing data was not changed.`);
    this.name = 'StorageSchemaError';
  }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS participant_records (key TEXT PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used INTEGER);
CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, key TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  label TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, created_by_agent INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS guest_accounts (account_id TEXT NOT NULL, link_id TEXT NOT NULL, approved INTEGER NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (account_id, link_id));
CREATE TABLE IF NOT EXISTS versions (version INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, runtime_id TEXT NOT NULL, runtime_version TEXT NOT NULL, runtime_features TEXT NOT NULL,
  entry TEXT NOT NULL DEFAULT 'index.html', message TEXT, by TEXT, risk_score INTEGER NOT NULL DEFAULT 0, risk_flags TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS version_files (version INTEGER NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
  type TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (version, path));
CREATE TABLE IF NOT EXISTS stored_files (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL, risk_score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('writing','ready','deleting')));
CREATE TABLE IF NOT EXISTS trusted_versions (account_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (account_id, version));
CREATE TABLE IF NOT EXISTS page_sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, role TEXT NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS visitor_signals (kind TEXT NOT NULL, value_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL, PRIMARY KEY (kind, value_hash));
CREATE INDEX IF NOT EXISTS visitor_signals_time ON visitor_signals (kind, first_seen);
CREATE TABLE IF NOT EXISTS release_events (at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, by TEXT, source TEXT NOT NULL);
`;

type Bindable = string | number | null | ArrayBuffer;
const MISSING = Symbol('missing metadata');
const MAX_CACHED_ENTRIES = 256;

function remember(cache: Map<string, unknown>, key: string, value: unknown): void {
  if (!cache.has(key) && cache.size >= MAX_CACHED_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

function norm(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || v instanceof ArrayBuffer) return v;
  return JSON.stringify(v);
}

export class Db {
  private cache = new Map<string, unknown>();
  private reads = new Map<string, unknown>();
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

      this.run(SCHEMA);
      this.run('CREATE TABLE storage_schema (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)');
      this.run('INSERT INTO storage_schema(id,revision) VALUES(1,?)', STORAGE_SCHEMA_REVISION);
    });
  }

  all<T = Record<string, any>>(query: string, ...args: unknown[]): T[] {
    // Only a single SELECT is known to be read-only. This also invalidates for
    // DDL and writes with RETURNING, including statements that write zero rows.
    if (!/^\s*SELECT\b/i.test(query) || query.includes(';')) this.clearCache();
    return this.execute<T>(query, args);
  }

  private execute<T>(query: string, args: unknown[]): T[] {
    try {
      const cursor = this.sql.exec(query, ...args.map(norm));
      try { return cursor.toArray() as T[]; }
      finally { if (cursor.rowsWritten) this.clearCache(); }
    } catch (error) {
      this.clearCache();
      throw error;
    }
  }

  one<T = Record<string, any>>(query: string, ...args: unknown[]): T | null {
    return (this.all<T>(query, ...args)[0] ?? null) as T | null;
  }

  run(query: string, ...args: unknown[]): void {
    this.all(query, ...args);
  }

  /** Instance-local reads only; SQL writes, rollback and eviction discard them. */
  cached<T>(key: string, read: () => T): T {
    if (this.reads.has(key)) return this.reads.get(key) as T;
    const value = read();
    remember(this.reads, key, value);
    return value;
  }

  cachedAsync<T>(key: string, read: () => Promise<T>): Promise<T> {
    return this.cached(key, () => {
      const value = read().catch(error => {
        if (this.reads.get(key) === value) this.reads.delete(key);
        throw error;
      });
      return value;
    });
  }

  get<T>(k: string, def: T): T {
    if (this.cache.has(k)) {
      const value = this.cache.get(k);
      return value === MISSING ? def : value as T;
    }
    const row = this.one<{ v: string }>("SELECT v FROM meta WHERE k = ?", k);
    const v = row ? (JSON.parse(row.v) as T) : def;
    // Publication reads may probe arbitrary missing identities. Bound metadata
    // misses as well as present values so read-only requests cannot grow memory.
    remember(this.cache, k, row ? v : MISSING);
    return v;
  }

  set(k: string, v: unknown): void {
    if (v === undefined || v === null) {
      this.del(k);
      return;
    }
    // Retried control operations often repeat the same metadata. Compare in SQL
    // so mutable caller objects and cold caches cannot hide a real change.
    this.execute("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE meta.v <> excluded.v", [k, JSON.stringify(v)]);
    remember(this.cache, k, v);
  }

  del(k: string): void {
    this.run("DELETE FROM meta WHERE k = ?", k);
    this.cache.delete(k);
  }

  clearCache(): void {
    this.cache.clear();
    this.reads.clear();
  }
}
