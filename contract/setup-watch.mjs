export const SETUP_WATCH_PROTOCOL = 'tendriller.setup.v1';
const fail = code => Object.assign(Error(code), { code });
export function validateSetupNotice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'setup' || value.version !== 1)
    throw fail('INVALID_SETUP_NOTICE');
  const keys = Object.keys(value).sort().join();
  const hex = /^[a-f0-9]{64}$/;
  const validAssistant = a => Boolean(a && typeof a === 'object' && !Array.isArray(a)
    && Object.keys(a).sort().join() === 'approved,proposalId,revision'
    && typeof a.approved === 'boolean'
    && (a.proposalId === null || (typeof a.proposalId === 'string' && hex.test(a.proposalId)))
    && (a.revision === null || (typeof a.revision === 'string' && a.revision.length > 0 && a.revision.length <= 80))
    && a.approved === (a.revision !== null) && (!a.approved || a.proposalId !== null));
  const validMcp = m => Boolean(m && typeof m === 'object' && !Array.isArray(m)
    && Object.keys(m).sort().join() === 'connected,grants,updatedAt'
    && typeof m.connected === 'boolean'
    && Array.isArray(m.grants) && m.grants.length <= 64
    && m.grants.every(g => typeof g === 'string' && g.length > 0 && g.length <= 128)
    && m.connected === (m.grants.length > 0)
    && Number.isSafeInteger(m.updatedAt) && m.updatedAt >= 0);
  if (keys === 'assistant,type,version') {
    if (!validAssistant(value.assistant)) throw fail('INVALID_SETUP_NOTICE');
    return value;
  }
  if (keys === 'mcp,type,version') {
    if (!validMcp(value.mcp)) throw fail('INVALID_SETUP_NOTICE');
    return value;
  }
  if (keys === 'assistant,mcp,type,version') {
    if (!validAssistant(value.assistant) || !validMcp(value.mcp)) throw fail('INVALID_SETUP_NOTICE');
    return value;
  }
  throw fail('INVALID_SETUP_NOTICE');
}
const pause = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done();
});

/** Notifications wake the running native process, never imply a future model turn. */
export function watchApplicationSetup({ page, signal, onChange, onStatus = () => {},
  openSocket = (path, protocols) => page.socket(path, protocols) }) {
  if (!page || typeof page.request !== 'function' || typeof openSocket !== 'function' || typeof onChange !== 'function')
    throw fail('INVALID_SETUP_WATCH');
  const stop = new AbortController(), lifetime = AbortSignal.any([stop.signal, ...[signal].filter(Boolean)]);
  let socket, failures = 0;
  const closed = (async () => {
    while (!lifetime.aborted) {
      let terminal = false;
      try {
        const transport = socket = openSocket('setup/watch', [SETUP_WATCH_PROTOCOL]);
        await new Promise(resolve => {
          let timer, ended = false;
          const done = code => {
            if (ended) return;
            ended = true; clearTimeout(timer); lifetime.removeEventListener('abort', abort);
            for (const [type, listener] of listeners) transport.removeEventListener(type, listener);
            terminal = code === 4003 || code === 1008; resolve();
          };
          const close = (code = 1000, reason) => {
            done(code);
            // A client cannot send the semantic 1008/1011 close codes. Settle
            // locally first so even a synchronous close event preserves them.
            try { if (transport.readyState < 2) transport.close(1000, reason); }
            catch { /* Completion and cleanup must survive a failed close. */ }
          };
          const abort = () => close();
          const disconnected = event => done(event.code);
          const opened = () => { clearTimeout(timer); onStatus({ state: 'connected', futureWakeVerified: false }); };
          const errored = () => close(1011, 'Setup transport failed');
          const message = event => {
            if (lifetime.aborted || socket !== transport) return;
            try {
              if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > 1024) throw fail('INVALID_SETUP_NOTICE');
              const notice = validateSetupNotice(JSON.parse(event.data)); failures = 0;
              Promise.resolve(onChange(notice)).catch(() => onStatus({ state: 'handler_failed' }));
            } catch { close(1008, 'Invalid setup notice'); }
          };
          const listeners = [['close', disconnected], ['open', opened], ['error', errored], ['message', message]];
          timer = setTimeout(abort, 7000);
          lifetime.addEventListener('abort', abort, { once: true });
          for (const [type, listener] of listeners) transport.addEventListener(type, listener);
          if (lifetime.aborted) abort();
        });
      } catch { /* bounded reconnect backoff for transport outages */ }
      finally { socket = undefined; }
      if (lifetime.aborted || terminal) break;
      // WebSocket upgrade errors hide HTTP status. Diagnose failed sockets,
      // never poll a healthy idle one. A missing host application cannot be
      // repaired by restoring its credential, and must remain visibly retrying.
      let applicationMissing = false;
      try {
        await page.request('', { signal: AbortSignal.any([lifetime, AbortSignal.timeout(5000)]) });
      } catch (error) {
        if (error?.status === 404) applicationMissing = error.code === 'not_found';
        if ([401, 403].includes(error?.status)) { onStatus({ state: 'access_revoked' }); break; }
        /* network failure remains retryable */
      }
      if (lifetime.aborted) break;
      const retryInMs = Math.min(60000, 1000 * 2 ** Math.min(failures++, 6));
      if (applicationMissing) onStatus({ state: 'application_not_found', retryInMs,
        next: 'The page was deleted or its grant removed. Create a replacement with tendril page new <slug> in the same workspace; keep this page\'s private folder and device storage for recovery.' });
      else onStatus({ state: 'reconnecting', retryInMs });
      await pause(retryInMs, lifetime);
    }
    onStatus({ state: 'closed', futureWakeVerified: false });
  })();
  return Object.freeze({ closed, close() { stop.abort(); return closed; } });
}
