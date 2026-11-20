// Chromium can complete a SharedWorker's main script only on its worker CDP target,
// leaving Playwright's creator-side request without a response/finished event.
// Observe that exact target's main loadingFinished and an executable worker reply.
// This is a boundary-only observer: detach before residency/quiet measurement.
export async function observeWorkerBootstraps(endpoint, complete, { Socket = WebSocket, timeoutMs = 10000 } = {}) {
  const socket = new Socket(endpoint), commands = new Map(), workers = new Map(), tasks = [];
  let sequence = 0, stopped = false;
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (stopped && method !== 'Target.setAutoAttach') { reject(Error('WORKER_BOOTSTRAP_CDP_CLOSED')); return; }
    const id = ++sequence, timer = setTimeout(() => { commands.delete(id); reject(Error('WORKER_BOOTSTRAP_CDP_DEADLINE')); }, timeoutMs);
    commands.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const message = async ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const pending = commands.get(m.id);
      if (pending) { commands.delete(m.id); clearTimeout(pending.timer); m.error ? pending.reject(Error('WORKER_BOOTSTRAP_CDP_FAILED')) : pending.resolve(m.result); }
      return;
    }
    if (m.method === 'Network.loadingFinished') {
      const worker = workers.get(m.sessionId);
      if (worker && m.params.requestId === worker.targetId) worker.loaded();
    }
    if (m.method !== 'Target.attachedToTarget' || m.params.targetInfo.type !== 'shared_worker') return;
    const { sessionId, targetInfo, waitingForDebugger } = m.params;
    if (!waitingForDebugger || !targetInfo.targetId || !targetInfo.url) return;
    const loaded = Promise.withResolvers(); loaded.promise.catch(() => {});
    workers.set(sessionId, { targetId: targetInfo.targetId, loaded: loaded.resolve, cancel: loaded.reject });
    const task = (async () => {
      try {
        await command('Network.enable', {}, sessionId);
        await command('Runtime.enable', {}, sessionId);
        await command('Runtime.runIfWaitingForDebugger', {}, sessionId);
        const reply = await command('Runtime.evaluate', { expression: '({ready:true,url:self.location.href})', returnByValue: true }, sessionId);
        if (reply.result?.value?.ready !== true || reply.result.value.url !== targetInfo.url) throw Error('WORKER_BOOTSTRAP_IDENTITY_MISMATCH');
        let timer;
        try { await Promise.race([loaded.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('WORKER_BOOTSTRAP_NETWORK_DEADLINE')), timeoutMs); })]); }
        finally { clearTimeout(timer); }
        if (!stopped) complete(targetInfo.url);
      } finally { await command('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {}); }
    })();
    tasks.push(task); task.catch(() => {});
  };
  socket.addEventListener('message', message);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('WORKER_BOOTSTRAP_CDP_OPEN_DEADLINE')), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('WORKER_BOOTSTRAP_CDP_OPEN_FAILED')); }, { once: true });
    });
    await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'shared_worker', exclude: false }, { exclude: true }] });
  } catch (error) { stopped = true; socket.close(); throw error; }
  return {
    async finish() { await Promise.all(tasks); },
    async close() {
      stopped = true;
      for (const worker of workers.values()) worker.cancel(Error('WORKER_BOOTSTRAP_CDP_CLOSED'));
      try { await command('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }); }
      finally {
        socket.removeEventListener('message', message); socket.close();
        for (const pending of commands.values()) { clearTimeout(pending.timer); pending.reject(Error('WORKER_BOOTSTRAP_CDP_CLOSED')); }
        commands.clear(); await Promise.allSettled(tasks);
      }
    },
  };
}
