/**
 * Bounded per-isolate TTL caches for hot, rarely changing D1 reads on the
 * Worker routing path.
 *
 * Every cache is advisory: a Worker isolate that performs a mutation deletes
 * the affected key immediately, and other isolates converge within the TTL.
 * Each call site documents its staleness window. Loader failures are never
 * cached. Concurrent misses deliberately do not share one pending load: a
 * Worker promise belongs to the request whose I/O settles it, and awaiting it
 * from another request can stall when the first request ends.
 */
const caches = new Set<TtlCache<unknown>>();

interface Entry<V> { value: V; expiresAt: number }

export class TtlCache<V> {
  private scopes = new WeakMap<object, Map<string, Entry<V>>>();
  private readonly unscoped = new Map<string, Entry<V>>();
  private generation = 0;

  /**
   * @param ttlMs lifetime of a present value
   * @param negativeTtlMs lifetime of a `null`/`undefined` (absent) value
   * @param max entry bound per scope; the oldest insertion is evicted first
   */
  constructor(readonly ttlMs: number, readonly negativeTtlMs = ttlMs, readonly max = 1024) {
    caches.add(this as TtlCache<unknown>);
  }

  /**
   * Entries are held per `scope`, normally the binding that answers the load
   * (for example `env.ACCOUNTS`), so a different database never sees another
   * one's answers.
   */
  private entries(scope?: object): Map<string, Entry<V>> {
    if (!scope) return this.unscoped;
    let map = this.scopes.get(scope);
    if (!map) this.scopes.set(scope, map = new Map());
    return map;
  }

  async get(key: string, load: () => Promise<V>, scope?: object): Promise<V> {
    const entries = this.entries(scope);
    const hit = entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    if (hit) entries.delete(key);
    const generation = this.generation;
    const value = await load();
    // A delete or clear during the load means the loaded value may predate it.
    if (generation === this.generation) {
      const ttl = value === null || value === undefined ? this.negativeTtlMs : this.ttlMs;
      if (ttl > 0) {
        if (!entries.has(key) && entries.size >= this.max) entries.delete(entries.keys().next().value!);
        entries.set(key, { value, expiresAt: Date.now() + ttl });
      }
    }
    return value;
  }

  /** Synchronous peek used by tests and diagnostics. */
  peek(key: string, scope?: object): V | undefined {
    const hit = this.entries(scope).get(key);
    return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
  }

  /** Forget `key` in every scope. */
  delete(key: string): void {
    // Scopes are weakly held and cannot be enumerated; advancing the generation
    // and dropping them all is the bounded way to forget one key everywhere.
    this.clear();
    void key;
  }

  clear(): void {
    this.scopes = new WeakMap();
    this.unscoped.clear();
    this.generation++;
  }
}

/** Drops every isolate cache (tests and administrative state changes). */
export function clearIsolateCaches(): void {
  for (const cache of caches) cache.clear();
}
