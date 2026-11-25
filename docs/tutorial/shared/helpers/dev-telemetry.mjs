// Ephemeral page-to-agent error & health telemetry over authenticated live signals.
// Writes zero durable Chronolog records: diagnostics stream live when connected
// (inspectable via `tendril --mode attach logs`) and drop cleanly when offline.

const DEFAULT_TOPIC = 'dev/telemetry';
const DEFAULT_MAX_PER_MINUTE = 30;
const MAX_MESSAGE = 600;

function redact(text, limit = MAX_MESSAGE) {
  const value = String(text ?? '')
    .replace(/([?&](?:token|code|secret|key|auth|session|sig|password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]');
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

function pageMeta(runtime) {
  const identity = runtime?.identity ?? null;
  const viewport = typeof window !== 'undefined'
    ? { width: window.innerWidth, height: window.innerHeight }
    : null;
  return {
    page: identity?.page ?? null,
    version: identity?.version ?? null,
    publication: identity?.publication ?? null,
    documentPath: identity?.documentPath ?? null,
    viewport,
  };
}

/**
 * Browser side: streams boot/runtime errors, optional console.error calls, and
 * transport/connectivity transitions over ephemeral live signals.
 */
export function mountDevTelemetry({
  session,
  runtime = typeof window !== 'undefined' ? window.tendril : null,
  topic = DEFAULT_TOPIC,
  captureConsoleError = true,
  maxPerMinute = DEFAULT_MAX_PER_MINUTE,
} = {}) {
  if (!session?.signals) throw new TypeError('mountDevTelemetry requires a session with signals');

  let closed = false;
  const sentIds = new Set();
  const pendingIds = new Set();
  const windowStamps = [];
  let lastLinkKey = '';

  const allowSend = () => {
    const now = Date.now();
    while (windowStamps.length && now - windowStamps[0] > 60_000) windowStamps.shift();
    if (windowStamps.length >= maxPerMinute) return false;
    windowStamps.push(now);
    return true;
  };

  const connected = () => {
    const peers = session.participation?.status?.connectedPeers;
    return Array.isArray(peers) ? peers.length > 0 : true;
  };

  const emit = async payload => {
    if (closed || !connected() || !allowSend()) return false;
    try {
      await session.signals.send(topic, {
        ...payload,
        ...pageMeta(runtime),
        at: payload.at ?? Date.now(),
      }, { ttlMs: 30_000 });
      return true;
    } catch { return false; /* Diagnostics must never throw into application code. */ }
  };

  const emitErrorEntry = entry => {
    if (!entry || sentIds.has(entry.id) || pendingIds.has(entry.id)) return;
    pendingIds.add(entry.id);
    void emit({ kind: 'error', entry }).then(sent => {
      pendingIds.delete(entry.id);
      if (!sent) return; // Keep offline, rate-limited and failed sends eligible for the next flush.
      sentIds.add(entry.id);
      if (sentIds.size > 200) sentIds.delete(sentIds.values().next().value);
    });
  };

  const flushBuffered = () => {
    const entries = runtime?.errors?.list?.() ?? [];
    for (const entry of entries) emitErrorEntry(entry);
  };

  const sendSnapshot = () => {
    const status = session.participation?.status ?? null;
    const links = status?.links ?? null;
    emit({
      kind: 'health',
      connectedPeers: status?.connectedPeers ?? [],
      state: status?.state ?? null,
      links,
      errorCount: (runtime?.errors?.list?.() ?? []).length,
    });
  };

  const offErrors = runtime?.errors?.on?.(entry => emitErrorEntry(entry)) ?? (() => {});
  const offParticipation = session.participation?.onStatus?.(status => {
    const peers = [...(status?.connectedPeers ?? [])].sort();
    const linkKey = JSON.stringify([status?.state ?? null, peers]);
    if (peers.length > 0) flushBuffered();
    if (linkKey !== lastLinkKey) {
      lastLinkKey = linkKey;
      if (peers.length > 0) sendSnapshot();
    }
  }) ?? (() => {});

  let restoreConsole = null;
  if (captureConsoleError && typeof console !== 'undefined' && typeof console.error === 'function') {
    const original = console.error;
    console.error = (...args) => {
      original.apply(console, args);
      const message = redact(args.map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'string') return arg;
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }).join(' '));
      emit({ kind: 'console_error', message, at: Date.now() });
    };
    restoreConsole = () => { console.error = original; };
  }

  if (connected()) {
    flushBuffered();
    sendSnapshot();
  }

  return Object.freeze({
    sendSnapshot,
    close() {
      if (closed) return;
      closed = true;
      offErrors();
      offParticipation();
      restoreConsole?.();
    },
  });
}

/**
 * Native side: subscribes to browser dev telemetry signals and keeps a bounded
 * in-memory ring buffer + per-device health map (zero durable writes).
 */
export function collectDevTelemetry(session, {
  topic = DEFAULT_TOPIC,
  maxEntries = 100,
  onEvent,
  signal,
} = {}) {
  if (!session?.signals) throw new TypeError('collectDevTelemetry requires a session with signals');
  const stop = new AbortController();
  const lifetime = signal ? AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean))
    : AbortSignal.any([stop.signal, session.signal].filter(Boolean));
  const buffer = [];
  const byDevice = new Map();

  const task = (async () => {
    try {
      for await (const frame of session.signals.subscribe({ topics: [topic], mode: 'all', signal: lifetime })) {
        const record = {
          authorId: frame.authorId,
          receivedAt: Date.now(),
          topic: frame.topic,
          payload: frame.payload,
        };
        if (frame.payload?.kind === 'health') {
          byDevice.set(frame.authorId, record);
        }
        buffer.push(record);
        if (buffer.length > maxEntries) buffer.splice(0, buffer.length - maxEntries);
        try { onEvent?.(record); } catch { /* Callback errors must not abort telemetry loop. */ }
      }
    } catch {
      /* Shutdown / abort ends telemetry collection cleanly. */
    }
  })();

  return Object.freeze({
    entries: () => buffer.slice(),
    health: () => Object.fromEntries(byDevice.entries()),
    done: task,
    close() { stop.abort(); },
  });
}
