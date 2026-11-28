import {mountReviewedMedia} from '../../shared/media/panel.mjs';
import {createSignalRequests} from '../../shared/helpers/signal-request.mjs';
import {mountDiagnosticsPanel,registerLifecycleFlush} from '../../shared/helpers/diagnostics-panel.mjs';
import {mountDevTelemetry} from '../../shared/helpers/dev-telemetry.mjs';
import { createOperationView } from '../../shared/helpers/operation-view.mjs';
import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { createLiveView, createViewStore, createApplicationBackend } from '@chronolog/peer-session/browser';
import { decodeRecord } from '@chronolog/authority';
import { authorityRecordBytes } from '@tendriller/core/authority';
import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { createSubmissionState } from '../../shared/helpers/submission-state.mjs';
import { forgetSnapshot, liveViewKey, persistedSnapshot } from '../../shared/helpers/persisted-view.mjs';
import { mountDevices } from '../../shared/helpers/devices-view.mjs';
import { mountFinality } from '../../shared/helpers/finality-view.mjs';
import { deriveNotes } from './domain.mjs';
const $ = selector => document.querySelector(selector);
const diagnostics=mountDiagnosticsPanel($('main')??document.body,{appName:'Shared notes'});
let telemetry,unregisterFlush;
const response = await fetch(new URL('./configuration.json', import.meta.url));
if (!response.ok) throw Error('Public application configuration is unavailable');
const configuration = await response.json(), profileId = browserProfileId(configuration.applicationId);
let storage, viewId, persistence = true;
try { storage = localStorage; viewId = sessionStorage.getItem(`${profileId}:view`) || crypto.randomUUID(); sessionStorage.setItem(`${profileId}:view`, viewId); }
catch { const map = new Map(); storage = { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; viewId = crypto.randomUUID(); persistence = false; }
const local = createViewStore({ storage, applicationId: configuration.applicationId, profileId, viewId });
const viewKey = liveViewKey(storage, profileId, 'notes');
const read = (key, fallback) => { try { return local.readDraft(key) ?? fallback; } catch { persistence = false; return fallback; } };
const save = (key, value) => { try { local.writeDraft(value, key); } catch { persistence = false; $('#draft-help').textContent = 'This browser could not persist the draft. Keep this page open or copy unsent text before leaving.'; } };
let editor = read('editor', { id: crypto.randomUUID(), isNew: true }), drafts = read('drafts', {}), intents = read('intents', {});
let attachment, session, live, devices, stopAdmission, notes = [], stale = false, hasSnapshot = false, inspectToken = 0;
let operationView, observedOperationId, media;
const nodes = new Map(), selectedId = () => { try { return new URLSearchParams(location.hash.slice(1)).get('note'); } catch { return null; } };
$('#note').value = drafts[editor.id] ?? ''; $('#editor-heading').textContent = editor.isNew ? 'New note' : 'Edit note';
$('#operation-id').value = read('selected-operation', '');
if (!persistence) $('#draft-help').textContent = 'Private browser storage is unavailable. This draft lasts only while the page remains open.';
const submission = createSubmissionState(state => {
  media?.setBlocked(!state.canSubmit);
  $('#submit').disabled = !state.canSubmit; $('#delete').disabled = !state.canSubmit || !notes.some(note => note.id === selectedId());
  $('#inspect').disabled = !state.canInspect; $('#retry').disabled = !state.canRetry;
  $('#submission-status').textContent = state.message;
});
submission.update({ selected: $('#operation-id').value, pending: intents[$('#operation-id').value] ?? null });
const report = error => { $('#operation-status').textContent = error.message ?? String(error); };
function retainEditor() { drafts[editor.id] = $('#note').value; save('drafts', drafts); save('editor', editor); }
$('#note').addEventListener('input', retainEditor);
function renderDetail() {
  const id = selectedId(), note = notes.find(item => item.id === id);
  $('#detail-text').textContent = note?.text ?? (!hasSnapshot ? 'The local snapshot is loading or unavailable. Your draft remains local; Save does not require this read.' : id ? `This note is absent from the ${stale ? 'last known (not current)' : 'current materialized'} snapshot. A late operation may change its outcome.` : 'Select a note to inspect it.');
  $('#detail-meta').textContent = note ? `Author ${note.author}. Proposal ${note.proposalId}. Author time ${note.authorTimestampMs}. ${stale ? 'Last snapshot, not current.' : 'Current local projection; revisable.'}` : '';
  $('#edit').disabled = !note;
  $('#delete').disabled = !note || !submission.snapshot.canSubmit;
  for (const [key, node] of nodes) node.link.setAttribute('aria-current', String(key === id));
}
function renderNotes(snapshot) {
  const focus = document.activeElement, x = scrollX, y = scrollY;
  notes = snapshot.value; hasSnapshot = true; stale = snapshot.stale === true; if (!stale) $('#view-error').hidden = true;
  const wanted = new Set(notes.map(note => note.id));
  for (const [id, node] of nodes) if (!wanted.has(id)) { node.item.remove(); nodes.delete(id); }
  for (const note of notes) {
    let node = nodes.get(note.id);
    if (!node) { const item = document.createElement('li'), link = document.createElement('a'); item.append(link); node = { item, link }; nodes.set(note.id, node); }
    const label = note.text.length > 180 ? note.text.slice(0, 180) + '…' : note.text;
    if (node.link.textContent !== label) node.link.textContent = label;
    const detailUrl = new URL(location.href); detailUrl.hash = 'note=' + encodeURIComponent(note.id); node.link.href = detailUrl.href;
    $('#notes').append(node.item);
  }
  $('#count').textContent = `${notes.length} ${notes.length === 1 ? 'note' : 'notes'} · local snapshot ${snapshot.revision.digest.slice(0, 12)} · ${stale ? 'saved on this device, refreshing' : 'revisable'}`;
  $('#empty').hidden = notes.length !== 0; renderDetail();
  if (focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
  scrollTo(x, y);
}
window.addEventListener('hashchange', renderDetail);
$('#new').addEventListener('click', () => { retainEditor(); editor = { id: crypto.randomUUID(), isNew: true }; save('editor', editor); $('#note').value = ''; $('#editor-heading').textContent = 'New note'; $('#note').focus(); });
$('#edit').addEventListener('click', () => { const note = notes.find(item => item.id === selectedId()); if (!note) return; retainEditor(); editor = { id: note.id, isNew: false }; save('editor', editor); $('#note').value = Object.hasOwn(drafts, note.id) ? drafts[note.id] : note.text; $('#editor-heading').textContent = 'Edit note'; retainEditor(); $('#note').focus(); });
function showFacts(inspection) {
  submission.update({ observed: inspection });
  const materialized = inspection.materialized, peerRetention = inspection.retained.filter(item => item.signer !== session.identity.publicKey);
  $('#operation-status').textContent = [
    `Operation: ${inspection.operationId || $('#operation-id').value}`,
    `Proposal: ${inspection.proposalId}`,
    `Stored locally: ${inspection.stored ? 'yes' : 'no'}`,
    `Materialized locally: ${materialized ? materialized.outcome + (materialized.rejectionCode ? ` (${materialized.rejectionCode})` : '') + ' — revisable at ' + materialized.revision.digest : inspection.excluded ? 'not executed — excluded by verified author-time evidence' : 'pending'}`,
    `Retained by peers: ${peerRetention.length ? peerRetention.map(item => item.signer).join(', ') : 'no authenticated evidence'}`,
    `Finalized: ${inspection.finalized ? 'yes' : 'no'}`,
    `Excluded: ${inspection.excluded ? 'yes — original signed intent remains inspectable' : 'no'}`,
    ...(inspection.pending ? [`Waiting for: ${inspection.pending}`] : []),
    ...(intents[inspection.operationId]?.input?.text ? [`Original reviewed text: ${intents[inspection.operationId].input.text}`] : []),
  ].join('\n');
}
function stopOperationObservation() { operationView?.close(); operationView = undefined; observedOperationId = undefined; }
function observeSelectedOperation() {
  const id = $('#operation-id').value;
  if (operationView && observedOperationId === id) return operationView;
  stopOperationObservation(); if (!session || !id) return;
  observedOperationId = id;
  operationView = createOperationView(session, { operationId: id,
    onChange({ inspection }) {
      if (id !== $('#operation-id').value) return;
      if (inspection) showFacts(inspection);
      else { submission.update({ observed: null }); $('#operation-status').textContent = 'No local signed proposal was found for this ID. Retry only its exact retained intent after an uncertain reply.'; }
    }, onError(error) { if (id === $('#operation-id').value) report(error); } });
  return operationView;
}
async function inspect() { await observeSelectedOperation()?.refresh(); }
$('#operation-id').addEventListener('input', () => { const id = $('#operation-id').value; ++inspectToken; save('selected-operation', id); submission.update({ selected: id, pending: intents[id] ?? null, observed: null }); observeSelectedOperation(); });
$('#inspect').addEventListener('click', () => { void inspect().catch(report); });
async function submitIntent(intent, retry = false) {
  const done = submission.begin(retry ? 'retry' : 'submit');
  intents[intent.operationId] = intent; save('intents', intents); save('selected-operation', intent.operationId);
  $('#operation-id').value = intent.operationId; submission.update({ selected: intent.operationId, pending: intent, observed: null });
  try {
    const retained = retry ? await session.operations.get(intent.operationId) : null;
    const operation = retained ? await session.operations.retry(intent.operationId) : await session.command(intent.command, intent.input, { operationId: intent.operationId });
    // Only the durable local acknowledgment can clear the exact draft that was sent.
    if (intent.command === 'putNote' && editor.id === intent.input.noteId && $('#note').value === intent.input.text) {
      $('#note').value = ''; drafts[editor.id] = ''; save('drafts', drafts);
    }
    diagnostics.update({lastStoredOperationId:intent.operationId}); showFacts(await operation.inspect()); observeSelectedOperation();
  } catch (error) { $('#operation-status').textContent = submission.failure(error, intent); }
  finally { done(); }
}
$('#form').addEventListener('submit', event => { event.preventDefault(); const text = $('#note').value.trim(); if (!text) return; retainEditor(); void submitIntent({ operationId: crypto.randomUUID(), command: 'putNote', input: { noteId: editor.id, text } }).catch(report); });
$('#delete').addEventListener('click', () => { const noteId = selectedId(); if (noteId) void submitIntent({ operationId: crypto.randomUUID(), command: 'deleteNote', input: { noteId } }).catch(report); });
$('#retry').addEventListener('click', () => { const id = $('#operation-id').value, intent = intents[id]; if (intent) void submitIntent(intent, true).catch(report); else void session.operations.retry(id).then(async operation => showFacts(await operation.inspect())).catch(report); });
$('#save-offline').addEventListener('click', async () => {
  try { $('#save-offline').disabled = true; const saved = await window.tendril.publication.saveOffline(); $('#offline-status').textContent = `Offline ready: complete immutable publication ${saved.id}. Local keys/data stay separate on this device.`; }
  catch (error) { $('#offline-status').textContent = `Not offline ready: ${error.message}`; }
  finally { $('#save-offline').disabled = false; }
});
let photoUrl;
$('#photo').addEventListener('change', () => { if (photoUrl) URL.revokeObjectURL(photoUrl); const file = $('#photo').files[0]; $('#photo-preview').hidden = !file; if (file) { photoUrl = URL.createObjectURL(file); $('#photo-preview').src = photoUrl; } $('#analysis-consent').checked = false; });
function viewError(error) { stale = true; $('#view-error').hidden = false; $('#view-error').textContent = `View not current: ${error.message}. The last snapshot and your draft are retained. Local Save remains independent of this read.`; $('#count').textContent = hasSnapshot ? `${notes.length} notes in last snapshot — not current` : 'Local snapshot unavailable — not an empty-data result.'; renderDetail(); }
async function connect() {
  $('#reconnect').hidden = true;
  try {
    attachment = await openBrowserOwner({
      workerUrl: new URL('./worker.mjs', import.meta.url),
      profileId,
      applicationId: configuration.applicationId,
      configuration,
      context: { viewId },
      timeoutMs: 30_000,
    });
    session = attachment.session;
    submission.update({ attached: true });
    let lastStatus = session.status, admissionState = null;
    const renderConnectionStatus = () => {
      if (!lastStatus) return;
      const accessLabel = lastStatus.canAuthor ? 'Local signing and storage ready'
        : admissionState?.phase === 'removed' ? 'This browser was removed (see Devices and access)'
        : admissionState?.phase === 'waiting-approval' ? 'Waiting for approval in strict mode (see Devices and access)'
        : admissionState?.phase === 'waiting-keys' ? 'Admitted; waiting for the latest page key (see Devices and access)'
        : submission.snapshot.readOnly ? 'Read-only access (admitted)'
        : 'This browser is not admitted yet (see Devices and access)';
      $('#connection-status').textContent = `${accessLabel} · ${lastStatus.connectedPeers} connected peers · database ${lastStatus.database}. Peer availability never gates Save on an admitted device.`;
    };
    session.onStatus(status => { lastStatus = status; submission.application(status); diagnostics.update({localOwnerStatus:'open',sessionStatus:{phase:status.phase,canAuthor:status.canAuthor,connectedPeers:status.connectedPeers}}); renderConnectionStatus(); });
    stopAdmission?.();
    stopAdmission = session.extensions?.subscribe?.(message => { if (message?.topic === 'admission' && message.state) { admissionState = message.state; if (admissionState.phase === 'removed') forgetSnapshot(viewKey, storage); submission.admission(admissionState); renderConnectionStatus(); } });
    void session.extensions?.call?.('admission.state', []).then(next => { if (next) { admissionState = next; submission.admission(admissionState); renderConnectionStatus(); } }).catch(() => {});

    window.tendril.application.install(createApplicationBackend(session));
  window.tendril.signals.install(session.signals);
  window.tendril.transport.install(session);
  telemetry=mountDevTelemetry({session,runtime:window.tendril});
  unregisterFlush=registerLifecycleFlush(()=>telemetry.sendSnapshot());
    devices = mountDevices({ root: $('#devices'), session, pageUrl: configuration.page_url, storage });
    mountFinality({ root: $('#finality-status').parentElement, session });
    // Every current snapshot is persisted for the next launch's first paint.
    live = createLiveView(session, deriveNotes, { onError: viewError, persistKey: viewKey, storage });
    live.subscribe(renderNotes);
    media=mountReviewedMedia({container:$('#media-panel'),session,runtime:window.tendril,inferenceParticipantKey:configuration.optionalAnalysisPeer,
      getContext:()=>live.snapshot?{revision:live.snapshot.revision,collection:'shared-notes'}:{viewCurrent:false},
      blocked:!submission.snapshot.canSubmit,prepareCommit:prepareEvidence,commit:commitEvidence,
      onVoiceDraft:text=>{$('#note').value=[$('#note').value,text].filter(Boolean).join('\n');retainEditor();}});
    window.appRequests=createSignalRequests(session,{peer:configuration.optionalAnalysisPeer});
    // Metadata/finality labels refresh in background, never before local open.
    void window.tendril.host.peers.application().then(metadata => { if (metadata.authority) $('#finality-status').textContent = `Configured finality: ${decodeRecord(authorityRecordBytes(metadata.authority)).descriptor.payload.finalityPolicy.kind}. No-finality remains fully local-first. A configured but unavailable finalizer never blocks Save.`; }).catch(() => { $('#finality-status').textContent = 'Remote policy refresh unavailable. Retained local authoring remains independent.'; });
    try { await live.ready({ timeoutMs: 30_000 }); } catch (error) { viewError(error); }
    window.tendril.ready();
    if ($('#operation-id').value) void inspect().catch(report);
  } catch (error) { $('#connection-status').textContent = `Local session could not open: ${error.message}. Retain this browser profile and original work.`; $('#reconnect').hidden = false; }
}
$('#reconnect').addEventListener('click', () => { if (session) location.reload(); else void connect(); });
// Stale-while-revalidate first paint: this device's last snapshot, before the Worker opens.
{ const saved = persistedSnapshot(viewKey, storage); if (saved) renderNotes(saved); }
window.addEventListener('pagehide', event => { stopOperationObservation(); retainEditor(); if (event.persisted) void attachment?.suspend().catch(report); else { telemetry?.close(); unregisterFlush?.(); media?.close(); window.appRequests?.close(); live?.close(); stopAdmission?.(); devices?.close(); void attachment?.detach().catch(() => {}); } });
window.addEventListener('pageshow', event => { if (event.persisted) void attachment?.resume().then(() => { observeSelectedOperation(); return live?.refresh(); }).catch(report); });
void connect();

// Media is staged only after an explicit reviewed Save (or separately consented
// analysis). Its exact semantic intent is retained before dispatch, like edits.
async function prepareEvidence({candidate,reviewed,operationId,signal}) {
 signal.throwIfAborted();const text=reviewed.text?.trim();if(!text||text.length>2000)throw Error('Review an observation of 1–2000 characters');
 let source=reviewed.source;
 if(!source){const bytes=new Uint8Array(await candidate.blob.arrayBuffer());signal.throwIfAborted();const upload=await session.content.stage({bytes:bytes.length,mediaType:candidate.type});for(let offset=0;offset<bytes.length;offset+=65536){signal.throwIfAborted();await upload.write(offset/65536,bytes.slice(offset,offset+65536));}source={candidateId:candidate.id,sha256:candidate.sha256,reference:await upload.commit()};}
 if(source.candidateId!==candidate.id||source.sha256!==candidate.sha256||source.reference.applicationId!==session.applicationId)throw Error('Reviewed content belongs to another candidate or application');
 const capturedRevision=JSON.stringify(candidate.context?.revision??{viewCurrent:false});if(capturedRevision.length>16384)throw Error('Captured revision exceeds the reviewed input bound');
 const intent={operationId,command:'addEvidence',input:{noteId:operationId,text,source,capturedRevision}};intents[operationId]=intent;save('intents',intents);save('selected-operation',operationId);$('#operation-id').value=operationId;submission.update({selected:operationId,pending:intent,observed:null});
}
async function commitEvidence({candidate,reviewed,operationId,signal}) {
 signal.throwIfAborted();const intent=intents[operationId];if(intent?.command!=='addEvidence'||intent.input.source.candidateId!==candidate.id||intent.input.source.sha256!==candidate.sha256||intent.input.text!==reviewed.text.trim())throw Error('Inspect the original prepared evidence intent');
 const done=submission.begin('submit');try{const previous=await session.operations.get(operationId),operation=previous?await session.operations.retry(operationId):await session.command(intent.command,intent.input,{operationId});const inspection=await operation.inspect();showFacts(inspection);observeSelectedOperation();diagnostics.update({lastStoredOperationId:operationId});return{stored:true,operationId,materialized:inspection.materialized};}finally{done();}
}
