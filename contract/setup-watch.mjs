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
        const response = await fetcher(api + '/self', { headers: { Authorization: 'Bearer ' + token }, redirect: 'error',
          signal: AbortSignal.any([lifetime, AbortSignal.timeout(5000)]) });
        if (response.status === 404) applicationMissing = (await response.json())?.error?.code === 'not_found';
        else await response.body?.cancel();
        if ([401, 403].includes(response.status)) { onStatus({ state: 'access_revoked' }); break; }
      } catch { /* network failure remains retryable */ }
      if (lifetime.aborted) break;
      const retryInMs = Math.min(60000, 1000 * 2 ** Math.min(failures++, 6));
      if (applicationMissing) onStatus({ state: 'application_not_found', retryInMs,
        next: 'Recreate the application in a new project directory: run npm run create and npm run init, publish, then restart with the new host handle. Keep the original private project, device storage and history for recovery.' });
      else onStatus({ state: 'reconnecting', retryInMs });
      await pause(retryInMs, lifetime);
    }
    onStatus({ state: 'closed', futureWakeVerified: false });
  })();
  return Object.freeze({ closed, close() { stop.abort(); return closed; } });
}
