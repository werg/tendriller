/** Page-origin metadata only, shared by holding pages and published-page utilities. */
export function watchPublicationUpdates({ base, onCurrent, onAgents = () => {}, onMcpSync = () => {}, onStatus = () => {}, signal }) {
  const protocol = 'tendriller.publication.v1';
  const endpoint = new URL('_tendril/publication-ready', base);
  if (endpoint.origin !== location.origin || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw Error('INVALID_PUBLICATION_WATCH');
  let socket, timer, probe, stopped = false, paused = false, recovering = false, epoch = 0, failures = 0;
  function notify(value) {
    if (!value || typeof value !== 'object') throw Error('INVALID_PUBLICATION_NOTICE');
    if (value.type === 'agents' && value.version === 1 && Array.isArray(value.agents)) {
      onAgents(value);
      return;
    }
    if (value.type === 'mcp-sync' && value.version === 1 && Object.keys(value).length === 2) {
      onMcpSync(value);
      return;
    }
    if (Object.keys(value).sort().join() !== 'current,type,version' || value.type !== 'publication' || value.version !== 1 ||
        !Number.isSafeInteger(value.current) || value.current < 0) throw Error('INVALID_PUBLICATION_NOTICE');
    onCurrent(value);
  }
  function stopTransport() {
    epoch++; clearTimeout(timer); timer = undefined; probe?.abort(); probe = undefined; recovering = false;
    const previous = socket; socket = undefined;
    try { previous?.close(); } catch { /* already closed */ }
  }
  function close() {
    if (stopped) return;
    stopped = true; stopTransport();
    window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
    window.removeEventListener('offline', offline); window.removeEventListener('online', connect);
    signal?.removeEventListener('abort', close);
  }
  async function recover(attempt, code) {
    if (stopped || paused || attempt !== epoch || recovering) return;
    recovering = true; clearTimeout(timer);
    const previous = socket; socket = undefined;
    try { previous?.close(); } catch { /* already closed */ }
    if ([1008, 4001, 4003].includes(code)) { close(); onStatus({ state: 'access_ended' }); return; }
    onStatus({ state: 'reconnecting' });
    const controller = probe = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      // One observation after failure, never a healthy polling or heartbeat lease.
      const response = await fetch(endpoint, { method: 'HEAD', cache: 'no-store', redirect: 'manual', signal: controller.signal });
      if (stopped || paused || attempt !== epoch) return;
      if ([401, 403, 404].includes(response.status) || response.type === 'opaqueredirect') { close(); onStatus({ state: 'access_ended' }); return; }
      const header = response.headers.get('Tendril-Publication-Version');
      if ([202, 204].includes(response.status) && header !== null && /^(0|[1-9][0-9]*)$/.test(header))
        notify({ type: 'publication', version: 1, current: Number(header) });
    } catch { /* The bounded reconnect reconciles state missed during network failure. */ }
    finally { clearTimeout(timeout); if (probe === controller) probe = undefined; }
    if (stopped || paused || attempt !== epoch) return;
    recovering = false;
    if (navigator.onLine) {
      const retryInMs = Math.min(15000, 1000 * 2 ** Math.min(failures++, 4));
      onStatus({ state: 'reconnecting', retryInMs });
      timer = setTimeout(connect, retryInMs);
    }
  }
  function connect() {
    if (stopped || paused || !navigator.onLine || socket || recovering) return;
    clearTimeout(timer);
    const attempt = ++epoch, url = new URL(endpoint);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      const stream = socket = new WebSocket(url, [protocol]);
      // Only a dial/initial-snapshot deadline. A healthy subscription owns no timer.
      timer = setTimeout(() => { void recover(attempt); }, 8000);
      stream.onmessage = event => {
        if (stopped || paused || socket !== stream || attempt !== epoch || recovering) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 16384) throw Error('INVALID_PUBLICATION_NOTICE');
          notify(JSON.parse(event.data)); clearTimeout(timer); timer = undefined; failures = 0;
          onStatus({ state: 'connected' });
        } catch { close(); onStatus({ state: 'protocol_error' }); }
      };
      stream.onclose = event => { if (socket === stream) void recover(attempt, event.code); };
      stream.onerror = () => { if (socket === stream) void recover(attempt); };
    } catch { void recover(attempt); }
  }
  function hide() { paused = true; stopTransport(); }
  function show() { if (!stopped) { paused = false; connect(); } }
  function offline() { stopTransport(); }
  window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
  window.addEventListener('offline', offline); window.addEventListener('online', connect);
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close(); else connect();
  return Object.freeze({ close });
}
