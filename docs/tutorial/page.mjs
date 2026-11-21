import { browserProfileId } from './helpers/browser-profile.mjs';
import { openBrowserOwner } from '@tendriller/core/collaboration/browser';
import { createViewStore, operationReference } from '@tendriller/core/collaboration';
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';
import { createSubmissionState } from './helpers/submission-state.mjs';
import { createLiveView } from './helpers/live-view.mjs';
import { createSignalRequests } from './helpers/signal-request.mjs';
import { createOperationView } from './helpers/operation-view.mjs';
import { mountReviewedMedia } from './media/panel.mjs';
import { createBrowserPairing } from './pairing-browser.mjs';
import { createOwnerConnection, reloadOnOwnerReplaced } from './connection.mjs';
import { mountConnectionView } from './connect-view.mjs';

const $ = selector => document.querySelector(selector);
const configuration = await fetch(new URL('./configuration.json', import.meta.url)).then(response => response.json());
const profileId = browserProfileId(configuration.applicationId);
const pairing = createBrowserPairing({ configuration, profileId,
  workerUrl: new URL(configuration.pairingWorkerUrl || './pairing-worker.mjs', import.meta.url) });
const viewKey = `${profileId}:view`;
let viewId = sessionStorage.getItem(viewKey) || crypto.randomUUID();
sessionStorage.setItem(viewKey, viewId);
let viewStore = createViewStore({ storage: localStorage, applicationId: configuration.applicationId, profileId, viewId });
const readLocal = name => viewStore.readDraft(name);
const writeLocal = (name, value) => viewStore.writeDraft(value, name);
function retainedPending() {
  const references = viewStore.pending(), selected = readLocal('operation');
  const retained = references.find(item => item.reference.operationId === selected) ?? references[0];
  return retained ? { ...retained.context, id: retained.reference.operationId, reference: retained.reference } : null;
}
let attachment, session, liveView, operationView, observedOperation, media;
const submission = createSubmissionState(renderSubmission);
function renderSubmission(state) {
  $('#submit').disabled = !state.canSubmit;
  $('#inspect').disabled = !state.canInspect;
  $('#retry').disabled = !state.canRetry;
  $('#reapply').disabled = !state.canReapply;
  $('#refresh').disabled = !state.attached || state.working;
  $('#submission-status').textContent = state.message;
  $('#form').setAttribute('aria-busy', String(state.working));
  media?.setBlocked(!state.canSubmit);
}
let pending = retainedPending();
const report = error => { $('#result').textContent = error.message ?? String(error); };
const operationStatus = document.createElement('p');
operationStatus.id = 'operation-status'; operationStatus.setAttribute('role', 'status');
$('#result').before(operationStatus);
$('#note').value = readLocal('draft') ?? '';
$('#operation-id').value = readLocal('operation') ?? '';
if (pending) {
  $('#operation-id').value = pending.id;
  $('#result').textContent = `Unresolved operation ${pending.id}. Inspect or retry its original identity before submitting another note.`;
}
$('#note').addEventListener('input', () => writeLocal('draft', $('#note').value));
$('#operation-id').addEventListener('input', () => {
  writeLocal('operation', $('#operation-id').value);
  submission.update({ selected: $('#operation-id').value, observed: null });
});
submission.update({ pending, selected: $('#operation-id').value });

function savePending(value) {
  // Each view owns its reference to the common signed journal. Removing this
  // reference cannot erase another view's pending command or draft.
  const previous = pending;
  if (value) {
    const reference = { applicationId: session.applicationId, historyId: session.historyId,
      author: session.deviceId, operationId: value.id };
    const { reference: ignored, ...context } = value;
    viewStore.retainOperation(reference, context);
    pending = { ...value, reference };
  } else pending = null;
  if (previous?.reference && previous.id !== value?.id) viewStore.removeOperation(previous.reference);
  submission.update({ pending, selected: $('#operation-id').value, observed: null });
}
function retainObservedReference(state) {
  if (!state || pending?.id !== state.operationId) return;
  const reference = operationReference(session, pending.id, state);
  if (reference.author !== pending.reference.author || reference.historyId !== pending.reference.historyId)
    throw Error('The observed operation does not belong to this retained signer and history.');
  const { reference: ignored, ...context } = pending;
  viewStore.retainOperation(reference, context);
  pending = { ...pending, reference };
}
function beginSubmission() { return submission.begin(); }
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
      retainObservedReference(state);
      if (id === submission.snapshot.selected) submission.update({ observed: state });
      acceptedOrRejected(state);
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

// Attach to this browser's device owner and mount the app. Errors keep their code;
// createOwnerConnection decides whether to set the browser up, wait or retry.
async function connectSession({ signal } = {}) {
  let installed = false;
  try {
    const identity = window.tendril?.identity;
    attachment = await openBrowserOwner({ workerUrl: new URL(configuration.ownerWorkerUrl || './worker.mjs', import.meta.url),
      profileId, applicationId: configuration.applicationId, definitionId: 'shared-notes', definitionVersion: '2',
      signal, timeoutMs: 30_000, context: { viewId, ...(identity?.documentPath ? { documentPath: identity.documentPath } : {}),
        ...(identity?.publication ? { publicationId: identity.publication } : {}) },
      // Another tab or a page update took over this tab's route: reconnect.
      onOwnerReplaced: (() => {
        const reconnect = reloadOnOwnerReplaced({ onSkipped() { $('#result').textContent = 'The connection moved to another tab. Reload to continue here.'; } });
        return () => { submission.update({ attached: false, coherent: false }); reconnect(); };
      })(),
    });
    signal?.throwIfAborted();
    session = attachment.session; $('#device-key').value = session.deviceId;
    if (pending?.reference && (pending.reference.author !== session.deviceId || pending.reference.historyId !== session.historyId))
      throw Error('The retained operation belongs to a different signer or history. Reopen its original owner to inspect it.');
    if (session.endpoint.context.viewId !== viewId) {
      const offeredDraft = $('#note').value;
      viewId = session.endpoint.context.viewId; sessionStorage.setItem(viewKey, viewId);
      viewStore = createViewStore({ storage: localStorage, applicationId: configuration.applicationId, profileId, viewId });
      pending = retainedPending(); $('#note').value = readLocal('draft') ?? ''; $('#operation-id').value = readLocal('operation') ?? '';
      submission.update({ pending, selected: $('#operation-id').value, observed: null });
      if (offeredDraft) {
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy the other view’s draft';
        copy.addEventListener('click', () => { $('#note').value = offeredDraft; writeLocal('draft', offeredDraft); copy.remove(); });
        $('#result').before(copy);
      }
    }
    if (!window.tendril) throw Error('Open the published Tendriller page to install its runtime binding.');
    liveView = createLiveView(session, { query: 'notes', input: null,
      onStatus(status) { submission.application(status); $('#data-status').textContent = `Data: ${status.database}; application: ${status.phase}`; },
      onRecovery(notice) {
        submission.update({ coherent: false });
        $('#recovery').hidden = false;
        $('#recovery').textContent = `Selected history changed. ${notice.abandoned.length} known operations were excluded; unknown loss: ${notice.unknownLoss}. Inspect the original operation before deciding whether to submit new work.`;
      }, onError(error) { submission.update({ coherent: false }); report(error); },
    });
    liveView.subscribe(snapshot => { renderNotes(snapshot); submission.read(snapshot); });
    media = mountReviewedMedia({ container: $('#media-panel'), session, runtime: window.tendril,
      nativeDeviceId: configuration.nativeDeviceId,
      getContext: () => liveView.snapshot ? { revision: liveView.snapshot.revision, collection: 'shared-notes' } : null,
      prepareCommit: prepareEvidence, commit: submitEvidence, blocked: !submission.snapshot.canSubmit,
      onVoiceDraft(text) {
        $('#note').value = [$('#note').value, text].filter(Boolean).join('\n');
        writeLocal('draft', $('#note').value);
      },
    });
    session.participation.onStatus(status => {
      const wasConnected = submission.snapshot.connected;
      submission.participation(status);
      if (!wasConnected && submission.snapshot.connected) void refresh().catch(report);
      $('#peer-status').textContent = `Connection: ${status.phase}${status.error ? ` (${status.error})` : ''}.`;
    });
    if ($('#operation-id').value) observeOperation($('#operation-id').value);
    submission.update({ attached: true }); $('#close').disabled = false;
    // On-demand answers from the native participant (not retained in the journal).
    window.appRequests = createSignalRequests(session, { peer: configuration.nativeDeviceId });
    // The draft editor is usable now; the submission state gates every action until reads succeed.
    $('#app-content').hidden = false;
    // The query activates data. Status observation handles later key delivery.
    await liveView.ready({ signal, timeoutMs: 30_000 });
    signal?.throwIfAborted();
    // The runtime binding installs once per page, so only after the app is usable.
    window.tendril.application.install(createApplicationBackend({ id: session.applicationId, session }));
    window.tendril.signals.install(session.signals);
    installed = true;
  } catch (error) {
    if (!installed) {
      liveView?.close(); operationView?.close(); media?.close(); window.appRequests?.close();
      operationView = undefined; observedOperation = undefined;
      try { await attachment?.detach(); } catch { /* Preserve the setup failure. */ }
      session = attachment = liveView = undefined;
      submission.update({ attached: false, coherent: false }); $('#close').disabled = true; $('#app-content').hidden = true;
    }
    throw error;
  }
}

$('#form').addEventListener('submit', async event => {
  event.preventDefault();
  let release, original;
  try {
    release = beginSubmission();
    const text = $('#note').value.trim();
    if (!text) throw Error('Write a note first.');
    if (text.length > 2000) throw Error('Edit the note to 2,000 characters or fewer before saving. Nothing was submitted.');
    const before = await refresh();
    if (!submission.snapshot.available) throw Error('Connection changed while reading notes.');
    const operationId = crypto.randomUUID();
    // Save the reference before submitting. This is a UI reference, not a
    // second delivery queue; Chronolog owns and retries the signed attempt.
    $('#operation-id').value = operationId; writeLocal('operation', operationId);
    savePending({ id: operationId, command: 'addNote', input: { text }, basedOn: before.revision });
    original = pending;
    const operation = await session.command('addNote', { text }, { operationId, basedOn: before.revision });
    observeOperation(operationId, operation);
    $('#result').textContent = `Saved locally as ${operationId}. Waiting for applied execution…`;
    const result = await operation.applied({ signal: AbortSignal.timeout(15_000) });
    $('#result').textContent = `Applied: ${result.outcome}. Operation ${operationId}. Retained coverage is separate; explicit recovery can exclude applied work.`;
    acceptedOrRejected(result);
    await refresh();
  } catch (error) { report(Error(original && pending?.id !== original.id
    ? `${error.message} Operation ${original.id} already resolved; inspect its applied outcome. Your current draft is retained.`
    : submission.failure(error, original ?? pending))); }
  finally { release?.(); }
});

async function prepareEvidence({ candidate, reviewed, operationId, signal }) {
  signal.throwIfAborted();
  const text = reviewed.text?.trim(), capturedRevision = JSON.stringify(candidate.context.revision);
  if (!text || text.length > 2000) throw Error('A reviewed observation must contain 1–2,000 characters. Nothing was submitted.');
  if (!capturedRevision || capturedRevision.length > 16384) throw Error('The captured revision exceeds this example’s input limit. Nothing was submitted.');
  const release = beginSubmission();
  try {
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
    if (!submission.snapshot.available) throw Error('Connection changed during evidence preparation. Nothing was submitted.');
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
    if (!submission.snapshot.canInspect) throw Error('Connect and select an operation to inspect.');
    const { inspection } = await observeOperation($('#operation-id').value).refresh();
    $('#result').textContent = JSON.stringify({
      ...(pending?.id === $('#operation-id').value ? { command: commandOf(pending), reviewedInput: inputOf(pending) } : {}),
      inspection,
    }, null, 2);
    acceptedOrRejected(inspection?.state);
    submission.update({ observed: inspection?.state });
  }
  catch (error) { report(error); }
});
$('#retry').addEventListener('click', async () => {
  let release;
  try {
    release = submission.begin('retry');
    const id = pending.id;
    const original = await session.operations.get(id);
    retainObservedReference(original);
    if (!original && pending?.id === id) {
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
  finally { release?.(); }
});
$('#reapply').addEventListener('click', async () => {
  let release;
  try {
    release = submission.begin('reapply');
    const previous = pending;
    const before = await refresh();
    const inspected = await session.operations.get(previous.id);
    if (!['abandoned', 'needsReapply'].includes(inspected?.status)) throw Error('The original operation is no longer eligible for reviewed reapplication.');
    if (!submission.snapshot.available) throw Error('Connection changed while reviewing reapplication.');
    const id = crypto.randomUUID();
    savePending({ id, command: commandOf(previous), input: inputOf(previous), basedOn: before.revision,
      reapplies: previous.id, originOperationId: previous.originOperationId ?? previous.reapplies ?? previous.id });
    $('#operation-id').value = id; submission.update({ selected: id }); writeLocal('operation', id);
    const operation = await session.reapply(previous.id, commandOf(previous), inputOf(previous), { operationId: id, basedOn: before.revision });
    observeOperation(id, operation);
    const result = await operation.applied({ signal: AbortSignal.timeout(15_000) });
    $('#result').textContent = JSON.stringify(result, null, 2); acceptedOrRejected(result); await refresh();
  } catch (error) { report(error); }
  finally { release?.(); }
});
$('#refresh').addEventListener('click', () => { void refresh().catch(report); });

async function close() {
  connection.close();
  window.appRequests?.close();
  submission.update({ attached: false, connected: false, coherent: false });
  liveView?.close(); operationView?.close(); media?.close();
  try { await attachment?.detach(); }
  finally { $('#close').disabled = true;
    $('#app-content').hidden = true; view.render({ phase: 'failed', title: 'Connection closed', detail: 'Reload to reconnect this browser.',
      action: { label: 'Reconnect', run: () => location.reload() } }); }
}
$('#close').addEventListener('click', () => { void close().catch(report); });
window.addEventListener('pagehide', event => {
  if (event.persisted) { submission.update({ connected: false, coherent: false }); void attachment?.suspend().catch(report); }
  else void close().catch(() => {});
});
window.addEventListener('pageshow', event => {
  if (event.persisted && attachment) void attachment.resume().then(() => refresh()).catch(report);
});
const view = mountConnectionView($('#connection-slot'));
const connection = createOwnerConnection({ configuration, pairing, connect: connectSession, appName: 'Shared notes',
  onState(state) {
    view.render(state);
    const key = pairing.read()?.publicKey; if (key && !$('#device-key').value) $('#device-key').value = key;
  } });
void connection.start();
