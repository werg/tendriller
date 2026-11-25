/** Own one application lifetime. Optional integration failures never close its signing store. */
export function superviseParticipant({ owned, signal, watch, startAdapter, prepareAdapter, proposalId, onOnline, report = () => {},
  retryMs = 1000, maxRetryMs = 60000 }) {
  const stop = new AbortController(), lifetime = AbortSignal.any([owned.session.signal, stop.signal, signal].filter(Boolean));
  let notice, setupFailure, adapter, adapterAbort, waitingConsentFor;
  let adapterTask, adapterKey, blockedKey;
  let optionalTimer, optionalFailures = 0, preparing, optionalStopped = false;
  const optionalStop = new AbortController(), optionalLifetime = AbortSignal.any([lifetime, optionalStop.signal]);
  const tasks = new Set();
  const track = task => { tasks.add(task); task.finally(() => tasks.delete(task)).catch(() => {}); return task; };
  const safeCode = error => /^[A-Za-z0-9_]{1,96}$/.test(error?.code ?? '') ? error.code : 'participant_component_unavailable';
  function stopAdapter() {
    const previous = adapter; adapter = undefined;
    adapterAbort?.abort(); adapterAbort = undefined;
    return previous ? Promise.resolve().then(() => previous.close()).catch(error => report({ state: 'adapter_cleanup_failed', code: safeCode(error) })) : Promise.resolve();
  }
  const terminal = error => ['forbidden', 'unauthorized', 'agent_binding_revoked', 'access_revoked'].includes(error?.code);
  function stopOptional(reason) {
    if (optionalStopped) return;
    optionalStopped = true; optionalStop.abort(); clearTimeout(optionalTimer); optionalTimer = undefined;
    track(stopAdapter());
    report({ state: 'assistant_stopped', reason, participantRunning: true });
  }
  function retryOptional() {
    if (optionalLifetime.aborted || optionalTimer) return;
    const ms = Math.min(maxRetryMs, retryMs * 2 ** Math.min(optionalFailures++, 6));
    report({ state: 'assistant_retry', retryInMs: ms, participantRunning: true });
    optionalTimer = setTimeout(() => { optionalTimer = undefined; if (proposalId) updateAdapter(); else prepare(); }, ms);
  }
  // A cancelled optional request cannot retain ownership of native shutdown,
  // even when an injected provider ignores its abort signal. Late results are fenced.
  function cancellable(task, signal = optionalLifetime) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  function prepare() {
    if (!prepareAdapter || preparing || proposalId || optionalLifetime.aborted || optionalTimer) return;
    preparing = track((async () => {
      try {
        const id = await cancellable(Promise.resolve().then(() => {
          optionalLifetime.throwIfAborted(); return prepareAdapter({ signal: optionalLifetime });
        }));
        optionalLifetime.throwIfAborted();
        if (typeof id !== 'string' || !id) throw Error('A prepared assistant proposal ID is required.');
        proposalId = id; optionalFailures = 0; updateAdapter();
      } catch (error) {
        if (optionalLifetime.aborted) return;
        report({ state: 'assistant_preparation_failed', code: safeCode(error), participantRunning: true });
        if (terminal(error)) stopOptional(safeCode(error)); else retryOptional();
      }
    })());
    preparing.finally(() => { preparing = undefined; }).catch(() => {});
  }
  const approvedKey = () => notice?.assistant?.approved && notice.assistant.proposalId === proposalId && proposalId
    ? `${proposalId}/${notice.assistant.revision}` : undefined;
  function updateAdapter() {
    if (optionalLifetime.aborted) return;
    const key = approvedKey();
    if (key) waitingConsentFor = undefined;
    if (!startAdapter || !key || blockedKey === key) {
      // Abort a start in flight as well as an online adapter on revocation.
      if (adapter || adapterAbort) track(stopAdapter());
      if (startAdapter && !key && waitingConsentFor !== (proposalId ?? null)) { waitingConsentFor = proposalId ?? null; report({ state: 'awaiting_assistant_consent', participantRunning: true }); }
      return;
    }
    if (adapterTask) {
      if (adapterKey !== key) track(stopAdapter());
      return;
    }
    if (optionalTimer) return;
    adapterKey = key;
    adapterTask = track((async () => {
      await stopAdapter();
      if (optionalLifetime.aborted || approvedKey() !== key || blockedKey === key) return;
      const controller = adapterAbort = new AbortController(), componentSignal = AbortSignal.any([controller.signal, optionalLifetime]);
      let current;
      try {
        current = adapter = startAdapter({ signal: componentSignal, onStatus: status => {
          if (componentSignal.aborted || approvedKey() !== key) return;
          report({ assistant: status, participantRunning: true });
          if (['approval_changed', 'participant_replaced'].includes(status.reason)) {
            blockedKey = key; track(stopAdapter());
          }
          if (status.reason === 'access_revoked') stopOptional('access_revoked');
        } });
        const closed = Promise.resolve(current.closed).finally(() => controller.abort());
        closed.catch(() => {}); // Observe transport failure even while online startup is pending.
        await cancellable(current.waitUntilOnline({ signal: componentSignal }), componentSignal);
        componentSignal.throwIfAborted();
        if (approvedKey() !== key || blockedKey === key) return;
        report({ state: 'adapter_online', participantRunning: true, roundTripVerified: false, futureWakeVerified: false });
        // Optional activity has its own failure boundary. A cursor/review error
        // cannot turn a healthy provider into a transport retry or idle heartbeat.
        if (onOnline) void Promise.resolve().then(() => {
          componentSignal.throwIfAborted();
          return onOnline(current, componentSignal);
        }).catch(() => {
          if (componentSignal.aborted || approvedKey() !== key || blockedKey === key) return;
          report({ state: 'adapter_activity_failed', code: 'adapter_activity_failed', participantRunning: true });
        });
        await cancellable(closed, componentSignal);
      } catch (error) {
        if (!optionalLifetime.aborted && !controller.signal.aborted) {
          report({ state: 'adapter_offline', code: safeCode(error), participantRunning: true });
          if (terminal(error)) stopOptional(safeCode(error));
        }
      } finally {
        if (adapter === current) await stopAdapter();
      }
    })());
    adapterTask.finally(() => {
      adapterTask = undefined;
      if (optionalLifetime.aborted || !approvedKey() || approvedKey() === blockedKey) return;
      if (approvedKey() !== key) updateAdapter(); else retryOptional();
    }).catch(() => {});
  }
  function reconcile(value) {
    if (lifetime.aborted) return;
    if (value) notice = value;
    updateAdapter();
  }
  let channel;
  try { channel = watch({ signal: lifetime, onChange: reconcile, onStatus: status => {
    if (['access_revoked', 'application_not_found'].includes(status.state)) setupFailure = status;
    else if (status.state === 'connected') setupFailure = undefined;
    report({ setup: status, participantRunning: true });
    if (status.state === 'access_revoked') stopOptional('access_revoked');
  } }); } catch (error) { stopOptional(safeCode(error)); report({ state: 'optional_setup_unavailable', code: safeCode(error), participantRunning: true }); }
  if (channel) track(Promise.resolve(channel.closed).then(() => {
    if (!lifetime.aborted) {
      stopOptional('setup_channel_closed');
      report({ state: 'setup_channel_closed', participantRunning: true, reason: setupFailure?.state,
        next: setupFailure?.next ?? (setupFailure?.state === 'access_revoked'
          ? 'Restore this retained host credential and reconnect; the application remains running.'
          : 'Reconnect the setup channel and inspect its preceding status if it remains unavailable; the local application remains running.') });
    }
  }));
  prepare();
  const done = (async () => {
    if (!lifetime.aborted) await new Promise(resolve => lifetime.addEventListener('abort', resolve, { once: true }));
    clearTimeout(optionalTimer);
    await channel?.close(); await stopAdapter();
    await Promise.allSettled([...tasks]);
  })();
  return Object.freeze({ done, reconcile, close() { stop.abort(); return done; } });
}
