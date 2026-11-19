import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fail } from './common.mjs';

const AAD = Buffer.from('tendriller-chatgpt-delivery-state-v1');

// This database holds consent, routing, cursors and delivery bookkeeping only.
// Application state, identities and command attempts stay in Chronolog storage.
export function openDeliveryStore({ path, key }) {
  const secret = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(key ?? '', 'base64');
  if (secret.length !== 32) fail('STORE_KEY_REQUIRED', 'Provide a dedicated 32-byte delivery encryption key');
  if (typeof path !== 'string' || !path || path === ':memory:')
    fail('STORE_PATH_REQUIRED', 'Provide a persistent private delivery database path');
  const filename = resolve(path);
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS integration_state (id INTEGER PRIMARY KEY CHECK (id=1), encrypted BLOB NOT NULL)');
  const get = db.prepare('SELECT encrypted FROM integration_state WHERE id=1');
  const put = db.prepare('INSERT INTO integration_state(id,encrypted) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted');
  let closed = false;
  const encrypt = value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(AAD);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const read = () => {
    if (closed) fail('STORE_CLOSED', 'Delivery store is closed');
    const row = get.get();
    if (!row) return {};
    const bytes = Buffer.from(row.encrypted);
    try {
      const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      decipher.setAAD(AAD); decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    } catch { fail('STORE_DECRYPTION_FAILED', 'Delivery state cannot be authenticated with the configured key'); }
  };
  // Synchronous mutators cannot hold a transaction across a network operation.
  // SQLite serializes distinct processes; cursor and jobs commit as one record.
  return {
    async read() { return read(); },
    async transaction(mutator) {
      if (closed) fail('STORE_CLOSED', 'Delivery store is closed');
      db.exec('BEGIN IMMEDIATE');
      try {
        const state = read(), result = mutator(state);
        if (result && typeof result.then === 'function') fail('ASYNC_TRANSACTION', 'Delivery transaction mutators must be synchronous');
        const returned = structuredClone(result);
        put.run(encrypt(state)); db.exec('COMMIT');
        return returned;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async close() { if (!closed) { closed = true; db.close(); secret.fill(0); } },
  };
}

export function createMemoryStore(initial = {}) {
  let state = structuredClone(initial);
  return {
    async read() { return structuredClone(state); },
    async transaction(mutator) {
      const copy = structuredClone(state), result = mutator(copy);
      if (result && typeof result.then === 'function') fail('ASYNC_TRANSACTION', 'Delivery transaction mutators must be synchronous');
      const returned = structuredClone(result);
      state = copy; return returned;
    },
    async close() {},
  };
}
