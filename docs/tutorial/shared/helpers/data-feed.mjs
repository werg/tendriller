// Private/local API data feeds served by the native participant over authenticated
// live signals. Secrets and API credentials stay strictly on the native host;
// browsers receive live snapshots and on-demand pulls with ZERO durable journal writes.
import { createSignalRequests, serveSignalRequests, whenConnected } from './signal-request.mjs';

const INLINE_LIMIT_BYTES = 10 * 1024;
const encoder = new TextEncoder();
const byteLength = value => encoder.encode(JSON.stringify(value)).length;

function normalizeFeed(spec) {
  if (typeof spec === 'function') return { fetch: spec, pollMs: 0, ttlMs: 30_000, maxAgeMs: 5_000 };
  if (!spec || typeof spec.fetch !== 'function') throw TypeError('Each data feed requires a fetch(query, ctx) function');
  return {
    fetch: spec.fetch,
    pollMs: Number.isFinite(spec.pollMs) && spec.pollMs > 0 ? spec.pollMs : 0,
    ttlMs: Number.isFinite(spec.ttlMs) && spec.ttlMs > 0 ? spec.ttlMs : 30_000,
    maxAgeMs: Number.isFinite(spec.maxAgeMs) && spec.maxAgeMs >= 0 ? spec.maxAgeMs : 5_000,
  };
}

/**
 * Native side: registers named private/local API fetchers, polls only while at least
 * one peer is connected, caches the latest snapshot in RAM, broadcasts deltas over
 * `session.signals` (`feed/<name>`), and serves on-demand / large (>10 KiB, up to 4 MiB)
 * pulls via `serveSignalRequests`.
 */
export function serveDataFeeds(session, feedSpecs, {
  signal,
  requestTopic = 'feed/pull',
  replyTopic = 'feed/reply',
  broadcastPrefix = 'feed/',
} = {}) {
  if (!session?.signals) throw TypeError('serveDataFeeds requires a session with signals');
  const feeds = new Map(Object.entries(feedSpecs || {}).map(([name, spec]) => [name, normalizeFeed(spec)]));
  const cache = new Map();
  const inFlight = new Map();
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const generation = crypto.randomUUID();
  let revision = 0;

  // The session reports how many peers are connected and a revision that changes with every new link.
  const hasConnectedPeers = () => (session.status?.connectedPeers ?? 0) > 0;

  const broadcast = async (name, entry, ttlMs, freshnessOnly = false) => {
    if (lifetime.aborted || !hasConnectedPeers()) return;
    const envelope = {
      feed: name,
      generation,
      revision: entry.revision,
      fetchedAtMs: entry.fetchedAtMs,
      ...(freshnessOnly ? { freshnessOnly: true } : { data: entry.data }),
    };
    const payload = byteLength(envelope) <= INLINE_LIMIT_BYTES
      ? envelope
      : { feed: name, generation, revision: entry.revision, fetchedAtMs: entry.fetchedAtMs, pullRequired: true };
    try {
      await session.signals.send(`${broadcastPrefix}${name}`, payload, { ttlMs, signal: lifetime });
    } catch { /* Best-effort live push; late/reconnecting browsers pull on demand. */ }
  };

  const storeAndBroadcast = async (name, data, { force = false, ttlMs } = {}) => {
    const serialized = JSON.stringify(data);
    const previous = cache.get(name);
    const unchanged = previous && previous.serialized === serialized;
    const entry = unchanged && !force
      ? { ...previous, fetchedAtMs: Date.now() }
      : { feed: name, data, serialized, revision: ++revision, fetchedAtMs: Date.now() };
    cache.set(name, entry);
    await broadcast(name, entry, ttlMs ?? feeds.get(name)?.ttlMs ?? 30_000, unchanged && !force);
    return entry;
  };

  const runFetch = async (name, query = null, { force = false, from = null, reqSignal } = {}) => {
    const spec = feeds.get(name);
    if (!spec) throw Object.assign(Error(`Unknown data feed: ${name}`), { code: 'FEED_NOT_FOUND' });
    const cached = cache.get(name);
    const isDefaultQuery = query === null || query === undefined;
    if (!force && isDefaultQuery && cached && Date.now() - cached.fetchedAtMs <= spec.maxAgeMs) {
      return { feed: name, generation, revision: cached.revision, fetchedAtMs: cached.fetchedAtMs, data: cached.data };
    }
    const flightKey = isDefaultQuery ? name : `${name}:${JSON.stringify(query)}`;
    if (!force && inFlight.has(flightKey)) return inFlight.get(flightKey);
    const combinedSignal = reqSignal ? AbortSignal.any([lifetime, reqSignal]) : lifetime;
    const task = (async () => {
      const data = await spec.fetch(query, { feed: name, from, signal: combinedSignal });
      combinedSignal.throwIfAborted();
      if (isDefaultQuery) {
        const entry = await storeAndBroadcast(name, data, { force, ttlMs: spec.ttlMs });
        return { feed: name, generation, revision: entry.revision, fetchedAtMs: entry.fetchedAtMs, data: entry.data };
      }
      return { feed: name, generation, revision: ++revision, fetchedAtMs: Date.now(), data };
    })();
    inFlight.set(flightKey, task);
    try { return await task; }
    finally { inFlight.delete(flightKey); }
  };

  const timers = [];
  for (const [name, spec] of feeds) {
    if (spec.pollMs > 0) {
      const timer = setInterval(() => {
        if (!lifetime.aborted && hasConnectedPeers()) {
          void runFetch(name, null, { force: false }).catch(() => {});
        }
      }, spec.pollMs);
      timers.push(timer);
    }
  }

  let lastLink = null;
  const offStatus = session.onStatus(status => {
    const peers = status?.connectedPeers ?? 0, link = peers > 0 ? JSON.stringify([peers, status.connectionRevision ?? null]) : null;
    if (link === lastLink) return;
    lastLink = link;
    if (link === null) return;
    // A new link may belong to a browser that missed the earlier broadcast: replay the latest snapshots.
    for (const [name, entry] of cache) {
      void broadcast(name, entry, feeds.get(name)?.ttlMs ?? 30_000);
    }
  });

  const serverDone = serveSignalRequests(session, {
    requestTopic,
    replyTopic,
    signal: lifetime,
    handle: async (feedName, input, ctx) => {
      const query = input && typeof input === 'object' && 'query' in input ? input.query : input;
      const force = Boolean(input && typeof input === 'object' && input.force);
      return runFetch(feedName, query ?? null, { force, from: ctx.from, reqSignal: ctx.signal });
    },
  }).catch(error => {
    if (!lifetime.aborted) throw error;
  });

  lifetime.addEventListener('abort', () => {
    for (const timer of timers) clearInterval(timer);
    offStatus();
  }, { once: true });

  return Object.freeze({
    /** Push an event-driven update (e.g. webhook, file watcher, sensor alert) to connected pages. */
    async push(name, data) {
      const entry = await storeAndBroadcast(name, data, { force: true });
      return { feed: name, generation, revision: entry.revision, fetchedAtMs: entry.fetchedAtMs, data: entry.data };
    },
    refresh(name, query = null) { return runFetch(name, query, { force: true }); },
    snapshot(name) {
      const entry = cache.get(name);
      return entry ? { feed: entry.feed, revision: entry.revision, fetchedAtMs: entry.fetchedAtMs, data: entry.data } : null;
    },
    done: serverDone,
    close() { stop.abort(); },
  });
}

/**
 * Browser side: subscribes to a live data feed (`feed/<name>`) with automatic
 * on-demand initial pull, reconnect refresh, freshness/stale tracking, and
 * large-payload chunk reassembly via `createSignalRequests`.
 */
export function useDataFeed(session, {
  peer,
  feed,
  query = null,
  staleAfterMs = 60_000,
  onUpdate,
  requestTopic = 'feed/pull',
  replyTopic = 'feed/reply',
  broadcastPrefix = 'feed/',
  signal,
} = {}) {
  if (!session?.signals) throw TypeError('useDataFeed requires a session with signals');
  if (typeof feed !== 'string' || !feed) throw TypeError('useDataFeed requires a feed name');
  if (typeof peer !== 'string' || !peer) throw TypeError('useDataFeed requires a peer deviceId');

  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const rpc = createSignalRequests(session, { peer, requestTopic, replyTopic });

  let state = {
    feed,
    data: null,
    fetchedAtMs: null,
    revision: 0,
    generation: null,
    loading: true,
    stale: false,
    error: null,
  };
  let currentQuery = query;
  let queryKey = JSON.stringify(query ?? null);
  let queryVersion = 0;
  let pulling = null;

  const computeStale = () => state.fetchedAtMs !== null && Date.now() - state.fetchedAtMs > staleAfterMs;
  const emit = () => {
    const next = { ...state, stale: computeStale() };
    state = next;
    try { onUpdate?.(next); } catch { /* ignore UI observer errors */ }
  };

  const applyEnvelope = (envelope, authoritative = false) => {
    if (!envelope || typeof envelope !== 'object') return;
    const sameGeneration = (envelope.generation ?? null) === state.generation;
    if (!sameGeneration && state.generation !== null && !authoritative) return;
    if (sameGeneration && typeof envelope.revision === 'number' && envelope.revision < state.revision) return;
    if (envelope.freshnessOnly && state.data === null) return;
    state = {
      feed,
      data: envelope.freshnessOnly ? state.data : envelope.data,
      fetchedAtMs: typeof envelope.fetchedAtMs === 'number' ? envelope.fetchedAtMs : Date.now(),
      revision: typeof envelope.revision === 'number' ? envelope.revision : state.revision + 1,
      generation: envelope.generation ?? null,
      loading: false,
      stale: false,
      error: null,
    };
    emit();
  };

  const pull = async (nextQuery = currentQuery, { force = false } = {}) => {
    const nextKey = JSON.stringify(nextQuery ?? null);
    if (nextKey !== queryKey) {
      queryKey = nextKey;
      ++queryVersion;
      pulling = null;
      state = { ...state, data: null, fetchedAtMs: null, revision: 0, generation: null };
    }
    currentQuery = nextQuery;
    if (pulling && !force) return pulling;
    const version = ++queryVersion;
    const requestedQuery = nextQuery;
    state = { ...state, loading: state.data === null, error: null };
    emit();
    const task = (async () => {
      try {
        await whenConnected(session, peer, { signal: lifetime });
        const result = await rpc.request(feed, { query: requestedQuery, force }, { signal: lifetime, timeoutMs: 25_000 });
        if (!lifetime.aborted && version === queryVersion) applyEnvelope(result, true);
        return result;
      } catch (error) {
        if (!lifetime.aborted && version === queryVersion) {
          state = { ...state, loading: false, error: error instanceof Error ? error.message : String(error) };
          emit();
        }
        throw error;
      }
    })();
    pulling = task;
    try { return await task; }
    finally { if (pulling === task) pulling = null; }
  };

  // Subscribe to live push updates (with late-join includeLatest when supported).
  const subLoop = (async () => {
    try {
      for await (const frame of session.signals.subscribe({
        topics: [`${broadcastPrefix}${feed}`],
        mode: 'latest',
        includeLatest: true,
        signal: lifetime,
      })) {
        if (frame.authorId !== peer) continue;
        const payload = frame.payload;
        if (!payload || typeof payload !== 'object') continue;
        // Pushes contain the default query only. Never replace a filtered result.
        if (currentQuery !== null && currentQuery !== undefined) continue;
        const changedGeneration = state.generation !== null && (payload.generation ?? null) !== state.generation;
        if (payload.pullRequired || changedGeneration || (payload.freshnessOnly && state.data === null)) {
          void pull(currentQuery, { force: false }).catch(() => {});
        } else {
          applyEnvelope(payload);
        }
      }
    } catch { /* closed */ }
  })();

  const linkOf = status => (status?.connectedPeers ?? 0) > 0 ? JSON.stringify([status.connectionRevision ?? null]) : null;
  let lastLink = linkOf(session.status);
  const offStatus = session.onStatus(status => {
    const link = linkOf(status);
    // Connecting (or reconnecting, which changes the revision) refreshes the feed from its server.
    if (link !== null && link !== lastLink) void pull(currentQuery, { force: false }).catch(() => {});
    lastLink = link;
  });

  const staleTimer = setInterval(() => {
    if (!lifetime.aborted && state.fetchedAtMs !== null) {
      const nextStale = computeStale();
      if (nextStale !== state.stale) emit();
    }
  }, Math.max(2_000, Math.min(10_000, Math.floor(staleAfterMs / 3))));

  lifetime.addEventListener('abort', () => {
    clearInterval(staleTimer);
    offStatus();
    rpc.close();
  }, { once: true });

  // Kick off initial pull without throwing unhandled rejections if offline.
  void pull(currentQuery, { force: false }).catch(() => {});

  return Object.freeze({
    snapshot: () => ({ ...state, stale: computeStale() }),
    refresh: (nextQuery = currentQuery) => pull(nextQuery, { force: true }),
    done: subLoop,
    close() { stop.abort(); },
  });
}
