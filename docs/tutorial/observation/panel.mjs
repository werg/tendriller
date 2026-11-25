import { createObservationSource } from './browser.mjs';
import { id, retentionInput, validRetentionInput } from './protocol.mjs';

function loadPending(storage, key) {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && id(parsed.operationId) && validRetentionInput(parsed.input)) {
      return parsed;
    }
  } catch { /* Corrupt local drafts are not dispatched. */ }
  return null;
}

/** Mount into an authored page after its authenticated session is connected. */
export function mountObservations({
  container, session, runtime, nativeDeviceId, storage = globalThis.localStorage, ...options
}) {
  container.innerHTML = `<section aria-label="Reviewed live observation">
    <h2>Share an observation</h2>
    <p>Live samples are visible to authorized application readers. Nothing is retained until you review and save it.</p>
    <p id="observation-request" role="status">No remote request.</p>
    <button id="observation-decline" type="button">Decline request</button>
    <button id="observation-simulate" type="button">Start simulator sharing</button>
    <button id="observation-location" type="button" disabled>Start location sharing</button>
    <button id="observation-stop" type="button">Stop sharing</button>
    <p id="observation-capability">Checking location API; the simulator remains available.</p>
    <p id="observation-state" role="status">Stopped. Not sharing.</p>
    <pre id="observation-sample">No accepted sample.</pre>
    <label for="observation-review">Review the observation to retain</label>
    <textarea id="observation-review" maxlength="2000"></textarea>
    <button id="observation-retain" type="button" disabled>Retain reviewed observation</button>
    <button id="observation-inspect" type="button" disabled>Inspect pending operation</button>
    <button id="observation-retry" type="button" disabled>Retry same operation</button>
    <p id="observation-result" role="status">No durable command submitted.</p>
  </section>`;

  const $ = selector => container.querySelector(selector);
  const key = `observation-pending:${session.applicationId}:${session.identity.publicKey}`;
  const panelOwner = new AbortController();
  let closed = false, pending = loadPending(storage, key), saving = false, savedSample = null, latestState = null;

  const showError = error => { if (!closed) $('#observation-result').textContent = error.message ?? String(error); };
  const bindings = [];
  function bind(selector, fn) {
    const listener = event => {
      try { Promise.resolve(fn(event)).catch(showError); }
      catch (error) { showError(error); }
    };
    $(selector).addEventListener('click', listener);
    bindings.push(() => $(selector).removeEventListener('click', listener));
  }

  const render = state => {
    if (closed || !state) return;
    latestState = state;
    $('#observation-state').textContent = `${state.sharing ? 'Sharing' : 'Not sharing'}; source ${state.phase}; native receiver ${state.receiver}.${state.error ? ` ${state.error}` : ''}`;
    $('#observation-request').textContent = state.request
      ? `The authorized native participant requests ${state.request.source}. Choose its Start button to share, or Decline. Request ${state.request.requestId}.`
      : 'No remote request.';
    $('#observation-decline').disabled = !state.request;
    $('#observation-stop').disabled = !state.sharing;
    const displayedFix = state.sample?.fix ?? pending?.input.fix ?? null;
    $('#observation-sample').textContent = displayedFix ? JSON.stringify(displayedFix, null, 2) : 'No accepted sample.';
    const locked = pending && !pending.stored;
    $('#observation-retain').disabled = session.status.canAuthor !== true || saving || Boolean(locked) || !state.sample
      || savedSample === `${state.sample.streamId}/${state.sample.sequence}`;
    $('#observation-review').readOnly = saving || Boolean(locked);
    $('#observation-inspect').disabled = !pending || saving;
    $('#observation-retry').disabled = !pending || saving;
  };

  const source = createObservationSource({ session, runtime, nativeDeviceId, ...options, onState: render });
  const requireGesture = event => { if (event?.isTrusted !== true) throw Error('Use a deliberate local action.'); };
  const waitSignal = () => AbortSignal.any([panelOwner.signal, AbortSignal.timeout(15_000)]);

  const settle = inspection => {
    if (!inspection || inspection.operationId !== pending?.operationId) return;
    const acknowledgedBefore = pending.stored === true;
    if (inspection.stored) {
      savedSample = `${pending.input.streamId}/${pending.input.sequence}`;
      pending = { ...pending, stored: true, proposalId: inspection.proposalId };
      storage.setItem(key, JSON.stringify(pending));
      if (!acknowledgedBefore && $('#observation-review').value === pending.input.text) { $('#observation-review').value = ''; storage.removeItem(key + ':draft'); }
    }
    if (!closed) $('#observation-result').textContent = `Operation ${inspection.operationId}. Stored locally: ${inspection.stored}. Materialized: ${inspection.materialized?.outcome ?? 'pending'}${inspection.materialized?.rejectionCode ? ` (${inspection.materialized.rejectionCode})` : ''} (revisable). Retained by peers: ${inspection.retained.filter(row => row?.payload?.peer !== session.identity.publicKey).length}. Finalized: ${inspection.finalized}. Excluded: ${inspection.excluded}. Original signed intent remains inspectable.`;
  };
  async function observeOperation(operation) { settle(await operation.inspect()); }
  let inspectionTask, inspectDirty = false;
  function inspectPending() {
    inspectDirty = true;
    return inspectionTask ??= (async () => {
      while (inspectDirty && !closed && pending) {
        inspectDirty = false; const operationId = pending.operationId;
        const operation = await session.operations.get(operationId);
        if (operationId !== pending?.operationId) { inspectDirty = true; continue; }
        if (operation) await observeOperation(operation);
        else if (!closed) $('#observation-result').textContent = `Original operation ${operationId} not yet visible; inspect/retry only its retained exact inputs and ID.`;
      }
    })().finally(() => { inspectionTask = undefined; });
  }
  // Peer retention and finality are facts about the original operation that never change the
  // materialization revision, so session.onChange alone would leave them stale. Observe only the
  // one pending operation, rebinding when its ID changes and closing the iterator on rebind/close.
  let factsFor = null, stopFacts = () => {};
  function observeFacts() {
    const operationId = pending?.operationId ?? null;
    if (closed || operationId === factsFor) return;
    stopFacts(); stopFacts = () => {}; factsFor = operationId;
    if (operationId === null) return;
    const owner = new AbortController(), signal = AbortSignal.any([panelOwner.signal, owner.signal]);
    const iterator = session.operations.subscribe({ operationId, signal })[Symbol.asyncIterator]();
    stopFacts = () => { owner.abort(); void iterator.return?.()?.catch?.(() => {}); };
    void (async () => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (signal.aborted || next.done) break;
          const inspection = next.value;
          // Facts for another application or operation are never shown; keep observing the bound one.
          if (inspection?.applicationId !== session.applicationId || inspection.operationId !== operationId || pending?.operationId !== operationId) continue;
          settle(inspection); render(latestState);
        }
      } catch (error) { if (!signal.aborted) showError(error); }
    })();
  }
  const stopChanges = session.onChange(() => { void inspectPending().catch(showError); });
  const stopStatus = session.onStatus(() => { render(latestState); });
  $('#observation-review').addEventListener('input', () => { try { storage.setItem(key + ':draft', $('#observation-review').value); } catch (error) { showError(error); } });

  bind('#observation-simulate', event => source.start(event, 'simulated'));
  bind('#observation-location', event => source.start(event, 'location'));
  bind('#observation-stop', () => source.stop());
  bind('#observation-decline', () => source.decline());

  bind('#observation-retain', async event => {
    requireGesture(event);
    if (pending && !pending.stored || saving) throw Error('Inspect the original uncertain operation first.');
    // Freeze both human text and the exact displayed sample before dispatch.
    const input = retentionInput(source.reviewedSample(), $('#observation-review').value);
    const attempt = { operationId: crypto.randomUUID(), input };
    storage.setItem(key, JSON.stringify(attempt));
    pending = attempt; observeFacts();
    saving = true;
    render(latestState);
    try {
      await observeOperation(await session.command('retainObservation', input, { operationId: attempt.operationId }));
    } catch (error) {
      throw Error(`Operation ${attempt.operationId} is unresolved. Inspect or retry this exact identity. ${error.message}`);
    } finally {
      saving = false;
      render(latestState);
    }
  });

  bind('#observation-inspect', async event => { requireGesture(event); await inspectPending(); render(latestState); });
  bind('#observation-retry', async event => {
    requireGesture(event); if (!pending || saving) return; saving = true; render(latestState);
    try {
      const original = await session.operations.get(pending.operationId);
      await observeOperation(original ? await session.operations.retry(pending.operationId) : await session.command('retainObservation', pending.input, { operationId: pending.operationId }));
    } finally { saving = false; render(latestState); }
  });

  if (pending) {
    observeFacts();
    $('#observation-review').value = pending.input.text;
    $('#observation-result').textContent = `Retained original operation ${pending.operationId}. Inspect stored/materialized/retained/finalized facts; current outcomes can revise.`;
  }

  try { $('#observation-review').value = storage.getItem(key + ':draft') ?? $('#observation-review').value; } catch (error) { showError(error); }

  void runtime.capabilities(['location']).then(report => {
    if (closed) return;
    const capability = report.capabilities.location;
    const available = capability?.available && capability.permission !== 'denied';
    $('#observation-location').disabled = !available;
    $('#observation-capability').textContent = available
      ? 'Location API available; permission and a usable fix are checked only after Start.'
      : 'Location unavailable or denied. Use the simulator; you can still edit retained observations.';
  }).catch(() => {
    if (!closed) $('#observation-capability').textContent = 'Location inspection failed. Use the simulator.';
  });

  return {
    source,
    async close() {
      if (closed) return;
      closed = true;
      panelOwner.abort(); stopFacts(); stopChanges(); stopStatus();
      for (const remove of bindings) remove();
      await source.close();
    },
  };
}
