import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fail } from './common.mjs';

const AAD = Buffer.from('tendriller-chatgpt-delivery-state-v1');
const DEFAULT_BLOB_BYTES = 64 * 1024 * 1024;
function blobLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024)
    fail('STORE_BLOB_LIMIT_INVALID', 'Configure a positive encrypted asset budget of at most 1 GiB');
  return value;
}
function blobId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(value)) fail('STORE_BLOB_ID_INVALID', 'Invalid private asset identity');
  return value;
}

// This database holds consent, routing, cursors and delivery bookkeeping only.
// Application state, identities and command attempts stay in Chronolog storage.
export function openDeliveryStore({ path, key, maxBlobBytes = DEFAULT_BLOB_BYTES }) {
  blobLimit(maxBlobBytes);
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
  db.exec('CREATE TABLE IF NOT EXISTS integration_blobs (id TEXT PRIMARY KEY, size INTEGER NOT NULL, encrypted BLOB NOT NULL)');
  const get = db.prepare('SELECT encrypted FROM integration_state WHERE id=1');
  const put = db.prepare('INSERT INTO integration_state(id,encrypted) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted');
  const getBlob = db.prepare('SELECT encrypted FROM integration_blobs WHERE id=?');
  const putBlob = db.prepare('INSERT INTO integration_blobs(id,size,encrypted) VALUES (?,?,?)');
  const totalBlobBytes = db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM integration_blobs');
  let closed = false;
  const encrypt = (bytes, aad) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const decrypt = (encrypted, aad) => {
    const bytes = Buffer.from(encrypted);
    try {
      const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    } catch { fail('STORE_DECRYPTION_FAILED', 'Private integration state cannot be authenticated with the configured key'); }
  };
  const blobAad = id => Buffer.from('tendriller-chatgpt-blob-v1:' + blobId(id));
  const readBlob = id => {
    if (closed) fail('STORE_CLOSED', 'Delivery store is closed');
    const aad = blobAad(id), row = getBlob.get(id);
    return row ? decrypt(row.encrypted, aad) : null;
  };
  const read = () => {
    if (closed) fail('STORE_CLOSED', 'Delivery store is closed');
    const row = get.get();
    if (!row) return {};
    try {
      return JSON.parse(decrypt(row.encrypted, AAD).toString('utf8'));
    } catch { fail('STORE_DECRYPTION_FAILED', 'Delivery state cannot be authenticated with the configured key'); }
  };
  // Synchronous mutators cannot hold a transaction across a network operation.
  // SQLite serializes distinct processes; cursor and jobs commit as one record.
  return {
    async read() { return read(); },
    async readBlob(id) { return readBlob(id); },
    async transaction(mutator) {
      if (closed) fail('STORE_CLOSED', 'Delivery store is closed');
      db.exec('BEGIN IMMEDIATE');
      try {
        const state = read(), result = mutator(state, { put(id, value) {
          const aad = blobAad(id);
          if (!(value instanceof Uint8Array)) fail('STORE_BLOB_INVALID', 'Private assets must be bytes');
          const bytes = Buffer.from(value), existing = readBlob(id);
          if (existing) {
            if (!existing.equals(bytes)) fail('STORE_BLOB_CONFLICT', 'Private asset identity already names different bytes');
            return;
          }
          if (totalBlobBytes.get().total + bytes.length > maxBlobBytes) fail('STORE_BLOB_CAPACITY', 'Private asset budget reached; archive reviewed releases before adding more');
          putBlob.run(id, bytes.length, encrypt(bytes, aad));
        } });
        if (result && typeof result.then === 'function') fail('ASYNC_TRANSACTION', 'Delivery transaction mutators must be synchronous');
        const returned = structuredClone(result);
        put.run(encrypt(Buffer.from(JSON.stringify(state)), AAD)); db.exec('COMMIT');
        return returned;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async close() { if (!closed) { closed = true; db.close(); secret.fill(0); } },
  };
}

export function createMemoryStore(initial = {}, { maxBlobBytes = DEFAULT_BLOB_BYTES } = {}) {
  blobLimit(maxBlobBytes);
  let state = structuredClone(initial), blobs = new Map();
  return {
    async read() { return structuredClone(state); },
    async readBlob(id) { blobId(id); return blobs.has(id) ? Buffer.from(blobs.get(id)) : null; },
    async transaction(mutator) {
      const copy = structuredClone(state), nextBlobs = new Map(blobs), result = mutator(copy, { put(id, value) {
        blobId(id);
        if (!(value instanceof Uint8Array)) fail('STORE_BLOB_INVALID', 'Private assets must be bytes');
        const bytes = Buffer.from(value), existing = nextBlobs.get(id);
        if (existing) { if (!existing.equals(bytes)) fail('STORE_BLOB_CONFLICT', 'Private asset identity already names different bytes'); return; }
        if ([...nextBlobs.values()].reduce((sum, item) => sum + item.length, 0) + bytes.length > maxBlobBytes)
          fail('STORE_BLOB_CAPACITY', 'Private asset budget reached; archive reviewed releases before adding more');
        nextBlobs.set(id, bytes);
      } });
      if (result && typeof result.then === 'function') fail('ASYNC_TRANSACTION', 'Delivery transaction mutators must be synchronous');
      const returned = structuredClone(result);
      state = copy; blobs = nextBlobs; return returned;
    },
    async close() {},
  };
}
