import {
  createPeerIdentity, exportPeerIdentity, importPeerIdentity, encodePeerValue, decodePeerValue,
  type PeerIdentity,
} from '@chronolog/peer-generation/control';
import type { Tendril } from './tendril';

const KEY = 'peer-generation/identity';

function stored(t: Tendril): Uint8Array | null {
  const row = t.db.one<{ value: ArrayBuffer }>('SELECT value FROM participant_records WHERE key=?', KEY);
  return row ? new Uint8Array(row.value).slice() : null;
}

/** One durable control root for independent application and release protocols. */
export async function loadPeerControlIdentity(t: Tendril): Promise<PeerIdentity | null> {
  // Importing a private key also verifies its public counterpart. Reuse that
  // result only while the local durable snapshot is unchanged; Db drops this
  // promise after every mutation and rollback, including identity removal.
  return t.db.cached('peer-generation:identity', async () => {
    const bytes = stored(t);
    return bytes === null ? null : Object.freeze(await importPeerIdentity(decodePeerValue(bytes)));
  });
}

/** Key creation may race; the transaction chooses one immutable persisted root. */
export async function ensurePeerControlIdentity(t: Tendril): Promise<PeerIdentity> {
  const existing = await loadPeerControlIdentity(t);
  if (existing) return existing;
  const identity = await createPeerIdentity();
  const candidate = encodePeerValue(await exportPeerIdentity(identity));
  const selected = t.transaction(() => {
    const prior = stored(t);
    if (prior) return prior;
    t.db.run('INSERT INTO participant_records(key,value) VALUES(?,?)', KEY, candidate.slice().buffer);
    return candidate;
  });
  return selected === candidate ? identity : importPeerIdentity(decodePeerValue(selected));
}
