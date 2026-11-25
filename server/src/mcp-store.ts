/**
 * Encrypted-only Durable Object BytesStore for hosted Chronolog MCP participants.
 *
 * Guarantees zero plaintext keys at rest:
 * - `DurableObjectBytesStore` persists Chronolog ciphertext journals/records in `mcp_store`,
 *   and refuses to store any epoch key or private signing key record.
 * - `MemoryBytesStore` keeps unwrapped epoch keys strictly in RAM for the single request.
 */
import type { Db } from './db';

export interface BytesStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete?(key: string): Promise<void>;
  initialize?(entries: readonly { key: string; value: Uint8Array }[]): Promise<void>;
}

const FORBIDDEN_PERSIST_RE = /(?:^|\/)(?:epoch-keys?|private|secret|signer-seed)/iu;

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  throw new Error('Unexpected binary column value in mcp_store');
}

export class DurableObjectBytesStore implements BytesStore {
  constructor(private readonly db: Db, private readonly prefix = '') {}

  private scoped(key: string): string {
    if (FORBIDDEN_PERSIST_RE.test(key)) {
      throw new Error(`Refusing to persist sensitive key material to DO storage: ${key}`);
    }
    return this.prefix ? `${this.prefix}:${key}` : key;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const row = this.db.one<{ v: ArrayBuffer | Uint8Array }>('SELECT v FROM mcp_store WHERE k=?', this.scoped(key));
    return row ? toUint8Array(row.v) : null;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const k = this.scoped(key);
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    this.db.run('INSERT INTO mcp_store(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, copy.buffer);
  }

  async delete(key: string): Promise<void> {
    this.db.run('DELETE FROM mcp_store WHERE k=?', this.scoped(key));
  }

  async initialize(entries: readonly { key: string; value: Uint8Array }[]): Promise<void> {
    for (const entry of entries) {
      const k = this.scoped(entry.key);
      const copy = new Uint8Array(entry.value.byteLength);
      copy.set(entry.value);
      this.db.run('INSERT OR IGNORE INTO mcp_store(k, v) VALUES(?, ?)', k, copy.buffer);
    }
  }
}

export class MemoryBytesStore implements BytesStore {
  private readonly map = new Map<string, Uint8Array>();

  constructor(private readonly fallback?: (key: string) => Uint8Array | null) {}

  async get(key: string): Promise<Uint8Array | null> {
    const hit = this.map.get(key);
    if (hit) return hit.slice();
    const fb = this.fallback?.(key) ?? null;
    if (fb) {
      this.map.set(key, fb.slice());
      return fb.slice();
    }
    return null;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.map.set(key, value.slice());
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async initialize(entries: readonly { key: string; value: Uint8Array }[]): Promise<void> {
    for (const entry of entries) {
      if (!this.map.has(entry.key)) this.map.set(entry.key, entry.value.slice());
    }
  }

  entries(): IterableIterator<[string, Uint8Array]> {
    return this.map.entries();
  }
}
