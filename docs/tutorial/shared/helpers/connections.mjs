import { defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';

// Shared team (`custody: "page"`) Tier B connection wrap-key (`K_conn`) storage inside Chronolog.
// Because every Chronolog event is encrypted under the page's epoch key, only admitted page members
// can read `K_conn`; when a member is removed (or offboarded from an org) and the epoch key rotates,
// call `rekeyPageConnections(...)` to atomically rotate `K_conn` on the host and in Chronolog.

const CONN_ID = /^oc_[a-z2-7]{26}$/u;
const KEY_RE = /^[A-Za-z0-9_-]{40,64}$/u;

function randomConnectionKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export const pageConnectionTopics = Object.freeze(['connections/page-key']);

export const pageConnectionCommands = Object.freeze({
  setPageConnectionKey: defineCommand({
    description: 'Store or clear a shared team (page-custody) connection wrap key inside encrypted Chronolog state.',
    input: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', minLength: 29, maxLength: 29 },
        provider: { type: 'string', minLength: 1, maxLength: 64 },
        connectionKey: { type: 'string', maxLength: 64 },
        epoch: { type: 'integer', minimum: 0 },
      },
      required: ['connectionId', 'provider'],
      additionalProperties: false,
    },
    prepare(input) {
      if (!CONN_ID.test(input.connectionId)) throw Error('CONNECTION_ID_INVALID');
      const key = input.connectionKey ?? '';
      if (key !== '' && !KEY_RE.test(key)) throw Error('CONNECTION_KEY_INVALID');
      return program(emit('connections/page-key', {
        connectionId: input.connectionId,
        provider: input.provider,
        connectionKey: key || null,
        epoch: input.epoch ?? 0,
      }));
    },
  }),
});

export async function readPageConnectionKeys(view) {
  const byId = new Map();
  let cursor;
  for (;;) {
    const batch = await view.readEvents({
      topics: pageConnectionTopics,
      limit: 128,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const event of batch.events) {
      if (event.topic !== 'connections/page-key') continue;
      const p = event.payload ?? {};
      if (!CONN_ID.test(p.connectionId ?? '')) continue;
      if (!p.connectionKey) {
        byId.delete(p.connectionId);
      } else if (KEY_RE.test(p.connectionKey)) {
        byId.set(p.connectionId, {
          connectionId: p.connectionId,
          provider: String(p.provider ?? ''),
          connectionKey: p.connectionKey,
          epoch: Number(p.epoch ?? 0),
          updatedBy: event.author,
        });
      }
    }
    if (!batch.hasMore) return { keys: [...byId.values()] };
    if (batch.cursor === cursor) throw Error('CONNECTION_KEYS_CURSOR_STALLED');
    cursor = batch.cursor;
  }
}

export const pageConnectionQueries = Object.freeze({
  pageConnectionKeys: defineQuery({
    description: 'Read materialized shared team (page-custody) connection wrap keys.',
    input: { type: 'null' },
    read: readPageConnectionKeys,
  }),
});

/**
 * Rotate every `page`-custody Tier B `K_conn` key on the host and persist the fresh keys
 * in Chronolog under the new epoch (called automatically after device removal / org offboarding).
 */
export async function rekeyAllPageConnections({ session, runtime, epoch = 0, fetch: fetcher = globalThis.fetch }) {
  const base = runtime.identity.base;
  const view = await session.readView();
  let keys;
  try {
    ({ keys } = await readPageConnectionKeys(view));
  } finally {
    await view.release();
  }
  const rotated = [];
  for (const entry of keys) {
    const nextKey = randomConnectionKey();
    const res = await fetcher(`${base}_tendril/connections/${encodeURIComponent(entry.connectionId)}/rekey`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_key: entry.connectionKey, new_key: nextKey }),
    });
    if (!res.ok) throw new Error(`Connection rekey failed (${res.status})`);
    const op = await session.command('setPageConnectionKey', {
      connectionId: entry.connectionId,
      provider: entry.provider,
      connectionKey: nextKey,
      epoch,
    });
    await op.materialized();
    rotated.push(entry.connectionId);
  }
  return rotated;
}
