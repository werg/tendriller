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

export async function proposeApplicationAssistant({ api, token, key, label, queries = [], commands = [], events = [], signal, fetcher = fetch }) {
  if (!keyFormat.test(key)) throw error('INVALID_ASSISTANT_KEY');
  socketUrl(api);
  const adapterHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))));
  const response = await fetcher(api + '/assistant/propose', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, adapterHash, queries, commands, events }), signal, redirect: 'manual',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw error(body?.error?.code ?? 'ASSISTANT_PROPOSAL_FAILED');
  }
  return response.json();
}

/** The existing participant executes approved native tools. The socket is inert when idle. */
export function connectApplicationAssistant({ api, key, session, tools, queries = [], commands = [], onStatus = () => {},
  openSocket = (url, protocols) => new WebSocket(url, protocols), signal }) {
  if (!keyFormat.test(key)) throw error('INVALID_ASSISTANT_KEY');
  const url = socketUrl(api), stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, session.signal, ...(signal ? [signal] : [])]);
  const allowed = { query: new Set(queries), command: new Set(commands) };
  const acknowledgements = new Map(), waitingForOpen = new Set();
  let socket, active = 0;
  function send(message) {
    const data = JSON.stringify(message, encodeValue);
    if (new TextEncoder().encode(data).byteLength > LIMIT) throw error('APPLICATION_ASSISTANT_FRAME_TOO_LARGE');
    if (socket?.readyState !== 1) throw error('APPLICATION_ASSISTANT_OFFLINE');
    socket.send(data);
  }
  async function onCall(message, transport, connection) {
    const { id, kind, name, input, operationId, basedOn, generation } = message;
    if (active >= 8) { send({ type: 'result', id, error: 'APPLICATION_ASSISTANT_BUSY' }); return; }
    active++;
    try {
      if (message.applicationId !== session.applicationId || !Object.hasOwn(allowed, kind) || !allowed[kind].has(name))
        throw error('APPLICATION_ASSISTANT_OPERATION_NOT_ALLOWED');
      if (generation !== session.status.generation) throw error('APPLICATION_ASSISTANT_GENERATION_CHANGED');
      const value = await tools.call(kind, { name, input, ...(kind === 'command' ? {
        operationId, ...(basedOn !== undefined ? { basedOn } : {}),
      } : {}) }, { signal: AbortSignal.any([connection, AbortSignal.timeout(4800)]) });
      if (generation !== session.status.generation) throw error('APPLICATION_ASSISTANT_GENERATION_CHANGED');
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
    while (!lifetime.aborted) {
      let transport, terminal = false, openedAt = 0;
      try {
        transport = openSocket(url, [PROTOCOL, key]);
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
          const timer = setTimeout(() => { if (transport.readyState !== 1) abort(); }, 7000);
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
            if (transport !== socket || typeof ev.data !== 'string' || ev.data.length > LIMIT) return;
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
      // Unapproved or misconfigured endpoints must not loop forever.
      if (openedAt && Date.now() - openedAt >= 10_000) failures = 0;
      if (++failures >= 6 && !connectedBefore) { onStatus({ state: 'disconnected', reason: 'retry_limit' }); break; }
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)) + Math.floor(Math.random() * 250);
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
    async publish({ sourceEventId, name, generation, payload }) {
      if (typeof generation !== 'string' || generation !== session.status.generation)
        throw error('APPLICATION_ASSISTANT_GENERATION_CHANGED');
      if (acknowledgements.size >= 16) throw error('APPLICATION_ASSISTANT_BACKLOG');
      const id = crypto.randomUUID();
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          acknowledgements.set(id, response => response.error ? reject(error(response.error)) : resolve(response.sequence));
          timer = setTimeout(() => reject(error('APPLICATION_ASSISTANT_ACK_TIMEOUT')), 5000);
          send({ type: 'event', id, sourceEventId, name, generation, payload });
        });
      } finally { clearTimeout(timer); acknowledgements.delete(id); }
    },
  };
}

/** Advance the native cursor only after the host retains each projected event. */
export async function forwardApplicationEvents({ session, assistant, topics, project, checkpoint, signal }) {
  const lifetime = AbortSignal.any([session.signal, ...(signal ? [signal] : [])]);
  let cursor = await checkpoint.load();
  for await (const change of session.changes({ signal: lifetime })) {
    if (change.kind === 'recovery' && cursor !== undefined)
      throw error('APPLICATION_ASSISTANT_REVIEW_RECOVERY');
    for (;;) {
      lifetime.throwIfAborted();
      const view = await session.readView();
      let batch;
      try { batch = await view.readEvents({ ...(cursor === undefined ? {} : { cursor }), topics, limit: 32 }); }
      finally { await view.release(); }
      for (const event of batch.events) {
        const projection = await project(event);
        if (projection) {
          const value = { ...projection, sourceEventId: event.id, generation: batch.revision.generation };
          for (let attempt = 0; ; attempt++) {
            await assistant.waitUntilOnline({ signal: lifetime });
            try { await assistant.publish(value); break; }
            catch (cause) {
              const retryable = ['APPLICATION_ASSISTANT_OFFLINE', 'APPLICATION_ASSISTANT_ACK_TIMEOUT', 'delivery_backlog_full', 'page_rate_limited', 'account_rate_limited'].includes(cause?.code);
              if (!retryable || attempt >= 5) throw cause;
              await delay(Math.min(8000, 500 * 2 ** attempt), lifetime);
            }
          }
        }
      }
      if (batch.cursor !== cursor) { await checkpoint.save(batch.cursor); cursor = batch.cursor; }
      if (!batch.hasMore) break;
    }
  }
}
