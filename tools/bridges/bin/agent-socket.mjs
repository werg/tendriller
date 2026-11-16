// Receive count-only wakes over a hibernating Durable Object WebSocket.
// Browser code never sees this socket or the private agent token.
export function waitForAgentWake(cfg, onWake, onTick, signal) {
  const url = new URL(cfg.api + '/events/socket');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (typeof WebSocket !== 'function') throw Error('Agent sockets need Node.js 22.15 or newer');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['tendriller.agent.v2', cfg.token]);
    let opened = false, done = false, lastPong = Date.now(), timer = null, tickTimer = null;
    let work = Promise.resolve();
    const finish = (error) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearInterval(tickTimer);
      signal?.removeEventListener('abort', onAbort);
      try { ws.close(); } catch {}
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish();
    if (signal?.aborted) { finish(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    const enqueue = (fn) => { work = work.then(fn).catch(finish); };
    ws.addEventListener('open', () => {
      opened = true;
      if (ws.protocol !== 'tendriller.agent.v2') { finish(Error('Agent socket protocol was not accepted')); return; }
      enqueue(onWake); // replay events that arrived during a disconnect
      timer = setInterval(() => {
        if (Date.now() - lastPong > 150000) { finish(Error('Agent socket heartbeat timed out')); return; }
        try { ws.send('{"t":"ping"}'); } catch (e) { finish(e); return; }
      }, 60000);
      if (onTick) tickTimer = setInterval(() => enqueue(onTick), 1000);
    });
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.t === 'pong') lastPong = Date.now();
      else if (message.t === 'wake') enqueue(onWake);
    });
    ws.addEventListener('error', () => finish(Error('Agent socket connection failed')));
    ws.addEventListener('close', (event) => finish(Error(opened ? `Agent socket closed (${event.code})` : 'Agent socket was rejected')));
  });
}
