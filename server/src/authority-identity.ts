import { createSigningIdentity, exportSigningIdentity, importSigningIdentity, encodeRecord, decodeRecord, type SigningIdentity } from '@chronolog/authority';
import type { Tendril } from './tendril';
const KEY = 'authority/identity';
function stored(t: Tendril): Uint8Array | null {
  const row = t.db.one<{ value: ArrayBuffer }>('SELECT value FROM participant_records WHERE key=?', KEY);
  return row ? new Uint8Array(row.value).slice() : null;
}
export async function loadAuthorityIdentity(t: Tendril): Promise<SigningIdentity | null> {
  return t.db.cachedAsync('authority:identity', async () => {
    const bytes = stored(t);
    return bytes === null ? null : importSigningIdentity(decodeRecord(bytes));
  });
}
export async function ensureAuthorityIdentity(t: Tendril): Promise<SigningIdentity> {
  const existing = await loadAuthorityIdentity(t);
  if (existing) return existing;
  const identity = await createSigningIdentity(), candidate = encodeRecord(await exportSigningIdentity(identity));
  const selected = t.transaction(() => {
    const prior = stored(t);
    if (prior) return prior;
    t.checkLocalStorage(candidate.byteLength);
    t.db.run('INSERT INTO participant_records(key,value) VALUES(?,?)', KEY, candidate.slice().buffer);
    return candidate;
  });
  return selected === candidate ? identity : importSigningIdentity(decodeRecord(selected));
}
