import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY = 'assistant/delivery/v1';
const MAX_STATE_BYTES = 512 * 1024;

/** A bounded, authenticated delivery journal in the page SQLite transaction. */
export function createWorkerDeliveryStore(t, key) {
  const secret = Buffer.from(key ?? '', 'base64');
  if (secret.length !== 32) throw Error('ASSISTANT_STORE_KEY_REQUIRED');
  const aad = Buffer.from(KEY + ':' + t.tid);
  function read() {
    const value = t.db.one('SELECT value FROM participant_records WHERE key=?', KEY)?.value;
    if (!value) return {};
    const bytes = Buffer.from(value);
    const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
    cipher.setAAD(aad);
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
  }
  return {
    async read() { return read(); },
    async transaction(mutate) {
      return t.transaction(() => {
        const state = read(), before = JSON.stringify(state), result = mutate(state);
        if (result && typeof result.then === 'function') throw Error('ASSISTANT_ASYNC_STORE_TRANSACTION');
        const after = JSON.stringify(state);
        if (after !== before) {
          const bytes = Buffer.from(after);
          if (bytes.length > MAX_STATE_BYTES) throw Error('ASSISTANT_STORE_CAPACITY');
          const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv);
          cipher.setAAD(aad);
          const payload = Buffer.concat([cipher.update(bytes), cipher.final()]);
          const value = Uint8Array.from(Buffer.concat([iv, cipher.getAuthTag(), payload])).buffer;
          t.db.run('INSERT INTO participant_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, value);
        }
        return structuredClone(result);
      });
    },
    async close() { secret.fill(0); },
  };
}
