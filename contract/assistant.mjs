/** Wire validation only. Observations remain approved-exporter assertions, not signed finality proofs. */
const hexDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
export function assistantRevision(value) {
  if (!exact(value, ['digest', 'view', 'executionManifestDigest', 'policyDigest']) ||
      !hexDigest(value.digest) || !['local', 'final'].includes(value.view) || !hexDigest(value.executionManifestDigest) || !hexDigest(value.policyDigest))
    throw Object.assign(new Error('INVALID_PROJECTION_REVISION'), { code: 'INVALID_PROJECTION_REVISION' });
  return Object.freeze({ digest: value.digest, view: value.view, executionManifestDigest: value.executionManifestDigest, policyDigest: value.policyDigest });
}
export function assistantObservation(value) {
  const invalid = () => { throw Object.assign(new Error('INVALID_OPERATION_OBSERVATION'), { code: 'INVALID_OPERATION_OBSERVATION' }); };
  if (!exact(value, ['stored', 'materialized', 'retained', 'finalized', 'excluded']) || typeof value.stored !== 'boolean' ||
      typeof value.finalized !== 'boolean' || typeof value.excluded !== 'boolean' || !Array.isArray(value.retained) || value.retained.length > 32) invalid();
  if (value.materialized !== null && (!exact(value.materialized, ['outcome', 'revision']) || !['accepted', 'rejected'].includes(value.materialized.outcome))) invalid();
  if (value.finalized && (!value.materialized || value.excluded)) invalid();
  return { stored: value.stored, materialized: value.materialized === null ? null : { outcome: value.materialized.outcome, revision: assistantRevision(value.materialized.revision) },
    retained: structuredClone(value.retained), finalized: value.finalized, excluded: value.excluded };
}

const PROTOCOL = 'tendriller.application-mcp.v1';
const LIMIT = 64 * 1024;
const keyFormat = /^td_a_[a-f0-9]{64}$/u;
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const encodeValue = (_name, value) => {
  if (typeof value === 'bigint') return { format: 'decimal-integer', value: value.toString() };
  if (value instanceof Uint8Array) return { format: 'base64-bytes',
    value: btoa(Array.from(value, byte => String.fromCharCode(byte)).join('')) };
  return value;
};
const error = code => Object.assign(new Error(code), { code });
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});
const socketUrl = api => {
  const url = new URL(api + '/assistant/adapter');
  if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      /^\/api\/t\/[a-z2-7]{12}\/assistant\/adapter$/u.test(url.pathname)) url.protocol = 'wss:';
  else throw error('ASSISTANT_REQUIRES_HTTPS');
  return url.href;
};

export function createAssistantKey() {
  return 'td_a_' + hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Retain this proof before registration. Passing the same bindingId rotates
 * credentials without changing the independently approved agent identity. */
export function createApplicationAgentKey(bindingId = crypto.randomUUID()) {
  if (!/^[a-f0-9-]{36}$/u.test(bindingId)) throw error('INVALID_AGENT_BINDING_ID');
  return 'td_c_' + bindingId + '.' + hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function proposeApplicationAssistant({ api, token, key, backupKeys = [], label, queries = [], commands = [], events = [], signal, fetcher = fetch }) {
  const keys = [key, ...backupKeys];
  if (keys.length > 3 || keys.some(value => !keyFormat.test(value)) || new Set(keys).size !== keys.length)
    throw error('INVALID_ASSISTANT_KEY');
  socketUrl(api);
  const adapterHashes = await Promise.all(keys.map(async value =>
    hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))));
  const response = await fetcher(api + '/assistant/propose', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, adapterHashes, queries, commands, events }), signal, redirect: 'manual',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw error(body?.error?.code ?? 'ASSISTANT_PROPOSAL_FAILED');
  }
  return response.json();
}

/** The existing participant executes approved native tools. The socket is inert when idle. */
export function connectApplicationAssistant({ api, key, session, tools, onStatus = () => {},
  openSocket = (url, protocols) => new WebSocket(url, protocols), initialConnectTimeoutMs = 600_000, signal }) {
  if (!keyFormat.test(key)) throw error('INVALID_ASSISTANT_KEY');
  if (!Number.isSafeInteger(initialConnectTimeoutMs) || initialConnectTimeoutMs < 1000 || initialConnectTimeoutMs > 600_000)
    throw error('INVALID_ASSISTANT_STARTUP_TIMEOUT');
  if (typeof tools?.execute !== 'function' || typeof tools?.operationId !== 'function') throw error('INVALID_ASSISTANT_TOOLS');
  const deviceId = session.identity?.publicKey;
  if (!hexDigest(deviceId)) throw error('INVALID_ASSISTANT_DEVICE');
  const url = socketUrl(api), stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, session.signal, ...(signal ? [signal] : [])]);
  const acknowledgements = new Map(), waitingForOpen = new Set();
  let socket, active = 0;
  function send(message) {
    const data = JSON.stringify(message, encodeValue);
    if (new TextEncoder().encode(data).byteLength > LIMIT) throw error('APPLICATION_ASSISTANT_FRAME_TOO_LARGE');
    if (socket?.readyState !== 1) throw error('APPLICATION_ASSISTANT_OFFLINE');
    socket.send(data);
  }
  async function onCall(message, transport, connection) {
    const { id, kind, name, input, operationId, basedOn, fact, caller } = message;
    if (active >= 8) { send({ type: 'result', id, error: 'APPLICATION_ASSISTANT_BUSY' }); return; }
    active++;
    try {
      if (Object.keys(message).some(key => !['type', 'id', 'applicationId', 'kind', 'name', 'input', 'operationId', 'basedOn', 'fact', 'providerBindingId', 'connectionEpoch', 'caller'].includes(key))) throw error('APPLICATION_ASSISTANT_OPERATION_NOT_ALLOWED');
      const journal = ['inspect', 'retry', 'wait'].includes(kind), write = kind === 'command';
      if (message.applicationId !== session.applicationId || !(journal || write || kind === 'query'))
        throw error('APPLICATION_ASSISTANT_OPERATION_NOT_ALLOWED');
      if (!caller || typeof caller.agentBindingId !== 'string' || !caller.agentBindingId || !Number.isSafeInteger(caller.bindingRevision) ||
          !['approved-binding', 'oauth-client'].includes(caller.verification)) throw error('APPLICATION_ASSISTANT_CALLER_INVALID');
      const expectedOperationId = operationId ? await tools.operationId(operationId, { caller: caller.agentBindingId }) : undefined;
      const raw = await tools.execute({ kind, name, input, operationId, basedOn, fact,
      }, { signal: AbortSignal.any([connection, AbortSignal.timeout(4800)]),
        caller: caller.agentBindingId, callerContext: Object.freeze(structuredClone(caller)) });
      // Translate the canonical author into this host wire protocol's device field.
      // The scoped controller owns validation, actual IDs and signed-attempt evidence.
      let value = raw;
      if (raw?.operationReference && (write || journal)) {
        const { author, ...reference } = raw.operationReference;
        if (typeof author !== 'string' || !/^[a-f0-9]{64}$/u.test(author) ||
            author !== deviceId || reference.applicationId !== session.applicationId || !hexDigest(reference.proposalId) ||
            reference.operationId !== expectedOperationId || raw.state?.operationId !== expectedOperationId || raw.state?.proposalId !== reference.proposalId ||
            raw.state?.author !== author || raw.state?.applicationId !== session.applicationId)
          throw error('APPLICATION_ASSISTANT_REFERENCE_INVALID');
        value = { ...raw, requestOperationId: operationId, operationReference: { ...reference, deviceId: author } };
      }
      if (socket === transport) send({ type: 'result', id, value: value ?? null });
    } catch (cause) {
      if (socket === transport) {
        const code = typeof cause?.code === 'string' && /^[A-Za-z0-9_]{1,96}$/u.test(cause.code)
          ? cause.code : 'APPLICATION_ASSISTANT_OPERATION_FAILED';
        try { send({ type: 'result', id, error: code }); } catch { /* closed connection */ }
      }
    } finally { active--; }
  }
  async function run() {
    let failures = 0, connectedBefore = false;
    const startupDeadline = Date.now() + initialConnectTimeoutMs;
    while (!lifetime.aborted) {
      const remaining = connectedBefore ? Infinity : startupDeadline - Date.now();
      if (remaining <= 0) { onStatus({ state: 'disconnected', reason: 'startup_timeout' }); break; }
      let transport, terminal = false, openedAt = 0;
      try {
        transport = openSocket(url, [PROTOCOL, key, 'td_device_' + deviceId]);
        socket = transport;
        const connected = new AbortController();
        const code = await new Promise(resolve => {
          const done = code => {
            lifetime.removeEventListener('abort', abort);
            clearTimeout(timer);
            connected.abort();
            resolve(code);
          };
          const abort = () => { try { transport.close(); } finally { done(1000); } };
          const timer = setTimeout(() => { if (transport.readyState !== 1) abort(); }, Math.min(7000, remaining));
          lifetime.addEventListener('abort', abort, { once: true });
          transport.addEventListener('open', () => {
            clearTimeout(timer);
            connectedBefore = true;
            openedAt = Date.now();
            for (const resolve of waitingForOpen) resolve();
            onStatus({ state: 'connected' });
          }, { once: true });
          transport.addEventListener('close', ev => done(ev.code), { once: true });
          transport.addEventListener('message', ev => {
            if (transport !== socket || typeof ev.data !== 'string' || ev.data.length > LIMIT || new TextEncoder().encode(ev.data).byteLength > LIMIT) return;
            let message;
            try { message = JSON.parse(ev.data); } catch { return; }
            if (message.type === 'call') void onCall(message, transport, connected.signal);
            if (message.type === 'ack') acknowledgements.get(message.id)?.(message);
          });
          if (lifetime.aborted) abort();
        });
        terminal = code === 4000 || code === 4003;
        if (terminal) onStatus({ state: 'disconnected', reason: code === 4000 ? 'participant_replaced' : 'approval_changed' });
      } catch { /* failed initial dial */ }
      finally {
        socket = undefined;
        for (const resolve of acknowledgements.values()) resolve({ error: 'APPLICATION_ASSISTANT_OFFLINE' });
      }
      if (lifetime.aborted || terminal) break;
      // Give human sign-in/consent the same bounded window as browser pairing.
      // Once connected, idle sockets hibernate; revocation remains terminal.
      if (openedAt && Date.now() - openedAt >= 10_000) failures = 0;
      failures++;
      const backoff = Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)) + Math.floor(Math.random() * 250);
      const wait = connectedBefore ? backoff : Math.min(backoff, Math.max(0, startupDeadline - Date.now()));
      onStatus({ state: 'reconnecting', retryInMs: wait });
      await delay(wait, lifetime).catch(() => {});
    }
  }
  const closed = run();
  return {
    get online() { return socket?.readyState === 1; },
    closed,
    close() { stop.abort(); return closed; },
    async waitUntilOnline({ signal } = {}) {
      if (socket?.readyState === 1) return;
      const combined = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
      let opened, abort;
      try {
        combined.throwIfAborted();
        await Promise.race([closed.then(() => { throw error('APPLICATION_ASSISTANT_OFFLINE'); }),
          new Promise((resolve, reject) => {
            opened = resolve;
            abort = () => reject(combined.reason);
            waitingForOpen.add(opened);
            combined.addEventListener('abort', abort, { once: true });
          })]);
      } finally {
        if (opened) waitingForOpen.delete(opened);
        if (abort) combined.removeEventListener('abort', abort);
      }
    },
    async publish({ sourceEventId, proposalId, revision, observation, change = 'upsert', name, payload, context }) {
      if (!hexDigest(proposalId) || !['upsert', 'retract'].includes(change)) throw error('INVALID_ASSISTANT_EVENT');
      revision = assistantRevision(revision); observation = assistantObservation(observation);
      if (observation.materialized && observation.materialized.revision.digest !== revision.digest) throw error('INVALID_ASSISTANT_EVENT');
      if (acknowledgements.size >= 16) throw error('APPLICATION_ASSISTANT_BACKLOG');
      const id = crypto.randomUUID();
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          acknowledgements.set(id, response => response.error ? reject(error(response.error)) : resolve(response.sequence));
          timer = setTimeout(() => reject(error('APPLICATION_ASSISTANT_ACK_TIMEOUT')), 5000);
          send({ type: 'event', id, sourceEventId, proposalId, revision, observation, change, name, payload, ...(context ? { context } : {}) });
        });
      } finally { clearTimeout(timer); acknowledgements.delete(id); }
    },
  };
}

/** Host-specific acknowledgement/retry callback for Chronolog forwardSessionEvents. */
export function createAssistantEventDelivery({ assistant, onSkipped = () => {} }) {
  return async (projection, event, batch, signal) => {
    // Provisional delivery is revision-scoped. Consumers must replace/retract by stable event identity.
    const value = { ...projection, sourceEventId: event.id, proposalId: event.proposalId, revision: batch.revision,
      observation: projection.observation, change: projection.change ?? 'upsert' };
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      await assistant.waitUntilOnline({ signal });
      signal.throwIfAborted();
      try { await assistant.publish(value); return; }
      catch (cause) {
        signal.throwIfAborted();
        if (cause?.code === 'event_not_approved') {
          onSkipped({ name: value.name, sourceEventId: value.sourceEventId });
          return;
        }
        const retryable = ['APPLICATION_ASSISTANT_OFFLINE', 'APPLICATION_ASSISTANT_ACK_TIMEOUT', 'delivery_backlog_full', 'application_event_unavailable', 'page_rate_limited', 'account_rate_limited'].includes(cause?.code);
        if (!retryable || attempt >= 5) throw cause;
        await delay(Math.min(8000, 500 * 2 ** attempt), signal);
      }
    }
  };
}
