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

const isApplied = inspected => inspected?.state?.status === 'applied' || inspected?.state?.phase === 'applied';

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
  const key = `observation-pending:${session.applicationId}:${session.deviceId}`;
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
    $('#observation-retain').disabled = saving || Boolean(pending) || !state.sample
      || savedSample === `${state.sample.streamId}/${state.sample.sequence}`;
    $('#observation-review').readOnly = saving || Boolean(pending);
    $('#observation-inspect').disabled = !pending || saving;
    $('#observation-retry').disabled = !pending || saving;
  };

  const source = createObservationSource({ session, runtime, nativeDeviceId, ...options, onState: render });
  const requireGesture = event => { if (event?.isTrusted !== true) throw Error('Use a deliberate local action.'); };
  const waitSignal = () => AbortSignal.any([panelOwner.signal, AbortSignal.timeout(15_000)]);

  const settle = result => {
    if (result?.status === 'applied') {
      if (result.outcome === 'accepted' && pending) {
        savedSample = `${pending.input.streamId}/${pending.input.sequence}`;
      }
      storage.removeItem(key);
      pending = null;
      if (!closed) {
        $('#observation-result').textContent = result.outcome === 'accepted'
          ? 'Applied: accepted. The reviewed observation is retained.'
          : `Applied: rejected (${result.rejectionCode ?? 'application validation'}). No observation was retained.`;
      }
    } else if (!closed) {
      $('#observation-result').textContent = 'The operation remains pending. Inspect it before retrying the same identity.';
    }
  };

  async function waitForOperation(operation) {
    settle(await operation.applied({ signal: waitSignal() }));
  }

  bind('#observation-simulate', event => source.start(event, 'simulated'));
  bind('#observation-location', event => source.start(event, 'location'));
  bind('#observation-stop', () => source.stop());
  bind('#observation-decline', () => source.decline());

  bind('#observation-retain', async event => {
    requireGesture(event);
    if (pending || saving) throw Error('Inspect the pending operation first.');
    // Freeze both human text and the exact displayed sample before dispatch.
    const input = retentionInput(source.reviewedSample(), $('#observation-review').value);
    const attempt = { operationId: crypto.randomUUID(), input };
    storage.setItem(key, JSON.stringify(attempt));
    pending = attempt;
    saving = true;
    render(latestState);
    try {
      await waitForOperation(await session.command('retainObservation', input, { operationId: attempt.operationId }));
    } catch (error) {
      throw Error(`Operation ${attempt.operationId} is unresolved. Inspect or retry this exact identity. ${error.message}`);
    } finally {
      saving = false;
      render(latestState);
    }
  });

  bind('#observation-inspect', async event => {
    requireGesture(event);
    if (!pending) return;
    const inspected = await session.operations.inspect(pending.operationId);
    if (isApplied(inspected)) {
      settle({ status: 'applied', outcome: inspected.state.outcome, rejectionCode: inspected.state.rejectionCode });
    } else if (!closed) {
      $('#observation-result').textContent = `Operation ${pending.operationId}: ${JSON.stringify(inspected?.state ?? 'not yet saved')}. Retry keeps its original input.`;
    }
    render(latestState);
  });

  bind('#observation-retry', async event => {
    requireGesture(event);
    if (!pending || saving) return;
    saving = true;
    render(latestState);
    try {
      const inspected = await session.operations.inspect(pending.operationId);
      if (isApplied(inspected)) {
        settle({ status: 'applied', outcome: inspected.state.outcome, rejectionCode: inspected.state.rejectionCode });
      } else if (inspected) {
        await session.retry(pending.operationId);
        settle(await session.operations.wait(pending.operationId, { signal: waitSignal() }));
      } else {
        await waitForOperation(await session.command('retainObservation', pending.input, { operationId: pending.operationId }));
      }
    } finally {
      saving = false;
      render(latestState);
    }
  });

  if (pending) {
    $('#observation-review').value = pending.input.text;
    $('#observation-result').textContent = `Unresolved operation ${pending.operationId}. Inspect it or deliberately retry the same identity.`;
  }

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
      panelOwner.abort();
      for (const remove of bindings) remove();
      await source.close();
    },
  };
}
