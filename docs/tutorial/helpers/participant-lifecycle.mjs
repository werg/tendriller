/** Own one application lifetime. Optional integration failures never close its signing store. */
export function superviseParticipant({ owned, signal, watch, startAdapter, proposalId, onOnline, report = () => {},
  retryMs = 1000, maxRetryMs = 60000 }) {
  const stop = new AbortController(), lifetime = AbortSignal.any([owned.session.signal, stop.signal, signal].filter(Boolean));
  let notice, dirty = false, processing, adapter, adapterAbort, adapterRevision, blockedRevision;
  let expiryTimer, retryTimer, failures = 0, adapterTask;
  const tasks = new Set();
  const track = task => { tasks.add(task); task.finally(() => tasks.delete(task)).catch(() => {}); return task; };
  const safeCode = error => /^[A-Za-z0-9_]{1,96}$/.test(error?.code ?? '') ? error.code : 'participant_component_unavailable';
  function retry() {
    if (lifetime.aborted || retryTimer) return;
    const ms = Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures++, 6));
    report({ state: 'setup_retry', retryInMs: ms });
    retryTimer = setTimeout(() => { retryTimer = undefined; reconcile(); }, ms);
  }
  function stopAdapter() {
    const previous = adapter; adapter = undefined; adapterRevision = undefined;
    adapterAbort?.abort(); adapterAbort = undefined;
    return previous ? Promise.resolve(previous.close()).catch(error => report({ state: 'adapter_cleanup_failed', code: safeCode(error) })) : Promise.resolve();
  }
  function updateAdapter() {
    const approved = notice?.assistant;
    if (!startAdapter || !approved?.approved || approved.proposalId !== proposalId) {
      blockedRevision = undefined;
      if (adapter) track(stopAdapter());
      if (startAdapter) report({ state: 'awaiting_assistant_consent', participantRunning: true });
      return;
    }
    if (adapterTask && adapterRevision !== approved.revision) { track(stopAdapter()); return; }
    if (approved.revision === blockedRevision || adapterRevision === approved.revision || adapterTask) return;
    const revision = approved.revision;
    adapterTask = track((async () => {
      await stopAdapter(); if (lifetime.aborted) return;
      const controller = adapterAbort = new AbortController(), componentSignal = AbortSignal.any([controller.signal, lifetime]);
      let current;
      try {
        current = adapter = startAdapter({ signal: componentSignal, onStatus: status => {
          report({ assistant: status, participantRunning: true });
          if (['approval_changed', 'participant_replaced'].includes(status.reason)) blockedRevision = revision;
        } });
        adapterRevision = revision;
        const closed = Promise.resolve(current.closed).finally(() => controller.abort());
        await current.waitUntilOnline({ signal: componentSignal });
        report({ state: 'adapter_online', participantRunning: true, roundTripVerified: false, futureWakeVerified: false });
        await (onOnline ? Promise.race([closed, Promise.resolve(onOnline(current, componentSignal)).then(() => closed)]) : closed);
      } catch (error) {
        if (!lifetime.aborted && !controller.signal.aborted) report({ state: 'adapter_offline', code: safeCode(error), participantRunning: true });
      } finally {
        if (adapter === current) await stopAdapter();
      }
    })());
    adapterTask.finally(() => {
      adapterTask = undefined;
      if (!lifetime.aborted && notice?.assistant.approved && notice.assistant.revision !== blockedRevision) retry();
    }).catch(() => {});
  }
  async function drain() {
    while (dirty && !lifetime.aborted) {
      dirty = false; updateAdapter();
      try {
        const results = owned.processPairings ? await owned.processPairings({ signal: lifetime }) : [];
        failures = 0; clearTimeout(expiryTimer); expiryTimer = undefined;
        for (const result of results) report({ pairing: result });
        if (results.some(result => result.state === 'committed') && await owned.session.orderingPause?.()) dirty = true;
        if (results.some(result => result.state === 'committing')) retry();
        // One local deadline for active human review, never idle server polling.
        const deadlines = results.filter(result => ['pending', 'approved', 'committing'].includes(result.state))
          .map(result => result.expiresAt).filter(at => Number.isSafeInteger(at) && at > Date.now());
        if (deadlines.length) expiryTimer = setTimeout(reconcile, Math.min(...deadlines) - Date.now() + 1);
      } catch (error) {
        if (lifetime.aborted) return;
        report({ state: 'pairing_unavailable', code: safeCode(error), participantRunning: true });
        // Missing owner claim is resolved by its notification; don't poll it.
        if (!['pairing_account_required', 'pairing_account_revoked', 'forbidden', 'agent_binding_revoked'].includes(error.code) &&
          (!String(error.code).startsWith('PAIRING_') || error.code === 'PAIRING_OUTCOME_UNCERTAIN')) retry();
      }
    }
  }
  function reconcile(value) {
    if (lifetime.aborted) return;
    if (value) notice = value;
    dirty = true;
    if (!processing) {
      processing = track(drain());
      processing.finally(() => { processing = undefined; if (dirty && !lifetime.aborted) reconcile(); }).catch(() => {});
    }
  }
  const channel = watch({ signal: lifetime, onChange: reconcile, onStatus: status => report({ setup: status, participantRunning: true }) });
  track(Promise.resolve(channel.closed).then(() => {
    if (!lifetime.aborted) report({ state: 'setup_channel_closed', participantRunning: true,
      next: 'Restore this retained host credential and reconnect; the application remains running.' });
  }));
  const done = (async () => {
    if (!lifetime.aborted) await new Promise(resolve => lifetime.addEventListener('abort', resolve, { once: true }));
    clearTimeout(expiryTimer); clearTimeout(retryTimer);
    await channel.close(); await stopAdapter();
    await Promise.allSettled([...tasks]);
  })();
  return Object.freeze({ done, reconcile, close() { stop.abort(); return done; } });
}
