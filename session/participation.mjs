import { createPeerIntroductions } from '../contract/introductions.mjs';
import { authorityRecordBytes } from '../contract/authority.mjs';
import { decodeRecord } from '@chronolog/peer-session';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { PEER_TRANSPORT_POLICY } from '../contract/transport-policy.mjs';
export { PEER_TRANSPORT_POLICY };
const failureCode = (cause, fallback) => { const code = cause?.code ?? cause?.message; return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code) ? code : fallback; };
const pause = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); timer.unref?.(); signal.addEventListener('abort', done, { once: true });
  if (signal.aborted) done();
});
/** Optional background introductions. Local authoring and opening never wait for this controller. */
export function participateApplication(session, { peers, openDirectConnection,
  configuration = PEER_TRANSPORT_POLICY.configuration, directTimeoutMs = PEER_TRANSPORT_POLICY.directTimeoutMs, upgradeCooldownMs = 30_000, passiveDialDelayMs = 1500, onTransport, onNotification } = {}) {
  if (!Number.isSafeInteger(upgradeCooldownMs) || upgradeCooldownMs < 0 || upgradeCooldownMs > 600_000) throw TypeError('upgradeCooldownMs must be a bounded integer');
  if (!Number.isSafeInteger(passiveDialDelayMs) || passiveDialDelayMs < 0 || passiveDialDelayMs > 30_000) throw TypeError('passiveDialDelayMs must be a bounded integer');
  if (typeof session?.connectPeer !== 'function' || typeof session.device?.storageId !== 'string' || !session.device.storageId || typeof openDirectConnection !== 'function') throw TypeError('Provide an owned operation-set session and RTC adapter');
  const stop = new AbortController(), signal = AbortSignal.any([stop.signal, session.signal]);
  const adapter = createPeerIntroductions({ peers, identity: session.identity.publicKey, directTimeoutMs,
    openDirectConnection: options => openDirectConnection({ ...options, configuration, timeoutMs: directTimeoutMs }),
    openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }), onTransport });
  const links = new Map(), opening = new Map(), listeners = new Set(), descriptions = new Map(), introduced = new Map(), passiveFallbacks = new Map();
  let error = null, advertising, refreshing, dirty = false, retry, retryCount = 0, connectionRevision = 0;
  function cancelPassiveFallback(peerId) {
    const timer = passiveFallbacks.get(peerId);
    if (timer !== undefined) { clearTimeout(timer); passiveFallbacks.delete(peerId); }
  }
  function schedulePassiveFallback(peer) {
    if (signal.aborted || passiveDialDelayMs === 0 || passiveFallbacks.has(peer.identity) || links.has(peer.identity) || opening.has(peer.identity)) return;
    // One-shot bounded fallback: if the lower-key dialer still thinks its old
    // link from a crashed/reloaded tab is alive, break the 30s ICE deadlock
    // without adding any periodic polling or idle traffic.
    const timer = setTimeout(() => {
      passiveFallbacks.delete(peer.identity);
      if (signal.aborted || links.has(peer.identity) || opening.has(peer.identity) || !session.authority.grant(peer.identity)?.reader) return;
      void connect(peer, undefined, false, true);
    }, passiveDialDelayMs);
    timer.unref?.();
    passiveFallbacks.set(peer.identity, timer);
  }
  const status = () => Object.freeze({ phase: signal.aborted ? 'closed' : links.size ? 'connected' : opening.size ? 'connecting' : 'disconnected', connectedPeers: Object.freeze([...links.keys()].sort()), connectionRevision, pendingConnections: opening.size, error });
  const changed = () => { for (const listener of listeners) { try { listener(status()); } catch {} } };
  function scheduleRetry() {
    if (retry || signal.aborted) return;
    retry = setTimeout(() => { retry = undefined; void advertise(); void refresh(); }, Math.min(30_000, 1000 * 2 ** Math.min(retryCount++, 5)));
    retry.unref?.();
  }
  function advertise() {
    if (signal.aborted || advertising) return advertising;
    // The actual public session owns its retained storage identity on device.
    // One charged request waits for both current socket lifetimes. Failed or
    // replaced lifetimes retry this same routing hint, never application data.
    advertising = adapter.discovery.advertise({ identity: session.identity.publicKey, storageId: session.device.storageId }, { signal }).then(() => {
      if (error?.startsWith('advertise:')) { error = null; changed(); }
    }, cause => {
      if (!signal.aborted) { error = `advertise:${failureCode(cause, 'advertisement_unavailable')}`; changed(); scheduleRetry(); }
    }).finally(() => { advertising = undefined; });
    return advertising;
  }
  // Retire this peer's current link. A later link for the peer owns the slot.
  function retire(peerId) {
    const stale = links.get(peerId);
    if (!stale) return;
    void stale.close().catch(() => {});
    if (links.get(peerId) === stale) { links.delete(peerId); descriptions.delete(peerId); connectionRevision++; }
  }
  // `promote` asks for a direct-only path that replaces a relay link to the peer.
  async function connect(peer, invitation, promote = false, fallbackDial = false) {
    if (signal.aborted || peer.identity === session.identity.publicKey) return;
    // A remote's `direct:` invitation is its promotion attempt: our current link
    // stays until the direct path physically opens, and survives if it fails.
    const upgrade = promote || typeof invitation?.channel === 'string' && invitation.channel.startsWith('direct:');
    if (invitation !== undefined) {
      cancelPassiveFallback(peer.identity);
      // A redelivered hint for the current link or attempt changes nothing.
      if ((links.has(peer.identity) || opening.has(peer.identity)) && introduced.get(peer.identity) === invitation?.channel) return;
      // A peer dials only when it holds no link or attempt to us. Its new
      // host-routed invitation is therefore evidence that our link or attempt
      // is dead on its side, e.g. a black-holed path only it has detected.
      // RTC consent expiry is per endpoint, so the silent end must not keep
      // a dead link and ignore the replacement until its own ICE notices.
      opening.get(peer.identity)?.abort(new Error('PEER_CONNECTION_SUPERSEDED'));
      if (!upgrade) retire(peer.identity);
    }
    if (opening.has(peer.identity) && invitation === undefined || links.size + opening.size >= 16) return;
    if (upgrade ? !links.has(peer.identity) || promote && descriptions.get(peer.identity)?.kind !== 'relay' : links.has(peer.identity)) return;
    // Normally one side proactively dials; the passive side waits briefly so a
    // healthy dialer introduces once, then falls back if the dialer holds a
    // stale dead link from a crashed/reloaded peer.
    if (invitation === undefined && !promote && !fallbackDial && session.identity.publicKey > peer.identity) {
      schedulePassiveFallback(peer);
      return;
    }
    cancelPassiveFallback(peer.identity);
    const controller = new AbortController(), connectionSignal = AbortSignal.any([signal, controller.signal]);
    opening.set(peer.identity, controller); introduced.set(peer.identity, invitation?.channel); changed(); let connection;
    try {
      const target = { peer, ...(invitation === undefined ? {} : { invitation }) };
      connection = await (promote ? adapter.transport.upgrade(target, { signal: connectionSignal }) : adapter.transport.open(target, { signal: connectionSignal }));
      // The direct path is physically open: hand the peer over from its relay link.
      if (upgrade) { connectionSignal.throwIfAborted(); retire(peer.identity); }
      const link = await session.connectPeer({ connection, peerIdentity: peer.identity, signal: connectionSignal });
      if (signal.aborted || link.signal.aborted) { await link.close(); if (!signal.aborted) scheduleRetry(); return; }
      links.set(peer.identity, link); descriptions.set(peer.identity, adapter.transport.describe(connection)); connectionRevision++; error = null; retryCount = 0;
      link.signal.addEventListener('abort', () => { if (links.get(peer.identity) === link) { links.delete(peer.identity); descriptions.delete(peer.identity); connectionRevision++; } changed(); scheduleRetry(); }, { once: true });
    } catch (cause) {
      try { await connection?.close(); } catch {}
      // A failed promotion keeps the working relay link; nothing needs a retry.
      if (!connectionSignal.aborted && !links.has(peer.identity)) { error = `connect:${failureCode(cause, 'peer_connection_unavailable')}`; scheduleRetry(); }
    } finally { if (opening.get(peer.identity) === controller) opening.delete(peer.identity); changed(); }
  }
  // Event-triggered only (online, network change, visible page): never a timer.
  // A per-peer cooldown bounds promotion attempts while UDP stays unusable.
  const promoted = new Map();
  function promoteRelays() {
    if (signal.aborted) return Promise.resolve();
    const now = Date.now();
    for (const peerId of promoted.keys()) if (!links.has(peerId)) promoted.delete(peerId);
    const work = [...links.keys()].filter(peerId => descriptions.get(peerId)?.kind === 'relay' && !opening.has(peerId) &&
      now - (promoted.get(peerId) ?? -Infinity) >= upgradeCooldownMs);
    for (const peerId of work) promoted.set(peerId, now);
    return Promise.allSettled(work.map(peerId => connect({ identity: peerId, route: null }, undefined, true))).then(() => undefined);
  }
  async function refresh() {
    dirty = true; if (refreshing) return refreshing;
    refreshing = (async () => {
      while (dirty && !signal.aborted) {
        dirty = false;
        try {
          // Cached local authority has already opened. Refresh is untrusted signed evidence, not an opening gate.
          const metadata = await peers.application({ signal });
          if (metadata.authority) await session.authority.merge(decodeRecord(authorityRecordBytes(metadata.authority)));
          const directory = await adapter.discovery.read({ signal });
          for (const peer of directory) if (session.authority.grant(peer.identity)?.reader) void connect(peer);
          if (error?.startsWith('discovery:')) error = null;
        } catch (cause) { if (!signal.aborted) { error = `discovery:${failureCode(cause, 'discovery_unavailable')}`; scheduleRetry(); } }
        changed();
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  async function observe(kind, consume) {
    let failures = 0;
    while (!signal.aborted) {
      try { if (kind === 'invitations') void advertise(); for await (const value of adapter.discovery[kind]({ signal })) { failures = 0; await consume(value); } }
      catch (cause) { if (!signal.aborted) { error = `discovery:${failureCode(cause, 'discovery_unavailable')}`; changed(); } }
      if (!signal.aborted) { scheduleRetry(); await pause(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), signal); }
    }
  }
  const notifications = observe('notifications', async notification => {
    if (notification.type === 'ready') {
      // Advertising waits for both socket lifetimes, but no data submission waits for advertising.
      void advertise();
    }
    // The host notifies page changes (membership, admission requests, key wraps) here.
    try { onNotification?.(notification); } catch {}
    void refresh();
  });
  const invitations = observe('invitations', async invitation => {
    if (session.authority.grant(invitation.peer.identity)?.reader) void connect(invitation.peer, invitation.token);
    else void refresh().then(() => { if (session.authority.grant(invitation.peer.identity)?.reader) return connect(invitation.peer, invitation.token); });
  });
  const stopAuthority = session.authority.subscribe(() => { void advertise(); void refresh(); });
  const closed = new Promise(resolve => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return; stopping = true; stopAuthority(); clearTimeout(retry);
      for (const timer of passiveFallbacks.values()) clearTimeout(timer);
      passiveFallbacks.clear();
      for (const controller of opening.values()) controller.abort(signal.reason);
      void Promise.allSettled([...links.values()].map(link => link.close())).finally(async () => { links.clear(); descriptions.clear(); connectionRevision++; changed(); await Promise.allSettled([notifications, invitations]); resolve(); });
    };
    signal.addEventListener('abort', shutdown, { once: true }); if (signal.aborted) shutdown();
  });
  void refresh();
  return Object.freeze({ get status() { return status(); }, signal, closed,
    onStatus(listener) { listeners.add(listener); try { listener(status()); } catch {} return () => listeners.delete(listener); },
    async diagnostics() { return [...links.keys()].map(peerId => ({ peerId, ...descriptions.get(peerId) })); },
    reconsiderConnections() { return Promise.all([refresh(), promoteRelays()]).then(() => undefined); }, resume() { return refresh(); },
    async close() { stop.abort(new Error('PARTICIPATION_CLOSED')); await closed; },
  });
}
