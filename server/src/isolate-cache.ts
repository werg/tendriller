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
  private readonly entries = new Map<string, Entry<V>>();
  private generation = 0;

  /**
   * @param ttlMs lifetime of a present value
   * @param negativeTtlMs lifetime of a `null`/`undefined` (absent) value
   * @param max entry bound; the oldest insertion is evicted first
   */
  constructor(readonly ttlMs: number, readonly negativeTtlMs = ttlMs, readonly max = 1024) {
    caches.add(this as TtlCache<unknown>);
  }

  async get(key: string, load: () => Promise<V>, now = Date.now()): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    if (hit) this.entries.delete(key);
    const generation = this.generation;
    const value = await load();
    // A delete or clear during the load means the loaded value may predate it.
    if (generation === this.generation) {
      const ttl = value === null || value === undefined ? this.negativeTtlMs : this.ttlMs;
      if (ttl > 0) {
        if (!this.entries.has(key) && this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, { value, expiresAt: Date.now() + ttl });
      }
    }
    return value;
  }

  /** Synchronous peek used by tests and diagnostics. */
  peek(key: string, now = Date.now()): V | undefined {
    const hit = this.entries.get(key);
    return hit && hit.expiresAt > now ? hit.value : undefined;
  }

  delete(key: string): void {
    this.entries.delete(key);
    this.generation++;
  }

  clear(): void {
    this.entries.clear();
    this.generation++;
  }

  get size(): number { return this.entries.size; }
}

/** Drops every isolate cache (tests and administrative state changes). */
export function clearIsolateCaches(): void {
  for (const cache of caches) cache.clear();
}
