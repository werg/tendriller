/** Local observation only: never opens a peer, sends a probe or reads the host. */
export const TRANSPORT_DIAGNOSTIC_PROTOCOL = 'tendriller.transport-diagnostics.v1';
export const TRANSPORT_DIAGNOSTIC_LIMIT = 64;
const phases = new Set(['connecting','connected','disconnected','unavailable','closed']);
const kinds = new Set(['direct','relay','unknown']);
const reasons = new Set(['direct_failed','direct_timeout']);
const peer = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The source is the owned participant's authenticated-link diagnostics API.
 * Raw adapter onTransport selections deliberately have no input path here. */
export function createTransportDiagnostics(participation, { signal, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw TypeError('Invalid local diagnostics deadline');
  const listeners = new Set(); let closed = false, stopStatus = () => {}, version = 0, pending, physicalPending = false, refreshAfterPending = false, connectionRevision = null;
  let phase = 'unknown', peers = null, sampled = false, sampleLimited = false, statusLimited = false, failure = null, rows = [];
  let cancelRead = () => {};
  const supported = typeof participation?.diagnostics === 'function';
  function status() {
    return Object.freeze({ protocol: TRANSPORT_DIAGNOSTIC_PROTOCOL,
      state: closed ? 'closed' : !supported ? 'unavailable' : 'available', phase, connectionRevision,
      authenticatedPeers: peers?.size ?? (sampled ? new Set(rows.map(row => row.peerId)).size : null), sampled, limited: statusLimited || sampleLimited, error: failure,
      connections: Object.freeze(rows.map((row, index) => Object.freeze({ link: index + 1, kind: row.kind, reason: row.reason,
        sentBytes: row.sentBytes, receivedBytes: row.receivedBytes, sentReliableBytes: row.sentReliableBytes, receivedReliableBytes: row.receivedReliableBytes, sentLiveBytes: row.sentLiveBytes, receivedLiveBytes: row.receivedLiveBytes, sentRequests: row.sentRequests, receivedRequests: row.receivedRequests }))),
    });
  }
  const notify = (listener, value) => { try { void Promise.resolve(listener(value)).catch(() => {}); } catch {} };
  function emit() { const value = status(); for (const listener of [...listeners]) if (listeners.has(listener)) notify(listener, value); }
  function changed(value) {
    if (closed) return;
    const nextPhase = phases.has(value?.phase) ? value.phase : value?.phase === 'ready' && counter(value.connectedPeers) !== null ? value.connectedPeers > 0 ? 'connected' : 'disconnected' : 'unknown';
    const nextRevision = counter(value?.connectionRevision);
    const routeChanged = connectionRevision !== null && nextRevision !== null && nextRevision !== connectionRevision;
    const ids = Array.isArray(value?.connectedPeers) ? value.connectedPeers.slice(0, TRANSPORT_DIAGNOSTIC_LIMIT).filter(peer) : null;
    const nextPeers = ids && new Set(ids);
    const nextStatusLimited = Array.isArray(value?.connectedPeers) && value.connectedPeers.length > TRANSPORT_DIAGNOSTIC_LIMIT;
    const sameStatusLimit = nextStatusLimited === statusLimited; statusLimited = nextStatusLimited;
    const samePeers = peers === null && nextPeers === null || peers !== null && nextPeers !== null && peers.size === nextPeers.size && [...peers].every(id => nextPeers.has(id));
    if (nextPhase === phase && samePeers && nextRevision === connectionRevision && sameStatusLimit) return;
    phase = nextPhase; peers = nextPeers; connectionRevision = nextRevision; version++; sampled = false;
    if (phase === 'closed') { close(); return; }
    rows = !routeChanged && peers ? rows.filter(row => peers.has(row.peerId)) : [];
    emit();
    if (routeChanged) { if (physicalPending) refreshAfterPending = true; else void refresh(); }
  }
  function close() {
    if (closed) return;
    closed = true; version++; try { stopStatus(); } catch {} signal?.removeEventListener('abort', close); rows = []; peers = null; sampled = false; cancelRead();
    emit(); listeners.clear();
  }
  function refresh() {
    if (closed || !supported) return Promise.resolve(status());
    if (pending) return pending;
    if (physicalPending) return Promise.resolve(status());
    const atVersion = version;
    let timer, finish, settled = false;
    const result = new Promise(resolve => { finish = () => { if (settled) return; settled = true; clearTimeout(timer); cancelRead = () => {}; pending = undefined; resolve(status()); }; });
    pending = result; physicalPending = true;
    cancelRead = finish;
    timer = setTimeout(() => { if (!closed) { failure = 'timed_out'; sampled = false; rows = []; emit(); } finish(); }, timeoutMs);
    // Keep an uncooperative physical read charged until it settles. Repeated
    // clicks cannot create more outstanding local owner calls after timeout.
    void Promise.resolve().then(() => { if (closed) return; return participation.diagnostics(); }).then(value => {
      if (closed || settled || version !== atVersion) return;
      if (!Array.isArray(value)) { failure = 'invalid_diagnostics'; rows = []; sampled = false; emit(); return; }
      const next = [], seen = new Set(); let nextSampleLimited = value.length > TRANSPORT_DIAGNOSTIC_LIMIT;
      for (const item of value.slice(0, TRANSPORT_DIAGNOSTIC_LIMIT)) {
        const linkId = typeof item?.connectionId === 'string' && item.connectionId.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(item.connectionId) ? item.connectionId : item?.peerId;
        if (!item || !peer(item.peerId) || seen.has(linkId) || peers && !peers.has(item.peerId)) { nextSampleLimited = true; continue; }
        seen.add(linkId);
        next.push({ peerId: item.peerId, kind: kinds.has(item.kind) ? item.kind : 'unknown', reason: item.kind === 'relay' && reasons.has(item.reason) ? item.reason : null,
          sentBytes: counter(item.sentBytes), receivedBytes: counter(item.receivedBytes), sentReliableBytes: counter(item.sentReliableBytes), receivedReliableBytes: counter(item.receivedReliableBytes), sentLiveBytes: counter(item.sentLiveBytes), receivedLiveBytes: counter(item.receivedLiveBytes), sentRequests: counter(item.sentRequests), receivedRequests: counter(item.receivedRequests) });
      }
      rows = next; sampleLimited = nextSampleLimited; sampled = true; failure = null; emit();
    }, () => {
      if (!closed && !settled && version === atVersion) { failure = 'read_failed'; rows = []; sampled = false; emit(); }
    }).catch(() => {
      if (!closed && !settled) { failure = 'invalid_diagnostics'; rows = []; sampled = false; emit(); }
    }).finally(() => { finish(); physicalPending = false; if (refreshAfterPending && !closed) { refreshAfterPending = false; void refresh(); } });
    return result;
  }
  try {
    if (participation) {
      changed(participation.status);
      stopStatus = participation.onStatus?.(changed) ?? (() => {});
      if (closed) stopStatus();
    }
  } catch { failure = 'status_unavailable'; }
  signal?.addEventListener('abort', close, { once: true }); if (signal?.aborted) close();
  return Object.freeze({ status, refresh, close,
    onChange(listener) { if (closed) return () => {}; listeners.add(listener); notify(listener, status()); return () => listeners.delete(listener); },
  });
}

/** One explicit local sample, with its temporary observer always detached. */
export async function readTransportDiagnostics(participation, options) {
  const inspector = createTransportDiagnostics(participation, options);
  try { return await inspector.refresh(); } finally { inspector.close(); }
}
