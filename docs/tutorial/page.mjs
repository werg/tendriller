import { connectApplicationWorker } from '@chronolog/peer-session/browser';
import { serveWorkerWebRtcConnections } from '@chronolog/peer-session/webrtc';
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';
import { createLiveView } from './helpers/live-view.mjs';
import { createOperationView } from './helpers/operation-view.mjs';
import { mountReviewedMedia } from './media/panel.mjs';

const $ = selector => document.querySelector(selector);
const configuration = await fetch(new URL('./configuration.json', import.meta.url)).then(response => response.json());
const storagePrefix = `tendriller-notes-${configuration.applicationId}`;
const readLocal = name => { try { return localStorage.getItem(`${storagePrefix}:${name}`); } catch { return null; } };
const writeLocal = (name, value) => { try { localStorage.setItem(`${storagePrefix}:${name}`, value); } catch { /* Session persistence is independent. */ } };
let worker, rtc, session, liveView, operationView, observedOperation, media;
let preparingSubmission = false;
let pending = JSON.parse(readLocal('pending') || 'null');
const report = error => { $('#result').textContent = error.message ?? String(error); };
const operationStatus = document.createElement('p');
operationStatus.id = 'operation-status'; operationStatus.setAttribute('role', 'status');
$('#result').before(operationStatus);
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
  media?.setBlocked(Boolean(pending) || preparingSubmission);
}
function beginSubmission() {
  if (pending || preparingSubmission) throw Error('Resolve the current submission before starting another operation.');
  preparingSubmission = true; $('#submit').disabled = true; media?.setBlocked(true);
  return () => {
    preparingSubmission = false; $('#submit').disabled = Boolean(pending);
    media?.setBlocked(Boolean(pending));
  };
}
const commandOf = value => value.command ?? 'addNote';
const inputOf = value => value.input ?? { text: value.text };
function acceptedOrRejected(result) {
  if (result?.status === 'applied' && pending?.id === result.operationId) {
    const originalOperationId = pending.originOperationId ?? pending.reapplies ?? pending.id;
    if (result.outcome === 'accepted' && commandOf(pending) === 'addNote' && $('#note').value.trim() === inputOf(pending).text) {
      $('#note').value = ''; writeLocal('draft', '');
    }
    savePending(null);
    media?.resolved(result, originalOperationId);
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

function renderNotes(snapshot) {
  const list = $('#notes'); list.replaceChildren();
  for (const note of snapshot.value) {
    const item = document.createElement('li'), body = document.createElement('p'), by = document.createElement('small');
    body.textContent = note.text;
    by.textContent = `Author ${note.author.slice(0, 12)} · operation ${note.operationId}`;
    if (note.source) by.textContent += ' · reviewed photo';
    item.append(body, by); list.append(item);
  }
  $('#count').textContent = `${snapshot.value.length} retained note${snapshot.value.length === 1 ? '' : 's'} in this selected history`;
}
function refresh() { return liveView.refresh(); }
function observeOperation(id, operation) {
  if (observedOperation === id && !operation) return operationView;
  operationView?.close(); observedOperation = id;
  operationView = createOperationView(session, { operationId: id, operation,
    onChange({ state, coverage, waitingForShared }) {
      const label = !state ? 'No saved attempt visible; preserve the original input and ID.'
        : state.status === 'saved' ? 'Saved on this device; waiting for applied execution.'
        : state.status === 'applied' ? `Applied: ${state.outcome}${state.rejectionCode ? ` (${state.rejectionCode})` : ''}.`
        : `${state.status}: inspect current notes before explicitly reapplying the original input.`;
      const retention = coverage ? `${coverage.length} peer retention receipt(s) observed for this attempt; recovery can still exclude it.`
        : waitingForShared ? 'Waiting for separate peer retention evidence.' : 'Peer retention has not been observed here.';
      operationStatus.textContent = `${id}: ${label} ${retention}`;
    },
    // Observation failures do not erase the uncertain command explanation.
    onError(error) { operationStatus.textContent = `${id}: observation unavailable (${error.message}). Inspect the original operation.`; },
  });
  if (operation) void operationView.waitForShared().catch(() => {});
  return operationView;
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
    liveView = createLiveView(session, { query: 'notes', input: null,
      onStatus(status) { $('#data-status').textContent = `Data: ${status.database}; application: ${status.phase}`; },
      onRecovery(notice) {
        $('#recovery').hidden = false;
        $('#recovery').textContent = `Selected history changed. ${notice.abandoned.length} known operations were excluded; unknown loss: ${notice.unknownLoss}. Inspect the original operation before deciding whether to submit new work.`;
      }, onError: report,
    });
    liveView.subscribe(renderNotes);
    media = mountReviewedMedia({ container: $('#media-panel'), session, runtime: window.tendril,
      nativeDeviceId: configuration.nativeDeviceId,
      getContext: () => liveView.snapshot ? { revision: liveView.snapshot.revision, collection: 'shared-notes' } : null,
      prepareCommit: prepareEvidence, commit: submitEvidence, blocked: Boolean(pending),
      onVoiceDraft(text) {
        $('#note').value = [$('#note').value, text].filter(Boolean).join('\n');
        writeLocal('draft', $('#note').value);
      },
    });
    session.participation.onStatus(status => {
      $('#connection').textContent = `Connection: ${status.phase}${status.error ? ` (${status.error})` : ''}. Keep the native peer running.`;
    });
    if ($('#operation-id').value) observeOperation($('#operation-id').value);
    $('#editor').disabled = false; $('#close').disabled = false;
    installed = true;
    // The query activates data. Status observation handles later key delivery.
    await refresh();
  } catch (error) {
    if (!installed) {
      const facadeOpened = Boolean(session);
      liveView?.close(); operationView?.close(); media?.close();
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
  let release;
  try {
    release = beginSubmission();
    const text = $('#note').value.trim();
    if (!text) throw Error('Write a note first.');
    if (text.length > 2000) throw Error('Edit the note to 2,000 characters or fewer before saving. Nothing was submitted.');
    const before = await refresh();
    const operationId = crypto.randomUUID();
    // Save the reference before submitting. This is a UI reference, not a
    // second delivery queue; Chronolog owns and retries the signed attempt.
    $('#operation-id').value = operationId; writeLocal('operation', operationId);
    savePending({ id: operationId, command: 'addNote', input: { text }, basedOn: before.revision });
    const operation = await session.command('addNote', { text }, { operationId, basedOn: before.revision });
    observeOperation(operationId, operation);
    $('#result').textContent = `Saved locally as ${operationId}. Waiting for applied execution…`;
    const result = await operation.applied({ signal: AbortSignal.timeout(15_000) });
    $('#result').textContent = `Applied: ${result.outcome}. Operation ${operationId}. Retained coverage is separate; explicit recovery can exclude applied work.`;
    acceptedOrRejected(result);
    await refresh();
  } catch (error) { report(Error(`${error.message} Inspect or retry the displayed operation ID; do not resubmit uncertain work with a new ID.`)); }
  finally { release?.(); }
});

async function prepareEvidence({ candidate, reviewed, operationId, signal }) {
  signal.throwIfAborted();
  const text = reviewed.text?.trim(), capturedRevision = JSON.stringify(candidate.context.revision);
  if (!text || text.length > 2000) throw Error('A reviewed observation must contain 1–2,000 characters. Nothing was submitted.');
  if (!capturedRevision || capturedRevision.length > 16384) throw Error('The captured revision exceeds this example’s input limit. Nothing was submitted.');
  const release = beginSubmission();
  try {
    $('#operation-id').value = operationId; writeLocal('operation', operationId);
    let source = reviewed.source;
    if (!source) {
      // Manual review works without a provider. Staging begins only after the
      // person chooses Save, and remains separate from the semantic command.
      const bytes = new Uint8Array(await candidate.blob.arrayBuffer());
      signal.throwIfAborted();
      const upload = await session.content.stage({ bytes: bytes.length, mediaType: candidate.type });
      for (let offset = 0; offset < bytes.length; offset += 65_536) {
        signal.throwIfAborted(); await upload.write(offset / 65_536, bytes.slice(offset, offset + 65_536));
      }
      signal.throwIfAborted();
      source = { candidateId: candidate.id, sha256: candidate.sha256, reference: await upload.commit() };
    }
    signal.throwIfAborted();
    if (pending) throw Error('Another operation became pending; inspect it before submitting evidence.');
    if (source.candidateId !== candidate.id || source.sha256 !== candidate.sha256 ||
        source.reference.applicationId !== session.applicationId || source.reference.historyId !== session.historyId)
      throw Error('The reviewed source no longer matches this application, history and candidate.');
    const input = { text, source, capturedRevision };
    $('#operation-id').value = operationId; writeLocal('operation', operationId);
    savePending({ id: operationId, command: 'addEvidence', input, basedOn: candidate.context.revision });
  } finally { release(); }
}

async function submitEvidence({ candidate, reviewed, operationId, signal }) {
  signal.throwIfAborted();
  if (pending?.id !== operationId || pending.command !== 'addEvidence' ||
      pending.input.source.candidateId !== candidate.id || pending.input.source.sha256 !== candidate.sha256 ||
      pending.input.text !== reviewed.text.trim()) throw Error('The prepared evidence intent does not match this review. Inspect the original operation.');
  const input = pending.input;
  const operation = await session.command('addEvidence', input, { operationId, basedOn: candidate.context.revision });
  observeOperation(operationId, operation);
  const result = await operation.applied({ signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  $('#result').textContent = `Applied: ${result.outcome}. Reviewed evidence operation ${operationId}.`;
  acceptedOrRejected(result); await refresh();
  return JSON.parse(JSON.stringify(result));
}

$('#inspect').addEventListener('click', async () => {
  try {
    const { inspection } = await observeOperation($('#operation-id').value).refresh();
    $('#result').textContent = JSON.stringify({
      ...(pending?.id === $('#operation-id').value ? { command: commandOf(pending), reviewedInput: inputOf(pending) } : {}),
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
      if (pending.reapplies) await session.reapply(pending.reapplies, commandOf(pending), inputOf(pending), options);
      else await session.command(commandOf(pending), inputOf(pending), options);
    } else await session.retry(id);
    observeOperation(id);
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
    savePending({ id, command: commandOf(previous), input: inputOf(previous), basedOn: before.revision,
      reapplies: previous.id, originOperationId: previous.originOperationId ?? previous.reapplies ?? previous.id });
    $('#operation-id').value = id; writeLocal('operation', id);
    const operation = await session.reapply(previous.id, commandOf(previous), inputOf(previous), { operationId: id, basedOn: before.revision });
    observeOperation(id, operation);
    const result = await operation.applied({ signal: AbortSignal.timeout(15_000) });
    $('#result').textContent = JSON.stringify(result, null, 2); acceptedOrRejected(result); await refresh();
  } catch (error) { report(error); }
});
$('#refresh').addEventListener('click', () => { void refresh().catch(report); });

async function close() {
  liveView?.close(); operationView?.close(); media?.close();
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
