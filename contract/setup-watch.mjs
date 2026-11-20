export const SETUP_WATCH_PROTOCOL = 'tendriller.setup.v1';
const fail = code => Object.assign(Error(code), { code });
export function validateSetupNotice(value) {
  const a = value?.assistant, hex = /^[a-f0-9]{64}$/;
  if (!value || value.type !== 'setup' || value.version !== 1 || Object.keys(value).sort().join() !== 'assistant,type,version' ||
      !a || Object.keys(a).sort().join() !== 'approved,proposalId,revision' || typeof a.approved !== 'boolean' ||
      a.proposalId !== null && (typeof a.proposalId !== 'string' || !hex.test(a.proposalId)) ||
      a.revision !== null && (typeof a.revision !== 'string' || a.revision.length > 80 || !a.revision.length) ||
      a.approved !== (a.revision !== null) || a.approved && a.proposalId === null) throw fail('INVALID_SETUP_NOTICE');
  return value;
}
const pause = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done();
});

/** Notifications wake the running native process, never imply a future model turn. */
export function watchApplicationSetup({ api, token, signal, onChange, onStatus = () => {},
  openSocket = (url, protocols) => new WebSocket(url, protocols), fetcher = fetch }) {
  const url = new URL(api + '/setup/watch');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !/^\/api\/t\/[a-z2-7]{12}\/setup\/watch$/.test(url.pathname) || !/^tk_[a-z2-7]{32}$/.test(token) || typeof onChange !== 'function')
    throw fail('INVALID_SETUP_WATCH');
  url.protocol = 'wss:';
  const stop = new AbortController(), lifetime = AbortSignal.any([stop.signal, ...[signal].filter(Boolean)]);
  let socket, failures = 0;
  const closed = (async () => {
    while (!lifetime.aborted) {
      let terminal = false;
      try {
        const transport = socket = openSocket(url.href, [SETUP_WATCH_PROTOCOL, token]);
        await new Promise(resolve => {
          let timer;
          const done = code => { clearTimeout(timer); lifetime.removeEventListener('abort', abort); terminal = code === 4003 || code === 1008;
            resolve(); };
          const abort = () => { try { transport.close(); } finally { done(1000); } };
          timer = setTimeout(abort, 7000);
          lifetime.addEventListener('abort', abort, { once: true });
          transport.addEventListener('close', event => done(event.code), { once: true });
          transport.addEventListener('open', () => { clearTimeout(timer); onStatus({ state: 'connected', futureWakeVerified: false }); }, { once: true });
          transport.addEventListener('message', event => {
            if (lifetime.aborted || socket !== transport) return;
            try {
              if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > 1024) throw fail('INVALID_SETUP_NOTICE');
              const notice = validateSetupNotice(JSON.parse(event.data)); failures = 0;
              Promise.resolve(onChange(notice)).catch(() => onStatus({ state: 'handler_failed' }));
            } catch { terminal = true; transport.close(1008, 'Invalid setup notice'); }
          });
          if (lifetime.aborted) abort();
        });
      } catch { /* bounded reconnect backoff for transport outages */ }
      finally { socket = undefined; }
      if (lifetime.aborted || terminal) break;
      // WebSocket upgrade errors hide HTTP status. Classify definitive revoked
      // credentials only after failure, never by polling a healthy idle socket.
      try {
        const response = await fetcher(api + '/self', { headers: { Authorization: 'Bearer ' + token }, redirect: 'error',
          signal: AbortSignal.any([lifetime, AbortSignal.timeout(5000)]) });
        await response.body?.cancel();
        if ([401, 403, 404].includes(response.status)) { onStatus({ state: 'access_revoked' }); break; }
      } catch { /* network failure remains retryable */ }
      if (lifetime.aborted) break;
      const retryInMs = Math.min(60000, 1000 * 2 ** Math.min(failures++, 6));
      onStatus({ state: 'reconnecting', retryInMs }); await pause(retryInMs, lifetime);
    }
    onStatus({ state: 'closed', futureWakeVerified: false });
  })();
  return Object.freeze({ closed, close() { stop.abort(); return closed; } });
}
