import { connectApplicationWorker } from '@chronolog/peer-session/browser';
import { serveWorkerWebRtcConnections } from '@chronolog/peer-session/webrtc';
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';

const $ = selector => document.querySelector(selector);
const configuration = await fetch(new URL('./configuration.json', import.meta.url)).then(response => response.json());
const storagePrefix = `tendriller-notes-${configuration.applicationId}`;
const readLocal = name => { try { return localStorage.getItem(`${storagePrefix}:${name}`); } catch { return null; } };
const writeLocal = (name, value) => { try { localStorage.setItem(`${storagePrefix}:${name}`, value); } catch { /* Session persistence is independent. */ } };
let worker, rtc, session, watching = false, refreshRequest = 0;
let pending = JSON.parse(readLocal('pending') || 'null');
const observation = new AbortController();
const report = error => { $('#result').textContent = error.message ?? String(error); };
$('#note').value = readLocal('draft') ?? '';
$('#operation-id').value = readLocal('operation') ?? '';
if (pending) {
  $('#operation-id').value = pending.id;
  $('#submit').disabled = true;
  $('#create-device').disabled = true;
  $('#result').textContent = `Unresolved operation ${pending.id}. Inspect or retry its original identity before submitting another note.`;
}
$('#note').addEventListener('input', () => writeLocal('draft', $('#note').value));

function savePending(value) {
  // A durable local reference makes an uncertain first call inspectable after
  // reload. Refuse a new submission if this reference cannot be retained.
  localStorage.setItem(`${storagePrefix}:pending`, JSON.stringify(value));
  pending = value;
  $('#submit').disabled = Boolean(pending);
  $('#reapply').disabled = true;
}
function acceptedOrRejected(result) {
  if (result?.status === 'applied' && pending?.id === result.operationId) {
    if (result.outcome === 'accepted' && $('#note').value.trim() === pending.text) {
      $('#note').value = ''; writeLocal('draft', '');
    }
    savePending(null);
  }
}

function workerReply(expected) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('Browser setup timed out; inspect the error and retry opening the existing device.')), 30_000);
    const message = ({ data }) => {
      if (data?.type === 'tutorial-failure') finish(Error(data.message));
      else if (data?.type === expected) finish(null, data);
    };
    const failed = event => finish(Error(event.message || 'The application Worker failed to load.'));
    function finish(error, value) {
      clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', failed);
      if (error) reject(error); else resolve(value);
    }
    worker.addEventListener('message', message); worker.addEventListener('error', failed);
  });
}
function makeWorker() { worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' }); }
function busy(value) { $('#create-device').disabled = value || Boolean(pending); $('#connect').disabled = value; }

$('#create-device').addEventListener('click', async () => {
  busy(true);
  try {
    if (pending) throw Error('Resume the existing device and resolve its pending operation before setting up another identity.');
    makeWorker();
    const ready = workerReply('tutorial-identity'); worker.postMessage({ type: 'tutorial-create' });
    const { publicKey } = await ready;
    $('#device-key').value = publicKey;
    $('#enrollment-command').textContent = `npm run enroll -- ${publicKey}`;
    $('#enrollment').hidden = false;
    $('#connection').textContent = 'Device created. Enroll this public key, start the native peer, then connect.';
  } catch (error) { report(error); }
  finally { worker?.terminate(); worker = undefined; busy(false); }
});

async function refresh() {
  const request = ++refreshRequest;
  const snapshot = await session.query('notes', null);
  // Status, data changes and explicit actions can overlap. Only the latest
  // requested view may paint; each caller still gets its own coherent revision.
  if (request !== refreshRequest) return snapshot;
  const list = $('#notes'); list.replaceChildren();
  for (const note of snapshot.value) {
    const item = document.createElement('li'), body = document.createElement('p'), by = document.createElement('small');
    body.textContent = note.text;
    by.textContent = `Author ${note.author.slice(0, 12)} · operation ${note.operationId}`;
    item.append(body, by); list.append(item);
  }
  $('#count').textContent = `${snapshot.value.length} retained note${snapshot.value.length === 1 ? '' : 's'} in this selected history`;
  return snapshot;
}

function watchChanges() {
  if (watching) return;
  watching = true;
  void (async () => {
    try { for await (const _change of session.changes({ signal: observation.signal })) await refresh(); }
    catch (error) { if (!observation.signal.aborted) report(error); }
    finally { watching = false; }
  })();
}

$('#connect').addEventListener('click', async () => {
  busy(true);
  let installed = false;
  try {
    makeWorker(); rtc = serveWorkerWebRtcConnections(worker);
    const ready = workerReply('tutorial-opened'); worker.postMessage({ type: 'tutorial-connect' });
    const { publicKey } = await ready; $('#device-key').value = publicKey;
    session = await connectApplicationWorker(worker, { timeoutMs: 30_000 });
    if (!window.tendril) throw Error('Open the published Tendriller page to install its runtime binding.');
    window.tendril.application.install(createApplicationBackend({ id: session.applicationId, session }));
    window.tendril.signals.install(session.signals);
    session.onStatus(status => {
      $('#data-status').textContent = `Data: ${status.database}; application: ${status.phase}`;
      // A fresh reader can reach awaiting-keys before its donor connects.
      // Resume rendering on real session status changes, without polling.
      if (status.database === 'ready' && status.phase === 'ready') {
        void refresh().then(watchChanges).catch(report);
      }
    });
    session.participation.onStatus(status => {
      $('#connection').textContent = `Connection: ${status.phase}${status.error ? ` (${status.error})` : ''}. Keep the native peer running.`;
    });
    session.onRecovery(notice => {
      $('#recovery').hidden = false;
      $('#recovery').textContent = `Selected history changed. ${notice.abandoned.length} known operations were excluded; unknown loss: ${notice.unknownLoss}. Inspect the original operation before deciding whether to submit new work.`;
    });
    $('#editor').disabled = false; $('#close').disabled = false;
    installed = true;
    // The query activates data. Status observation handles later key delivery.
    await refresh(); watchChanges();
  } catch (error) {
    if (!installed) {
      const facadeOpened = Boolean(session);
      ++refreshRequest;
      try { await session?.close(); } catch { /* Preserve the setup failure. */ }
      try { rtc?.close(); } catch { /* Preserve the setup failure. */ }
      worker?.terminate();
      session = rtc = worker = undefined;
      $('#editor').disabled = true; $('#close').disabled = true;
      // A partially installed runtime binding cannot be replaced in this page.
      // Close the owned store first, then make the required reload explicit.
      busy(facadeOpened);
      if (facadeOpened) $('#connection').textContent = 'Connection setup failed. Reload to reconnect this existing device.';
    }
    report(error);
  }
});

$('#form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#submit').disabled = true;
  try {
    if (pending) throw Error('Inspect or retry the unresolved operation before starting another note.');
    const text = $('#note').value.trim();
    if (!text) throw Error('Write a note first.');
    const before = await refresh();
    const operationId = crypto.randomUUID();
    // Save the reference before submitting. This is a UI reference, not a
    // second delivery queue; Chronolog owns and retries the signed attempt.
    $('#operation-id').value = operationId; writeLocal('operation', operationId);
    savePending({ id: operationId, text, basedOn: before.revision });
    const operation = await session.command('addNote', { text }, { operationId, basedOn: before.revision });
    $('#result').textContent = `Saved locally as ${operationId}. Waiting for applied execution…`;
    const result = await operation.applied({ signal: AbortSignal.timeout(15_000) });
    $('#result').textContent = `Applied: ${result.outcome}. Operation ${operationId}. Retained coverage is separate; explicit recovery can exclude applied work.`;
    acceptedOrRejected(result);
    await refresh();
  } catch (error) { report(Error(`${error.message} Inspect or retry the displayed operation ID; do not resubmit uncertain work with a new ID.`)); }
  finally { $('#submit').disabled = Boolean(pending); }
});

$('#inspect').addEventListener('click', async () => {
  try {
    const inspection = await session.operations.inspect($('#operation-id').value);
    $('#result').textContent = JSON.stringify({
      ...(pending?.id === $('#operation-id').value ? { reviewedInput: { text: pending.text } } : {}),
      inspection,
    }, null, 2);
    acceptedOrRejected(inspection?.state);
    $('#reapply').disabled = !(pending?.id === $('#operation-id').value &&
      ['abandoned', 'needsReapply'].includes(inspection?.state.status));
  }
  catch (error) { report(error); }
});
$('#retry').addEventListener('click', async () => {
  try {
    const id = $('#operation-id').value;
    if (!await session.operations.get(id) && pending?.id === id) {
      const options = { operationId: id, basedOn: pending.basedOn };
      // A first RPC can fail before its saved acknowledgment. Explicit retry
      // preserves the original input, revision and identity in that case too.
      if (pending.reapplies) await session.reapply(pending.reapplies, 'addNote', { text: pending.text }, options);
      else await session.command('addNote', { text: pending.text }, options);
    } else await session.retry(id);
    const result = await session.operations.wait(id, { signal: AbortSignal.timeout(15_000) });
    $('#result').textContent = JSON.stringify(result, null, 2); acceptedOrRejected(result);
    await refresh();
  } catch (error) { report(error); }
});
$('#reapply').addEventListener('click', async () => {
  $('#reapply').disabled = true;
  try {
    const previous = pending;
    const before = await refresh();
    const inspected = await session.operations.get(previous.id);
    if (!['abandoned', 'needsReapply'].includes(inspected?.status)) throw Error('The original operation is no longer eligible for reviewed reapplication.');
    const id = crypto.randomUUID();
    savePending({ id, text: previous.text, basedOn: before.revision, reapplies: previous.id });
    $('#operation-id').value = id; writeLocal('operation', id);
    const operation = await session.reapply(previous.id, 'addNote', { text: previous.text }, { operationId: id, basedOn: before.revision });
    const result = await operation.applied({ signal: AbortSignal.timeout(15_000) });
    $('#result').textContent = JSON.stringify(result, null, 2); acceptedOrRejected(result); await refresh();
  } catch (error) { report(error); }
});
$('#refresh').addEventListener('click', () => { void refresh().catch(report); });

async function close() {
  observation.abort();
  ++refreshRequest;
  try { await session?.close(); }
  finally { rtc?.close(); worker?.terminate(); $('#editor').disabled = true; $('#close').disabled = true;
    $('#connection').textContent = 'Connection closed. Reload to reconnect this existing device.'; }
}
$('#close').addEventListener('click', () => { void close().catch(report); });
window.addEventListener('pagehide', () => { void close().catch(() => {}); }, { once: true });
if (location.origin !== new URL(configuration.page_url).origin) {
  busy(true);
  $('#connection').textContent = 'Layout preview. Open the published page to enroll and connect its real application session.';
}
