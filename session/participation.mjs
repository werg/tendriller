import { createPeerIntroductions } from '../contract/introductions.mjs';
import { authorityRecord, authorityRecordBytes } from '../contract/authority.mjs';
import { bytesToHex, decodeRecord, decodeSignedOperation, encryptedEnvelopeDigest, hexToBytes, operationIdDigest } from '@chronolog/peer-session';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { PEER_TRANSPORT_POLICY } from '../contract/transport-policy.mjs';
import { createHostRevisionTracker } from '../contract/discovery-watch.mjs';
export { PEER_TRANSPORT_POLICY };
const failureCode = (cause, fallback) => { const code = cause?.code ?? cause?.message; return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code) ? code : fallback; };
const pause = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); timer.unref?.(); signal.addEventListener('abort', done, { once: true });
  if (signal.aborted) done();
});

/** Optional background introductions. Local authoring and opening never wait for this controller. */
export function participateApplication(session, {
  peers, openDirectConnection,
  configuration = PEER_TRANSPORT_POLICY.configuration,
  directTimeoutMs = PEER_TRANSPORT_POLICY.directTimeoutMs,
  upgradeCooldownMs = 30_000,
  // The higher identity waits this long for the lower one's dial before dialing itself.
  // It must exceed the lower side's discover -> invite latency: simultaneous dials
  // supersede each other's channels and both fail (500 ms degraded e2e convergence).
  passiveDialDelayMs = 1500,
  stableLinkMs = 30_000,
  active: initialActive = true,
  onTransport,
  onNotification,
  // `false` when another controller (the admission controller) owns public-control
  // sync for this session, so one notification never costs two control syncs.
  syncControl: ownControlSync = true,
} = {}) {
  if (!Number.isSafeInteger(upgradeCooldownMs) || upgradeCooldownMs < 0 || upgradeCooldownMs > 600_000) throw TypeError('upgradeCooldownMs must be a bounded integer');
  if (!Number.isSafeInteger(passiveDialDelayMs) || passiveDialDelayMs < 0 || passiveDialDelayMs > 30_000) throw TypeError('passiveDialDelayMs must be a bounded integer');
  if (!Number.isSafeInteger(stableLinkMs) || stableLinkMs < 0 || stableLinkMs > 600_000) throw TypeError('stableLinkMs must be a bounded integer');
  if (typeof session?.connectPeer !== 'function' || typeof session.device?.storageId !== 'string' || !session.device.storageId || typeof openDirectConnection !== 'function') throw TypeError('Provide an owned operation-set session and RTC adapter');

  const stop = new AbortController(), signal = AbortSignal.any([stop.signal, session.signal]);
  const adapter = createPeerIntroductions({
    peers,
    identity: session.identity.publicKey,
    directTimeoutMs,
    openDirectConnection: options => openDirectConnection({ ...options, configuration, timeoutMs: directTimeoutMs }),
    openRelayConnection: ({ relay, signal: relaySignal }) => openWebSocketConnection(relay, { ready: relay.ready, signal: relaySignal }),
    onTransport,
  });

  const links = new Map(), opening = new Map(), listeners = new Set(), descriptions = new Map();
  const introduced = new Map(), passiveFallbacks = new Map(), stableTimers = new Map();
  const peerRetryCounts = new Map(), peerRetryTimers = new Map();
  let error = null, advertising, refreshing, dirty = false, retry, globalRetryCount = 0, connectionRevision = 0;
  let networkActive = Boolean(initialActive);
  let activeRun = null;

  function cancelPassiveFallback(peerId) {
    const timer = passiveFallbacks.get(peerId);
    if (timer !== undefined) { clearTimeout(timer); passiveFallbacks.delete(peerId); }
  }
  function clearPeerRetry(peerId) {
    const timer = peerRetryTimers.get(peerId);
    if (timer !== undefined) { clearTimeout(timer); peerRetryTimers.delete(peerId); }
  }
  function resetAllRetryBackoffs() {
    globalRetryCount = 0;
    peerRetryCounts.clear();
    clearTimeout(retry);
    retry = undefined;
    for (const timer of peerRetryTimers.values()) clearTimeout(timer);
    peerRetryTimers.clear();
  }
  function schedulePeerRetry(peer) {
    if (signal.aborted || !networkActive || peerRetryTimers.has(peer.identity) || links.has(peer.identity) || opening.has(peer.identity)) return;
    const count = peerRetryCounts.get(peer.identity) ?? 0;
    peerRetryCounts.set(peer.identity, count + 1);
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(count, 5));
    const timer = setTimeout(() => {
      peerRetryTimers.delete(peer.identity);
      if (signal.aborted || !networkActive || links.has(peer.identity) || opening.has(peer.identity)) return;
      if (session.isReader(peer.identity)) void connect(peer);
    }, delay);
    timer.unref?.();
    peerRetryTimers.set(peer.identity, timer);
  }
  function schedulePassiveFallback(peer) {
    if (signal.aborted || !networkActive || passiveDialDelayMs === 0 || passiveFallbacks.has(peer.identity) || links.has(peer.identity) || opening.has(peer.identity)) return;
    const timer = setTimeout(() => {
      passiveFallbacks.delete(peer.identity);
      if (signal.aborted || !networkActive || links.has(peer.identity) || opening.has(peer.identity) || !session.isReader(peer.identity)) return;
      void connect(peer, undefined, false, true);
    }, passiveDialDelayMs);
    timer.unref?.();
    passiveFallbacks.set(peer.identity, timer);
  }

  const status = () => Object.freeze({
    phase: signal.aborted ? 'closed' : links.size ? 'connected' : opening.size ? 'connecting' : 'disconnected',
    connectedPeers: Object.freeze([...links.keys()].sort()),
    connectionRevision,
    pendingConnections: opening.size,
    error,
  });
  const changed = () => { for (const listener of listeners) { try { listener(status()); } catch {} } };

  function scheduleRetry() {
    if (retry || signal.aborted || !networkActive) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (!networkActive || signal.aborted) return;
      void advertise();
      void refresh();
    }, Math.min(30_000, 1000 * 2 ** Math.min(globalRetryCount++, 5)));
    retry.unref?.();
  }

  function advertise() {
    if (signal.aborted || !networkActive || advertising) return advertising;
    const runSignal = activeRun?.signal ?? signal;
    advertising = adapter.discovery.advertise({ identity: session.identity.publicKey, storageId: session.device.storageId }, { signal: runSignal }).then(() => {
      globalRetryCount = 0;
      if (error?.startsWith('advertise:')) { error = null; changed(); }
    }, cause => {
      if (!runSignal.aborted) { error = `advertise:${failureCode(cause, 'advertisement_unavailable')}`; changed(); scheduleRetry(); }
    }).finally(() => { advertising = undefined; });
    return advertising;
  }

  function retire(peerId) {
    const stale = links.get(peerId);
    if (!stale) return;
    void stale.close().catch(() => {});
    if (links.get(peerId) === stale) { links.delete(peerId); descriptions.delete(peerId); connectionRevision++; }
  }

  async function connect(peer, invitation, promote = false, fallbackDial = false) {
    if (signal.aborted || !networkActive || peer.identity === session.identity.publicKey) return;
    const runSignal = activeRun?.signal ?? signal;
    const upgrade = promote || typeof invitation?.channel === 'string' && invitation.channel.startsWith('direct:');
    if (invitation !== undefined) {
      cancelPassiveFallback(peer.identity);
      clearPeerRetry(peer.identity);
      if ((links.has(peer.identity) || opening.has(peer.identity)) && introduced.get(peer.identity) === invitation?.channel) return;
      opening.get(peer.identity)?.abort(new Error('PEER_CONNECTION_SUPERSEDED'));
      if (!upgrade) retire(peer.identity);
    }
    if (opening.has(peer.identity) && invitation === undefined || links.size + opening.size >= 16) return;
    if (upgrade ? !links.has(peer.identity) || promote && descriptions.get(peer.identity)?.kind !== 'relay' : links.has(peer.identity)) return;
    if (invitation === undefined && !promote && !fallbackDial && session.identity.publicKey > peer.identity) {
      schedulePassiveFallback(peer);
      return;
    }
    cancelPassiveFallback(peer.identity);
    clearPeerRetry(peer.identity);
    const controller = new AbortController(), connectionSignal = AbortSignal.any([runSignal, controller.signal]);
    opening.set(peer.identity, controller); introduced.set(peer.identity, invitation?.channel); changed();
    let connection, route, shouldRetryPeer = false;
    try {
      const target = { peer, ...(invitation === undefined ? {} : { invitation }) };
      connection = await (promote ? adapter.transport.upgrade(target, { signal: connectionSignal }) : adapter.transport.open(target, { signal: connectionSignal }));
      if (upgrade) { connectionSignal.throwIfAborted(); retire(peer.identity); }
      route = adapter.transport.describe(connection); descriptions.set(peer.identity, route);
      const link = await session.connectPeer({ connection, peerIdentity: peer.identity, signal: connectionSignal });
      if (runSignal.aborted || link.signal.aborted) {
        if (descriptions.get(peer.identity) === route) descriptions.delete(peer.identity);
        await link.close();
        if (!runSignal.aborted) shouldRetryPeer = true;
        return;
      }
      links.set(peer.identity, link); connectionRevision++; error = null;
      const previousStable = stableTimers.get(peer.identity);
      if (previousStable !== undefined) { clearTimeout(previousStable); stableTimers.delete(peer.identity); }
      if (stableLinkMs === 0) {
        peerRetryCounts.delete(peer.identity);
      } else {
        const stableTimer = setTimeout(() => {
          if (stableTimers.get(peer.identity) === stableTimer) stableTimers.delete(peer.identity);
          if (links.get(peer.identity) === link) peerRetryCounts.delete(peer.identity);
        }, stableLinkMs);
        stableTimer.unref?.();
        stableTimers.set(peer.identity, stableTimer);
      }
      link.signal.addEventListener('abort', () => {
        const timer = stableTimers.get(peer.identity);
        if (timer !== undefined) { clearTimeout(timer); stableTimers.delete(peer.identity); }
        if (links.get(peer.identity) === link) { links.delete(peer.identity); descriptions.delete(peer.identity); connectionRevision++; }
        changed();
        if (!runSignal.aborted) schedulePeerRetry(peer);
      }, { once: true });
    } catch (cause) {
      if (route && descriptions.get(peer.identity) === route && !links.has(peer.identity)) descriptions.delete(peer.identity);
      try { await connection?.close(); } catch {}
      if (!connectionSignal.aborted && !links.has(peer.identity)) {
        const code = failureCode(cause, 'peer_connection_unavailable');
        error = `connect:${code}`;
        if (code === 'PEER_MESSAGE_FRAME_TOO_LARGE') {
          void maybeCollectGarbage({ force: true });
        }
        shouldRetryPeer = true;
      }
    } finally {
      if (opening.get(peer.identity) === controller) opening.delete(peer.identity);
      changed();
      if (shouldRetryPeer) schedulePeerRetry(peer);
    }
  }

  const promoted = new Map();
  function promoteRelays() {
    if (signal.aborted || !networkActive) return Promise.resolve();
    const now = Date.now();
    for (const peerId of promoted.keys()) if (!links.has(peerId)) promoted.delete(peerId);
    const work = [...links.keys()].filter(peerId => descriptions.get(peerId)?.kind === 'relay' && !opening.has(peerId) &&
      now - (promoted.get(peerId) ?? -Infinity) >= upgradeCooldownMs);
    for (const peerId of work) promoted.set(peerId, now);
    return Promise.allSettled(work.map(peerId => connect({ identity: peerId, route: null }, undefined, true))).then(() => undefined);
  }

  const uploadedDigests = new Set(), uploadedOpIds = new Set(), uploadedCasHashes = new Set();
  const knownControlOpIds = new Set(), knownControlCasHashes = new Set();
  let seededControl = false;
  let snapshotChecked = false, lastSnapshotOpCount = 0, snapshotUploading = false;
  let lastDirectory = [];
  let mailboxInFlight = null, mailboxDirty = false, mailboxTimer = undefined;
  let mergingFromMailbox = false, lastMailboxSyncAt = 0, mailboxCooldownUntil = 0, mailboxFailures = 0;

  async function maybeHydrateFromSnapshot() {
    if (snapshotChecked || signal.aborted || !networkActive) return;
    if (typeof peers.fetchSnapshot !== 'function' || typeof session.importMaterializedSnapshot !== 'function') {
      snapshotChecked = true;
      return;
    }
    const isPrivate = session.genesis?.privateLog !== false;
    const epoch = typeof session.currentEpoch === 'function' ? session.currentEpoch() : -1;
    if (isPrivate && epoch >= 0 && typeof session.hasEpochKey === 'function' && !session.hasEpochKey(epoch)) {
      return; // Wait until epoch key arrives before trying to decrypt snapshot
    }
    snapshotChecked = true;
    try {
      const facts = await session.exportFacts();
      const localCount = isPrivate ? (facts.encryptedEnvelopes?.length ?? 0) : (facts.publicOps?.length ?? 0);
      if (localCount > 0) {
        lastSnapshotOpCount = localCount;
        return;
      }
      const fetched = await peers.fetchSnapshot({ signal }).catch(() => null);
      if (!fetched?.bytes?.byteLength) return;
      await session.importMaterializedSnapshot(fetched.bytes).catch(() => {});
      if (fetched.opCount > 0) lastSnapshotOpCount = fetched.opCount;
    } catch {}
  }

  function maybeUploadSnapshot() {
    if (snapshotUploading || signal.aborted || !networkActive) return;
    if (typeof peers.uploadSnapshot !== 'function' || typeof session.exportMaterializedSnapshot !== 'function') return;
    if (session.status?.canAuthor === false) return;
    snapshotUploading = true;
    void (async () => {
      try {
        const facts = await session.exportFacts();
        const isPrivate = session.genesis?.privateLog !== false;
        const opCount = isPrivate ? (facts.encryptedEnvelopes?.length ?? 0) : (facts.publicOps?.length ?? 0);
        if (opCount < 10 || opCount - lastSnapshotOpCount < 25) return;
        const bundle = await session.exportMaterializedSnapshot();
        if (!bundle || bundle.byteLength === 0 || bundle.byteLength > 15 * 1024 * 1024) return;
        const res = await peers.uploadSnapshot(bundle, { signal }).catch(() => null);
        if (res?.stored) lastSnapshotOpCount = opCount;
      } catch {}
    })().finally(() => { snapshotUploading = false; });
  }

  let gcInFlight = null, lastGcAt = 0, opsSinceGc = 0;
  function maybeCollectGarbage({ force = false } = {}) {
    if (signal.aborted || typeof session.collectGarbage !== 'function') return Promise.resolve();
    const now = Date.now();
    const minInterval = force ? 30_000 : 600_000;
    if (gcInFlight || now - lastGcAt < minInterval) return gcInFlight ?? Promise.resolve();
    lastGcAt = now;
    opsSinceGc = 0;
    gcInFlight = Promise.resolve()
      .then(() => session.collectGarbage())
      .catch(() => {})
      .finally(() => { gcInFlight = null; });
    return gcInFlight;
  }

  async function seedKnownControlFacts() {
    if (seededControl || typeof session.exportPublicControlFacts !== 'function') return;
    seededControl = true;
    try {
      const facts = await session.exportPublicControlFacts();
      for (const raw of facts.publicOps ?? []) {
        try { knownControlOpIds.add(bytesToHex(operationIdDigest(decodeSignedOperation(raw).coreBytes))); } catch {}
      }
      for (const node of facts.casNodes ?? []) {
        if (node?.hash) knownControlCasHashes.add(node.hash);
      }
    } catch {}
  }

  async function syncMailbox({ force = false } = {}) {
    if (signal.aborted || !networkActive || typeof peers.syncMailbox !== 'function' || typeof session.exportFacts !== 'function') return;
    const now = Date.now();
    if (!force && (now < mailboxCooldownUntil || now - lastMailboxSyncAt < 5000)) return;
    mailboxDirty = true;
    if (mailboxInFlight) return mailboxInFlight;
    mailboxInFlight = (async () => {
      while (mailboxDirty && !signal.aborted && networkActive) {
        mailboxDirty = false;
        try {
          const facts = await session.exportFacts();
          const isPrivate = session.genesis?.privateLog !== false;
          const knownEnvelopeDigests = [];
          const outgoingEnvelopes = [];
          const knownOpIds = [];
          const outgoingOps = [];
          const knownCasHashes = [];
          const outgoingCas = [];

          if (isPrivate) {
            for (const raw of facts.encryptedEnvelopes ?? []) {
              const digest = bytesToHex(encryptedEnvelopeDigest(raw));
              knownEnvelopeDigests.push(digest);
              if (!uploadedDigests.has(digest) && outgoingEnvelopes.length < 128) {
                outgoingEnvelopes.push({ digest, record: authorityRecord(raw) });
              }
            }
          } else {
            for (const raw of facts.publicOps ?? []) {
              try {
                const signed = decodeSignedOperation(raw);
                const opId = bytesToHex(operationIdDigest(signed.coreBytes));
                knownOpIds.push(opId);
                if (!uploadedOpIds.has(opId) && outgoingOps.length < 128) {
                  outgoingOps.push({ opId, record: authorityRecord(raw) });
                }
              } catch { /* skip */ }
            }
          }

          if (!isPrivate) {
            for (const node of facts.casNodes ?? []) {
              if (node.partition !== 'public') continue;
              knownCasHashes.push(node.hash);
              if (!uploadedCasHashes.has(node.hash) && outgoingCas.length < 128 && node.bytes.byteLength <= 512 * 1024) {
                outgoingCas.push({ hash: node.hash, partition: 'public', bytes: bytesToHex(node.bytes) });
              }
            }
          }

          if (!outgoingEnvelopes.length && !outgoingOps.length && !outgoingCas.length && lastMailboxSyncAt > 0 && Date.now() - lastMailboxSyncAt < 5000) {
            break;
          }

          const resp = await peers.syncMailbox({
            ...(outgoingEnvelopes.length ? { encryptedEnvelopes: outgoingEnvelopes.map(e => e.record) } : {}),
            ...(outgoingOps.length ? { publicOps: outgoingOps.map(o => o.record) } : {}),
            ...(outgoingCas.length ? { casNodes: outgoingCas } : {}),
            knownEnvelopeDigests,
            knownOpIds,
            knownCasHashes,
          }, { signal }).catch(() => null);

          if (!resp) {
            mailboxFailures++;
            mailboxCooldownUntil = Date.now() + Math.min(30_000, 2000 * 2 ** Math.min(mailboxFailures - 1, 4));
            break;
          }
          mailboxFailures = 0;
          mailboxCooldownUntil = 0;
          lastMailboxSyncAt = Date.now();
          revisions.observe('mailbox', resp.revision);
          for (const e of outgoingEnvelopes) uploadedDigests.add(e.digest);
          for (const o of outgoingOps) uploadedOpIds.add(o.opId);
          for (const c of outgoingCas) uploadedCasHashes.add(c.hash);

          const incomingEnvelopes = (resp.encryptedEnvelopes ?? []).map(r => authorityRecordBytes(r, 256 * 1024));
          const incomingOps = (resp.publicOps ?? []).map(r => authorityRecordBytes(r, 256 * 1024));
          const incomingCas = (resp.casNodes ?? []).map(n => ({
            hash: n.hash,
            bytes: hexToBytes(n.bytes),
            partition: n.partition === 'private' ? 'private' : 'public',
          }));
          for (const raw of incomingEnvelopes) uploadedDigests.add(bytesToHex(encryptedEnvelopeDigest(raw)));
          for (const raw of incomingOps) {
            try { uploadedOpIds.add(bytesToHex(operationIdDigest(decodeSignedOperation(raw).coreBytes))); } catch {}
          }
          for (const c of incomingCas) uploadedCasHashes.add(c.hash);

          if (incomingEnvelopes.length || incomingOps.length || incomingCas.length) {
            mergingFromMailbox = true;
            try {
              await session.mergeFacts({
                publicOps: incomingOps,
                encryptedEnvelopes: incomingEnvelopes,
                casNodes: incomingCas,
                retentions: [],
                checkpoints: [],
              });
            } finally {
              mergingFromMailbox = false;
            }
          }
        } catch {
          mailboxFailures++;
          mailboxCooldownUntil = Date.now() + Math.min(30_000, 2000 * 2 ** Math.min(mailboxFailures - 1, 4));
          break;
        }
      }
    })().finally(() => { mailboxInFlight = null; });
    return mailboxInFlight;
  }

  function scheduleMailboxSync() {
    if (signal.aborted || !networkActive || mergingFromMailbox || typeof peers.syncMailbox !== 'function') return;
    // Live connected peers replicate directly over WebRTC/relay at zero host cost;
    // only push to the blind store-and-forward mailbox on fact changes when no peer link is open.
    if (links.size > 0 || Date.now() < mailboxCooldownUntil) return;
    if (mailboxTimer !== undefined) return;
    mailboxTimer = setTimeout(() => {
      mailboxTimer = undefined;
      if (links.size > 0 || !networkActive || signal.aborted) return;
      void syncMailbox({ force: true });
    }, 250);
    mailboxTimer.unref?.();
  }

  const ALL_SCOPES = Object.freeze(['control', 'directory', 'mailbox']);
  const revisions = createHostRevisionTracker();
  let pendingScopes = new Set();

  async function syncControlFacts(runSignal) {
    if (!ownControlSync || typeof peers.syncControl !== 'function') return;
    await seedKnownControlFacts();
    const synced = await peers.syncControl({
      knownOpIds: [...knownControlOpIds],
      knownCasHashes: [...knownControlCasHashes],
    }, { signal: runSignal }).catch(() => null);
    if (!synced) return;
    revisions.observe('control', synced.revision);
    const incomingOps = (synced.publicOps ?? []).map(r => authorityRecordBytes(r, 256 * 1024));
    const incomingCas = (synced.casNodes ?? []).map(n => ({ hash: n.hash, bytes: hexToBytes(n.bytes), partition: 'public' }));
    for (const raw of incomingOps) {
      try { knownControlOpIds.add(bytesToHex(operationIdDigest(decodeSignedOperation(raw).coreBytes))); } catch {}
    }
    for (const node of incomingCas) knownControlCasHashes.add(node.hash);
    if (incomingOps.length || incomingCas.length || synced.checkpoints?.length) {
      await session.mergeFacts({
        publicOps: incomingOps,
        encryptedEnvelopes: [],
        casNodes: incomingCas,
        retentions: [],
        checkpoints: (synced.checkpoints ?? []).map(r => decodeRecord(authorityRecordBytes(r, 256 * 1024))),
      });
    }
  }

  async function readDirectory(runSignal) {
    const directory = await adapter.discovery.readDirectory({ signal: runSignal });
    revisions.observe('directory', directory.revision);
    lastDirectory = directory.peers;
    for (const peer of directory.peers) if (session.isReader(peer.identity)) void connect(peer);
    if (error?.startsWith('discovery:')) error = null;
  }

  // Only scopes the host changed since this session last read them cost a request.
  // A notification arriving during a pass (e.g. the first ready while the boot
  // refresh is in flight) is judged against that pass's response revisions.
  let deferredNotification;
  function evaluateNotification() {
    if (refreshing || !deferredNotification) return;
    const notification = deferredNotification;
    deferredNotification = undefined;
    const stale = revisions.stale(notification, ownControlSync ? ALL_SCOPES : ['directory', 'mailbox']);
    if (stale.length) void refresh(stale);
  }

  /** Re-read the given host scopes (default all). Concurrent calls coalesce into the running pass. */
  async function refresh(scopes = ALL_SCOPES) {
    if (!networkActive || signal.aborted) return;
    for (const scope of scopes) pendingScopes.add(scope);
    dirty = true;
    if (refreshing) return refreshing;
    const runSignal = activeRun?.signal ?? signal;
    refreshing = (async () => {
      while (dirty && !runSignal.aborted && networkActive) {
        dirty = false;
        const want = pendingScopes;
        pendingScopes = new Set();
        try {
          // Peer discovery and connection never wait behind control, snapshot or
          // mailbox transfers; those stay ordered (keys before snapshot before mailbox).
          await Promise.all([
            (async () => {
              if (want.has('control')) await syncControlFacts(runSignal);
              if (want.has('control') || want.has('mailbox')) {
                await maybeHydrateFromSnapshot();
                await syncMailbox(want.has('mailbox') && links.size === 0 && !want.has('control') ? { force: true } : undefined);
                maybeUploadSnapshot();
              }
            })(),
            want.has('directory') ? readDirectory(runSignal) : undefined,
          ]);
        } catch (cause) { if (!runSignal.aborted) { error = `discovery:${failureCode(cause, 'discovery_unavailable')}`; scheduleRetry(); } }
        changed();
      }
    })().finally(() => { refreshing = undefined; evaluateNotification(); });
    return refreshing;
  }

  async function observe(kind, runSignal, consume) {
    let failures = 0;
    while (!runSignal.aborted) {
      try {
        if (kind === 'invitations') void advertise();
        const iter = kind === 'invitations'
          ? adapter.discovery.invitations({ signal: runSignal, onReady: () => { failures = 0; } })
          : adapter.discovery[kind]({ signal: runSignal });
        for await (const value of iter) { failures = 0; await consume(value); }
      } catch (cause) {
        if (!runSignal.aborted) { error = `discovery:${failureCode(cause, 'discovery_unavailable')}`; changed(); }
      }
      if (!runSignal.aborted) {
        scheduleRetry();
        await pause(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), runSignal);
      }
    }
  }

  let observersDone = Promise.resolve();
  function startNetworkLoops() {
    if (signal.aborted || activeRun) return;
    const ctrl = new AbortController();
    const runSignal = AbortSignal.any([signal, ctrl.signal]);
    activeRun = { ctrl, signal: runSignal };
    const notifications = observe('notifications', runSignal, async notification => {
      if (notification.type === 'ready') {
        mailboxFailures = 0;
        mailboxCooldownUntil = 0;
        resetAllRetryBackoffs();
        void advertise();
      }
      try { onNotification?.(notification); } catch {}
      deferredNotification = notification;
      evaluateNotification();
    });
    const invitations = observe('invitations', runSignal, async invitation => {
      if (session.isReader(invitation.peer.identity)) void connect(invitation.peer, invitation.token);
      else void refresh().then(() => { if (session.isReader(invitation.peer.identity)) return connect(invitation.peer, invitation.token); });
    });
    observersDone = Promise.allSettled([notifications, invitations]).then(() => undefined);
    void refresh();
  }

  function stopNetworkLoops() {
    clearTimeout(retry); retry = undefined;
    clearTimeout(mailboxTimer); mailboxTimer = undefined;
    for (const timer of passiveFallbacks.values()) clearTimeout(timer);
    passiveFallbacks.clear();
    for (const timer of peerRetryTimers.values()) clearTimeout(timer);
    peerRetryTimers.clear();
    for (const timer of stableTimers.values()) clearTimeout(timer);
    stableTimers.clear();
    for (const controller of opening.values()) controller.abort(new Error('PARTICIPATION_PAUSED'));
    opening.clear();
    if (activeRun) {
      const current = activeRun;
      activeRun = null;
      current.ctrl.abort(new Error('PARTICIPATION_PAUSED'));
    }
    const closingLinks = [...links.values()];
    links.clear(); descriptions.clear();
    if (closingLinks.length) {
      connectionRevision++;
      changed();
      for (const link of closingLinks) void link.close().catch(() => {});
    }
  }

  function setActive(next) {
    const desired = Boolean(next);
    if (signal.aborted || networkActive === desired) return;
    networkActive = desired;
    if (desired) {
      resetAllRetryBackoffs();
      startNetworkLoops();
    } else {
      stopNetworkLoops();
    }
  }

  const sessionDiagnostics = typeof session.diagnostics === 'function' ? session.diagnostics.bind(session) : null;
  async function diagnostics() {
    const rows = sessionDiagnostics ? await sessionDiagnostics() : [...links.keys()].map(peerId => ({ peerId, kind: 'unknown' }));
    return (Array.isArray(rows) ? rows : []).map(row => {
      const route = row && descriptions.get(row.peerId);
      if (!route) return row;
      const { reason: _, ...rest } = row;
      return { ...rest, kind: route.kind, ...(route.kind === 'relay' && route.reason ? { reason: route.reason } : {}) };
    });
  }

  let annotated = false;
  try { Object.defineProperty(session, 'diagnostics', { value: diagnostics, configurable: true, writable: true }); annotated = true; } catch {}

  let hydrating = null;
  const stopAuthority = session.onChange(() => {
    opsSinceGc += 1;
    if (opsSinceGc >= 200) void maybeCollectGarbage();
    if (!networkActive) return;
    // A newly admitted device receives its epoch key through a control change, not
    // a host scope this controller re-reads; try the snapshot bootstrap then.
    if (!snapshotChecked && !hydrating) hydrating = maybeHydrateFromSnapshot().finally(() => { hydrating = null; });
    void advertise();
    for (const peer of lastDirectory) if (session.isReader(peer.identity)) void connect(peer);
  });
  const stopFacts = typeof session.onFacts === 'function' ? session.onFacts(() => { scheduleMailboxSync(); }) : () => {};

  if (networkActive) startNetworkLoops();

  const closed = new Promise(resolve => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return; stopping = true; stopAuthority(); stopFacts();
      if (annotated && session.diagnostics === diagnostics) { try { delete session.diagnostics; } catch {} }
      const closingLinks = [...links.values()];
      stopNetworkLoops();
      void Promise.allSettled(closingLinks.map(link => link.close())).finally(async () => {
        await observersDone;
        resolve();
      });
    };
    signal.addEventListener('abort', shutdown, { once: true });
    if (signal.aborted) shutdown();
  });

  return Object.freeze({
    get status() { return status(); },
    get active() { return networkActive; },
    signal,
    closed,
    onStatus(listener) { listeners.add(listener); try { listener(status()); } catch {} return () => listeners.delete(listener); },
    diagnostics,
    setActive,
    reconsiderConnections() {
      resetAllRetryBackoffs();
      if (!networkActive) return Promise.resolve();
      adapter.discovery.probe?.();
      return Promise.all([refresh(), promoteRelays()]).then(() => undefined);
    },
    resume() {
      resetAllRetryBackoffs();
      if (networkActive) adapter.discovery.probe?.();
      return refresh();
    },
    async close() { stop.abort(new Error('PARTICIPATION_CLOSED')); await closed; },
  });
}
