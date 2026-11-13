// Offline support (PLAN 14.1): a persistent outbound queue and a last-known snapshot of
// state + transcript. IndexedDB is the durable store; localStorage holds a small synchronous
// copy of the snapshot so a reload without signal can render the page with its state before
// IndexedDB has opened. Everything degrades to memory-only if storage is unavailable.

export interface OutboxItem { key: number; cid: string; msg: any; blob?: Blob }
export interface Snapshot { rev: number; state: any; pending: { cid: string; ops: any[] }[]; transcript: any[] }

const MAX_LOG_ITEMS = 50;
let keySeq = 0;
function newKey(): number { return Date.now() * 1000 + (keySeq++ % 1000); }

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export class OfflineStore {
  items: OutboxItem[] = [];
  /** True once IndexedDB is open (the outbox is then durable and authoritative). */
  get persistent(): boolean { return this.db !== null; }
  private db: IDBDatabase | null = null;
  private writes = new Set<Promise<unknown>>();
  private lsKey: string;

  constructor(private tendrilId: string) {
    this.lsKey = `tendril:${tendrilId}:snapshot`;
  }

  /** Opens IndexedDB and merges persisted outbox items (older) before items added in memory meanwhile. */
  async init(): Promise<Snapshot | null> {
    try {
      this.db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(`tendril:${this.tendrilId}`, 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "key" });
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error("blocked"));
      });
    } catch {
      this.db = null;
      return null;
    }
    let stored: OutboxItem[] = [];
    let snap: Snapshot | null = null;
    try {
      const tx = this.db.transaction(["outbox", "kv"], "readonly");
      stored = (await req(tx.objectStore("outbox").getAll())) as OutboxItem[];
      snap = ((await req(tx.objectStore("kv").get("snapshot"))) as Snapshot) || null;
    } catch { /* ignore */ }
    stored.sort((a, b) => a.key - b.key);
    const have = new Set(this.items.map((i) => i.cid));
    const older = stored.filter((i) => !have.has(i.cid));
    this.items = [...older, ...this.items];
    // Persist items added before the database was open.
    for (const it of this.items) if (!older.includes(it)) this.put(it);
    return snap;
  }

  add(msg: any, blob?: Blob): OutboxItem {
    const it: OutboxItem = { key: newKey(), cid: msg.cid, msg, blob };
    this.items.push(it);
    if (msg.t === "log") {
      const logs = this.items.filter((i) => i.msg.t === "log");
      for (const old of logs.slice(0, Math.max(0, logs.length - MAX_LOG_ITEMS))) this.remove(old.cid);
    }
    this.put(it);
    return it;
  }

  has(cid: string): boolean { return this.items.some((i) => i.cid === cid); }

  remove(cid: string): OutboxItem | undefined {
    const i = this.items.findIndex((x) => x.cid === cid);
    if (i < 0) return undefined;
    const [it] = this.items.splice(i, 1);
    this.write((db) => db.transaction("outbox", "readwrite").objectStore("outbox").delete(it.key));
    return it;
  }

  private put(it: OutboxItem) {
    this.write((db) => db.transaction("outbox", "readwrite").objectStore("outbox").put(it));
  }

  private write(fn: (db: IDBDatabase) => IDBRequest) {
    if (!this.db) return;
    let p: Promise<unknown>;
    try { p = req(fn(this.db)).catch(() => {}); } catch { return; }
    this.writes.add(p);
    p.finally(() => this.writes.delete(p));
  }

  /** Synchronous snapshot from localStorage (may be missing if it was too large). */
  loadSnapshotSync(): Snapshot | null {
    try {
      const raw = localStorage.getItem(this.lsKey);
      return raw ? (JSON.parse(raw) as Snapshot) : null;
    } catch { return null; }
  }

  saveSnapshot(s: Snapshot, opts: { idb?: boolean } = {}) {
    try {
      const json = JSON.stringify(s);
      if (json.length < 1_500_000) localStorage.setItem(this.lsKey, json);
      else localStorage.removeItem(this.lsKey);
    } catch {
      try { localStorage.removeItem(this.lsKey); } catch { /* ignore */ }
    }
    if (opts.idb !== false) this.write((db) => db.transaction("kv", "readwrite").objectStore("kv").put(s, "snapshot"));
  }

  /** Resolves when pending IndexedDB writes have finished (or after `ms`). */
  flush(ms = 1000): Promise<void> {
    const all = Promise.all([...this.writes]).then(() => {});
    return Promise.race([all, new Promise<void>((r) => setTimeout(r, ms))]);
  }
}
