import { defineCommand, defineQuery } from '@chronolog/peer-session';

// Tier-2 per-participant / per-device view bindings stored as normal Chronolog events.
// Lets one Chronolog stateful pipe render dedicated UIs for different people or devices
// with live hot-swapping via `window.tendril.publication.mountFacets(..., { bindings })`.

const FACET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const TARGET_ID = /^[A-Za-z0-9_.:@-]{1,128}$/u;
const KINDS = new Set(['device', 'participant', 'role']);

export const viewBindingTopics = Object.freeze(['ui/view-binding']);

export const viewBindingCommands = Object.freeze({
  setViewBinding: defineCommand({
    description: 'Assign or clear a dedicated UI facet for a specific device, participant, or role.',
    input: {
      type: 'object',
      properties: {
        targetKind: { type: 'string', enum: ['device', 'participant', 'role'] },
        targetId: { type: 'string', minLength: 1, maxLength: 128 },
        facetId: { type: 'string', maxLength: 64 },
        label: { type: 'string', maxLength: 80 },
      },
      required: ['targetKind', 'targetId'],
      additionalProperties: false,
    },
    prepare(input) {
      if (!KINDS.has(input.targetKind) || !TARGET_ID.test(input.targetId)) {
        throw Error('VIEW_BINDING_TARGET_INVALID');
      }
      const facetId = input.facetId ?? '';
      if (facetId !== '' && !FACET_ID.test(facetId)) {
        throw Error('VIEW_BINDING_FACET_INVALID');
      }
      return [{ topic: 'ui/view-binding', input: {
        targetKind: input.targetKind,
        targetId: input.targetId,
        facetId: facetId || null,
        ...(typeof input.label === 'string' && input.label.trim() ? { label: input.label.trim() } : {}),
      } }];
    },
  }),
});

/** Deterministically materialize the current view binding per (targetKind, targetId). */
export async function readViewBindings(view) {
  const byKey = new Map();
  let cursor;
  for (;;) {
    const batch = await view.readEvents({
      topics: viewBindingTopics,
      limit: 128,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const event of batch.events) {
      if (event.topic !== 'ui/view-binding') continue;
      const p = event.payload ?? {};
      if (!KINDS.has(p.targetKind) || !TARGET_ID.test(p.targetId ?? '')) continue;
      const key = `${p.targetKind}:${p.targetId}`;
      if (p.facetId === null) {
        byKey.delete(key);
      } else if (FACET_ID.test(p.facetId ?? '')) {
        byKey.set(key, {
          key,
          targetKind: p.targetKind,
          targetId: p.targetId,
          facetId: p.facetId,
          ...(typeof p.label === 'string' && p.label.trim() ? { label: p.label.trim() } : {}),
          updatedBy: event.author,
          atMs: /^\d+$/.test(String(event.authorTimestampMs ?? '')) ? Number(event.authorTimestampMs) : null,
        });
      }
    }
    if (!batch.hasMore) return { bindings: [...byKey.values()] };
    if (batch.cursor === cursor) throw Error('VIEW_BINDINGS_CURSOR_STALLED');
    cursor = batch.cursor;
  }
}

export const viewBindingQueries = Object.freeze({
  viewBindings: defineQuery({
    description: 'Read materialized per-device, per-participant, and per-role UI view bindings.',
    input: { type: 'null' },
    read: readViewBindings,
  }),
});

/** Resolve the highest-precedence bound facet for a viewer: device -> participant -> role. */
export function resolveViewBinding(bindings, { deviceId, participantId, role } = {}) {
  const list = Array.isArray(bindings) ? bindings : (bindings?.bindings ?? []);
  const lookup = new Map(list.map(b => [`${b.targetKind}:${b.targetId}`, b.facetId]));
  if (deviceId && lookup.has(`device:${deviceId}`)) return lookup.get(`device:${deviceId}`);
  if (participantId && lookup.has(`participant:${participantId}`)) return lookup.get(`participant:${participantId}`);
  if (role && lookup.has(`role:${role}`)) return lookup.get(`role:${role}`);
  return null;
}

/**
 * Create a live `FacetBindingSource` plugged directly into `tendril.publication.mountFacets(el, { bindings })`.
 * Re-derives bindings automatically on every Chronolog session change so remote updates hot-swap views live.
 */
export function createViewBindingSource(session, { deviceId, participantId, role, signal } = {}) {
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  let currentBindings = [];
  let currentFacet = null;
  const listeners = new Set();

  const notify = () => {
    for (const fn of listeners) { try { fn(); } catch { /* ignore */ } }
  };

  const refresh = async () => {
    if (lifetime.aborted) return;
    try {
      const view = await session.readView();
      try {
        const res = await readViewBindings(view);
        currentBindings = res.bindings;
        const nextFacet = resolveViewBinding(currentBindings, { deviceId, participantId, role });
        if (nextFacet !== currentFacet) {
          currentFacet = nextFacet;
          notify();
        }
      } finally {
        await view.release();
      }
    } catch { /* ignore transient view closure */ }
  };

  const ready = refresh();
  void (async () => {
    try {
      for await (const _change of session.changes({ signal: lifetime })) {
        if (lifetime.aborted) break;
        await refresh();
      }
    } catch { /* closed */ }
  })();

  return Object.freeze({
    ready,
    resolve: () => currentFacet,
    snapshot: () => [...currentBindings],
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async setBinding({ targetKind, targetId, facetId, label }, operationId) {
      const payload = {
        targetKind,
        targetId,
        ...(facetId ? { facetId } : {}),
        ...(label ? { label } : {}),
      };
      const op = await session.command('setViewBinding', payload, operationId ? { operationId } : undefined);
      await op.materialized({ signal: lifetime });
      await refresh();
      return op;
    },
    close() {
      stop.abort();
      listeners.clear();
    },
  });
}
