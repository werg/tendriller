// SQLite storage for the Tendril Durable Object (PROTOCOL section 3).

/** Persistent host storage identity, independent of runtime and application releases. */
export const STORAGE_SCHEMA_REVISION = 15;

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
CREATE TABLE IF NOT EXISTS agent_grants (agent_id TEXT PRIMARY KEY, handle TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL, wrap_key TEXT NOT NULL, scopes TEXT NOT NULL, revision INTEGER NOT NULL, granted_by TEXT NOT NULL, granted_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admission_attestations (public_key TEXT PRIMARY KEY, record BLOB NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invite_redemptions (invite_id TEXT NOT NULL, account_id TEXT NOT NULL, public_key TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL, PRIMARY KEY (invite_id, account_id));
CREATE TABLE IF NOT EXISTS v2_public_ops (op_id TEXT PRIMARY KEY, author TEXT NOT NULL, author_ts INTEGER NOT NULL, raw BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS v2_public_cas (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS v2_checkpoints (scope_id TEXT NOT NULL, closed_through INTEGER NOT NULL, raw BLOB NOT NULL, PRIMARY KEY (scope_id, closed_through));
CREATE TABLE IF NOT EXISTS v2_mailbox_envelopes (digest TEXT PRIMARY KEY, epoch INTEGER NOT NULL, author TEXT NOT NULL, raw BLOB NOT NULL, stored_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v2_mailbox_ops (op_id TEXT PRIMARY KEY, author TEXT NOT NULL, author_ts INTEGER NOT NULL, raw BLOB NOT NULL, stored_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v2_mailbox_cas (hash TEXT PRIMARY KEY, partition TEXT NOT NULL, bytes BLOB NOT NULL, stored_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hub_subscribers (key TEXT PRIMARY KEY, kind TEXT NOT NULL, agent_id TEXT NOT NULL, conn_id TEXT NOT NULL, stream_id INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_store (k TEXT PRIMARY KEY, v BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_connections (grant_id TEXT PRIMARY KEY, handle TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL, wrapped_keys BLOB NOT NULL, label TEXT NOT NULL, capabilities TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
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
CREATE TABLE IF NOT EXISTS device_pairings (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS device_pairings_account ON device_pairings (account_id, created_at);
CREATE TABLE IF NOT EXISTS visitor_signals (kind TEXT NOT NULL, value_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL, PRIMARY KEY (kind, value_hash));
CREATE INDEX IF NOT EXISTS visitor_signals_time ON visitor_signals (kind, first_seen);
CREATE TABLE IF NOT EXISTS release_events (at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, by TEXT, source TEXT NOT NULL);
`;

export const REQUIRED_TABLES: readonly string[] = Object.freeze(
  [...SCHEMA.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi)].map(match => match[1]!),
);

// Additive tables introduced within STORAGE_SCHEMA_REVISION 15; existing rev-15 DOs
// deployed before blind mailbox support upgrade cleanly in place on init().
const ADDITIVE_REV15_TABLES: Readonly<Record<string, string>> = Object.freeze({
  v2_mailbox_envelopes: 'CREATE TABLE IF NOT EXISTS v2_mailbox_envelopes (digest TEXT PRIMARY KEY, epoch INTEGER NOT NULL, author TEXT NOT NULL, raw BLOB NOT NULL, stored_at INTEGER NOT NULL)',
  v2_mailbox_ops: 'CREATE TABLE IF NOT EXISTS v2_mailbox_ops (op_id TEXT PRIMARY KEY, author TEXT NOT NULL, author_ts INTEGER NOT NULL, raw BLOB NOT NULL, stored_at INTEGER NOT NULL)',
  v2_mailbox_cas: 'CREATE TABLE IF NOT EXISTS v2_mailbox_cas (hash TEXT PRIMARY KEY, partition TEXT NOT NULL, bytes BLOB NOT NULL, stored_at INTEGER NOT NULL)',
  hub_subscribers: 'CREATE TABLE IF NOT EXISTS hub_subscribers (key TEXT PRIMARY KEY, kind TEXT NOT NULL, agent_id TEXT NOT NULL, conn_id TEXT NOT NULL, stream_id INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL)',
});

type Bindable = string | number | null | ArrayBuffer;
const MISSING = Symbol('missing metadata');
const MAX_CACHED_ENTRIES = 256;

/**
 * Hot metadata read on nearly every page and control request. One query on
 * wake replaces a dozen point reads; values not present are remembered as
 * absent like any other metadata miss.
 */
export const PRELOADED_META_KEYS: readonly string[] = Object.freeze([
  'id', 'owner_account', 'disabled', 'current', 'latest', 'lifetime', 'last_access', 'name', 'short_name',
  'theme_color', 'icon', 'subdomain', 'application', 'peer_bootstrap', 'owner_label', 'icon_raster',
  'v2_open_readers', 'v2_open_writers', 'v2_genesis', 'v2_control_summary', 'v2_publications_managed',
]);

/**
 * Tables a statement may write. A single INSERT/REPLACE/UPDATE/DELETE names
 * exactly one target (the schema has no triggers or cascading foreign keys);
 * anything else, including DDL and multi-statement text, is treated as writing
 * every table.
 */
const WRITE_TARGET = /^\s*(?:INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+[A-Z]+)?|DELETE\s+FROM)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?(?:[\s(]|$)/i;
const SELECT_ONLY = /^\s*SELECT\b/i;

function writeTarget(query: string): string | null {
  if (query.includes(';')) return null;
  return WRITE_TARGET.exec(query)?.[1]?.toLowerCase() ?? null;
}

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

/**
 * Declared dependencies of a cached read: table names, plus `meta:<prefix>`
 * for metadata keys starting with `<prefix>`. A read without declared
 * dependencies is discarded by any write.
 */
export type CacheDeps = readonly string[];

interface CachedRead { value: unknown; deps: CacheDeps | null }

export class Db {
  private cache = new Map<string, unknown>();
  private reads = new Map<string, CachedRead>();
  private readonly sql: SqlStorage;

  constructor(private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>, private readonly metadataChanged?: (key: string) => void) {
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
        const existingTables = new Set(objects.filter(object => object.type === 'table').map(object => object.name));
        const missing = REQUIRED_TABLES.filter(table => !existingTables.has(table));
        if (missing.length > 0) {
          const missingCore = missing.filter(table => !Object.hasOwn(ADDITIVE_REV15_TABLES, table));
          if (missingCore.length > 0) {
            throw new StorageSchemaError(`stored revision ${STORAGE_SCHEMA_REVISION} is missing required tables (${missingCore.join(', ')})`);
          }
          for (const table of missing) {
            this.run(ADDITIVE_REV15_TABLES[table]!);
          }
        }
        return;
      }
      if (objects.length) throw new StorageSchemaError('existing application tables have no schema identity');

      this.run(SCHEMA);
      this.run('CREATE TABLE storage_schema (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)');
      this.run('INSERT INTO storage_schema(id,revision) VALUES(1,?)', STORAGE_SCHEMA_REVISION);
    });
    this.preloadMeta();
  }

  /** Load the hot metadata keys in one statement. */
  preloadMeta(keys: readonly string[] = PRELOADED_META_KEYS): void {
    const rows = this.execute<{ k: string; v: string }>(`SELECT k,v FROM meta WHERE k IN (${keys.map(() => '?').join(',')})`, [...keys]);
    const found = new Map(rows.map(row => [row.k, row.v]));
    for (const k of keys) {
      const raw = found.get(k);
      remember(this.cache, k, raw === undefined ? MISSING : JSON.parse(raw));
    }
  }

  all<T = Record<string, any>>(query: string, ...args: unknown[]): T[] {
    // Only a single SELECT is known to be read-only. This also invalidates for
    // DDL and writes with RETURNING, including statements that write zero rows.
    if (!SELECT_ONLY.test(query) || query.includes(';')) this.invalidateWrite(query);
    return this.execute<T>(query, args);
  }

  private execute<T>(query: string, args: unknown[]): T[] {
    try {
      const cursor = this.sql.exec(query, ...args.map(norm));
      try { return cursor.toArray() as T[]; }
      finally { if (cursor.rowsWritten) this.invalidateWrite(query); }
    } catch (error) {
      this.clearCache();
      throw error;
    }
  }

  /** Discard what a write statement may have changed. */
  private invalidateWrite(query: string): void {
    const table = SELECT_ONLY.test(query) && !query.includes(';') ? null : writeTarget(query);
    if (table === null) { this.clearCache(); return; }
    if (table === 'meta') {
      // A raw metadata statement may touch any key.
      this.cache.clear();
      this.dropReads(deps => deps.some(dep => dep === 'meta' || dep.startsWith('meta:')));
      return;
    }
    this.dropReads(deps => deps.includes(table));
  }

  private invalidateMetaKey(k: string): void {
    this.dropReads(deps => deps.some(dep => dep === 'meta' || dep.startsWith('meta:') && k.startsWith(dep.slice(5))));
  }

  private dropReads(affected: (deps: CacheDeps) => boolean): void {
    for (const [key, read] of this.reads) if (read.deps === null || affected(read.deps)) this.reads.delete(key);
  }

  one<T = Record<string, any>>(query: string, ...args: unknown[]): T | null {
    return (this.all<T>(query, ...args)[0] ?? null) as T | null;
  }

  run(query: string, ...args: unknown[]): void {
    this.all(query, ...args);
  }

  /**
   * Instance-local reads; rollback and eviction discard them. Writes discard
   * the reads that declare an affected dependency, or every read without
   * declared dependencies.
   */
  cached<T>(key: string, read: () => T, deps?: CacheDeps): T {
    const hit = this.reads.get(key);
    if (hit) return hit.value as T;
    const value = read();
    if (!this.reads.has(key) && this.reads.size >= MAX_CACHED_ENTRIES) this.reads.delete(this.reads.keys().next().value!);
    this.reads.set(key, { value, deps: deps ? deps.map(dep => dep.startsWith('meta:') ? dep : dep.toLowerCase()) : null });
    return value;
  }

  cachedAsync<T>(key: string, read: () => Promise<T>, deps?: CacheDeps): Promise<T> {
    return this.cached(key, () => {
      const value = read().catch(error => {
        if (this.reads.get(key)?.value === value) this.reads.delete(key);
        throw error;
      });
      return value;
    }, deps);
  }

  /** Discard one cached read, e.g. after a dependency changed outside SQL. */
  forget(key: string): void { this.reads.delete(key); }

  get<T>(k: string, def: T): T {
    if (this.cache.has(k)) {
      const value = this.cache.get(k);
      return value === MISSING ? def : value as T;
    }
    const row = this.execute<{ v: string }>("SELECT v FROM meta WHERE k = ?", [k])[0];
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
    const cursor = this.execMeta("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE meta.v <> excluded.v", k, JSON.stringify(v));
    remember(this.cache, k, v);
    if (cursor) this.invalidateMetaKey(k);
    this.metadataChanged?.(k);
  }

  del(k: string): void {
    const written = this.execMeta("DELETE FROM meta WHERE k = ?", k);
    remember(this.cache, k, MISSING);
    if (written) this.invalidateMetaKey(k);
    this.metadataChanged?.(k);
  }

  /** One-key metadata write; returns whether a row changed. */
  private execMeta(query: string, ...args: Bindable[]): boolean {
    try {
      const cursor = this.sql.exec(query, ...args);
      cursor.toArray();
      return cursor.rowsWritten > 0;
    } catch (error) {
      this.clearCache();
      throw error;
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.reads.clear();
  }
}
