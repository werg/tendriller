import {mountDiagnosticsPanel,registerLifecycleFlush} from '../../shared/helpers/diagnostics-panel.mjs';
import {mountDevTelemetry} from '../../shared/helpers/dev-telemetry.mjs';
import { createOperationView } from '../../shared/helpers/operation-view.mjs';
import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { createLiveView, createViewStore, createApplicationBackend } from '@chronolog/peer-session';
import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { createSubmissionState } from '../../shared/helpers/submission-state.mjs';
import { mountDevices } from '../../shared/helpers/devices-view.mjs';
import { mountFinality } from '../../shared/helpers/finality-view.mjs';
import { deriveInventory } from './domain.mjs';
const $ = id => document.querySelector(id);
const diagnostics = mountDiagnosticsPanel($('main') ?? document.body, { appName: 'Shared inventory' });
let telemetry, unregisterFlush;
const configuration = await fetch(new URL('./configuration.json', import.meta.url)).then(response => { if (!response.ok) throw Error('Configuration unavailable'); return response.json(); });
const profileId = browserProfileId(configuration.applicationId);
let storage, viewId;
try { storage = localStorage; viewId = sessionStorage.getItem(`${profileId}:view`) || crypto.randomUUID(); sessionStorage.setItem(`${profileId}:view`, viewId); }
catch { const map = new Map(); storage = { get length() { return map.size; }, key: i => [...map.keys()][i], getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; viewId = crypto.randomUUID(); }
const local = createViewStore({ storage, applicationId: configuration.applicationId, profileId, viewId });
const read = (key, fallback) => { try { return local.readDraft(key) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { local.writeDraft(value, key); } catch { $('#result').textContent = 'Draft/reference storage failed. Copy unsent fields and the original operation ID before leaving this page.'; } };
const draftIds = ['from', 'to', 'units', 'expected-source', 'expected-destination', 'bin-id', 'bin-units', 'bin-expected', 'bin-label', 'sql-grantee', 'author-time'];
const draft = read('draft', {}); for (const id of draftIds) if ($('#' + id)) { $('#' + id).value = draft[id] ?? ''; $('#' + id).addEventListener('input', () => { draft[id] = $('#' + id).value; save('draft', draft); }); }
const intents = read('intents', {}); $('#op-id').value = read('selected-operation', '');
let session, attachment, live, devices, snapshot, stale = false, inspectionToken = 0;
let operationView, observedOperationId;
const nodes = new Map();
const selected = () => new URLSearchParams(location.hash.slice(1)).get('bin');
const submission = createSubmissionState(state => { for (const button of document.querySelectorAll('[data-write]')) button.disabled = !state.canSubmit; $('#inspect').disabled = !state.canInspect; $('#retry').disabled = !state.canRetry; $('#submission-status').textContent = state.message; });
submission.update({ selected: $('#op-id').value, pending: intents[$('#op-id').value] ?? null });
function renderDetail() {
  const id = selected(), bin = snapshot?.value.stock.find(row => row.id === id);
  $('#bin-detail').textContent = bin ? `${bin.id}: ${bin.units} units${bin.label !== undefined ? ` · label ${bin.label || '(empty)'}` : ''}. ${stale ? 'Last snapshot, not current.' : 'Current local projection, revisable.'}` : id ? 'The selected stable bin ID is absent from this projection.' : 'Select a bin to inspect its current balance.';
}
function render(value) {
  snapshot = value; stale = false; $('#view-error').hidden = true;
  const active = document.activeElement, x = scrollX, y = scrollY, wanted = new Set(value.value.stock.map(row => row.id));
  for (const [id, node] of nodes) if (!wanted.has(id)) { node.row.remove(); nodes.delete(id); }
  for (const bin of value.value.stock) {
    let node = nodes.get(bin.id);
    if (!node) { const row = document.createElement('tr'), idCell = document.createElement('td'), link = document.createElement('a'), units = document.createElement('td'), label = document.createElement('td'); idCell.append(link); row.append(idCell, units, label); node = { row, link, units, label }; nodes.set(bin.id, node); }
    node.link.textContent = bin.id; const detailUrl = new URL(location.href); detailUrl.hash = 'bin=' + encodeURIComponent(bin.id); node.link.href = detailUrl.href; node.units.textContent = String(bin.units); node.label.textContent = bin.label ?? ''; node.label.hidden = !value.value.hasLabel; $('#stock').append(node.row);
  }
  $('#label-heading').hidden = !value.value.hasLabel; $('#label-editor').hidden = !value.value.hasLabel;
  $('#summary').textContent = `${value.value.stock.length} bins · ${value.value.stock.reduce((sum, row) => sum + row.units, 0)} total units · local snapshot ${value.revision.digest.slice(0, 12)} (revisable)`;
  $('#schema').textContent = `Current columns: ${value.value.columns.join(', ')}. Catalog: ${value.value.catalog.map(item => `${item.name} (${item.type})`).join(', ')}`;
  $('#receipts').replaceChildren(...value.value.transfers.map(receipt => { const item = document.createElement('li'); item.textContent = `${receipt.units} units: ${receipt.from} → ${receipt.to}. Stable receipt ${receipt.id}.`; return item; }));
  renderDetail(); if (active?.isConnected && active !== document.activeElement) active.focus({ preventScroll: true }); scrollTo(x, y);
}
window.addEventListener('hashchange', renderDetail);
function show(inspection) {
  submission.update({ observed: inspection });
  const peerRetention = inspection.retained.filter(item => item.signer !== session.identity.publicKey);
  $('#result').textContent = `Operation ${inspection.operationId}\nProposal ${inspection.proposalId}\nStored locally: ${inspection.stored}\nMaterialized locally: ${inspection.materialized ? inspection.materialized.outcome + (inspection.materialized.rejectionCode ? ` (${inspection.materialized.rejectionCode})` : '') + ' — revisable' : inspection.excluded ? 'not executed — excluded by verified author-time evidence' : 'pending'}\nRetained by peers: ${peerRetention.length ? peerRetention.map(row => row.signer).join(', ') : 'no evidence'}\nFinalized: ${inspection.finalized}\nExcluded: ${inspection.excluded}\n${inspection.pending ? `Waiting for ${inspection.pending}` : ''}`;
}
function stopOperationObservation() { operationView?.close(); operationView = undefined; observedOperationId = undefined; }
function observeSelectedOperation() {
  const id = $('#op-id').value;
  if (operationView && observedOperationId === id) return operationView;
  stopOperationObservation(); if (!session || !id) return;
  observedOperationId = id;
  operationView = createOperationView(session, { operationId: id,
    onChange({ inspection }) {
      if (id !== $('#op-id').value) return;
      if (inspection) show(inspection);
      else { submission.update({ observed: null }); $('#result').textContent = 'No local signed proposal was found for this ID. Retry only its exact retained intent after an uncertain reply.'; }
    }, onError(error) { if (id === $('#op-id').value) report(error); } });
  return operationView;
}
async function inspect() { await observeSelectedOperation()?.refresh(); }
const report = error => { $('#result').textContent = error.message ?? String(error); };
async function command(name, input, intent = undefined) {
  const done = submission.begin(intent ? 'retry' : 'submit');
  try {
    if (!intent) {
      const authorTime = $('#author-time')?.value;
      if (authorTime && !/^(?:0|[1-9][0-9]{0,18})$/.test(authorTime)) throw Error('Author time must be an exact nonnegative int64');
      intent = { operationId: crypto.randomUUID(), command: name, input, ...(authorTime ? { authorTimestampMs: authorTime } : {}) };
      intents[intent.operationId] = intent; save('intents', intents);
    }
    $('#op-id').value = intent.operationId; save('selected-operation', intent.operationId); submission.update({ selected: intent.operationId, pending: intent, observed: null });
    const retained = await session.operations.get(intent.operationId);
    const operation = retained ? await session.operations.retry(intent.operationId) : await session.command(intent.command, intent.input, { operationId: intent.operationId, ...(intent.authorTimestampMs ? { authorTimestampMs: BigInt(intent.authorTimestampMs) } : {}) });
    diagnostics.update({lastStoredOperationId:intent.operationId}); show(await operation.inspect()); observeSelectedOperation();
  } catch (error) { $('#result').textContent = submission.failure(error, intent); }
  finally { done(); }
}
const number = id => { if ($('#' + id).value === '') throw Error(`Enter the reviewed ${id.replaceAll('-', ' ')}`); const value = Number($('#' + id).value); if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw Error('Units must be an integer between 0 and 1000000'); return value; };
const action = callback => event => { event.preventDefault(); try { Promise.resolve(callback(event)).catch(report); } catch (error) { report(error); } };
$('#review-balances').addEventListener('click', action(() => {
  const from = snapshot?.value.stock.find(row => row.id === $('#from').value), to = snapshot?.value.stock.find(row => row.id === $('#to').value);
  if (!from || !to) throw Error('Both selected bins must be present in your last local snapshot to copy balances; you may instead type the balances you reviewed.');
  $('#expected-source').value = String(from.units); $('#expected-destination').value = String(to.units);
  for (const id of ['expected-source', 'expected-destination']) draft[id] = $('#' + id).value; save('draft', draft);
}));
$('#transfer').addEventListener('submit', action(() => command('transfer', { transferId: crypto.randomUUID(), from: $('#from').value, to: $('#to').value, units: number('units'), expectedSource: number('expected-source'), expectedDestination: number('expected-destination') })));
$('#bin-form').addEventListener('submit', action(event => {
  const id = $('#bin-id').value, selectedAction = event.submitter?.value ?? 'add';
  if (selectedAction === 'add') return command('addBin', { id, units: number('bin-units') });
  if (selectedAction === 'label') return command('setLabel', { id, label: $('#bin-label').value });
  return command(selectedAction === 'delete' ? 'deleteBin' : 'setUnits', { id, expectedUnits: number('bin-expected'), ...(selectedAction === 'edit' ? { units: number('bin-units') } : {}) });
}));
$('#initialize').addEventListener('click', action(() => command('initialize', null)));
$('#add-labels').addEventListener('click', action(() => command('addLabels', null)));
$('#sql-grant').addEventListener('click', action(() => command('grantBinWrites', { publicKey: $('#sql-grantee').value })));
$('#op-id').addEventListener('input', () => { ++inspectionToken; const id = $('#op-id').value; save('selected-operation', id); submission.update({ selected: id, pending: intents[id] ?? null, observed: null }); observeSelectedOperation(); });
$('#inspect').addEventListener('click', action(inspect));
$('#retry').addEventListener('click', action(async () => { const id = $('#op-id').value, intent = intents[id]; if (intent) return command(intent.command, intent.input, intent); const operation = await session.operations.retry(id); diagnostics.update({lastStoredOperationId:operation.operationId}); show(await operation.inspect()); observeSelectedOperation(); }));
$('#offline').addEventListener('click', action(async () => { $('#offline-status').textContent = 'Saving and verifying the complete immutable application and engine graph…'; try { const value = await window.tendril.publication.saveOffline(); $('#offline-status').textContent = `Offline ready: publication ${value.id}. Local identity, keys and operation history are separate retained device state.`; } catch (error) { $('#offline-status').textContent = `Not offline ready: ${error.message}`; } }));
try {
  attachment = await openBrowserOwner({ workerUrl: new URL('./worker.mjs', import.meta.url), profileId, applicationId: configuration.applicationId, requiresDedicatedWorker: true, context: { viewId }, timeoutMs: 30_000 });
  session = attachment.session;
  submission.update({ attached: true });
  session.onStatus(status => { submission.application(status); diagnostics.update({localOwnerStatus:'open',sessionStatus:{phase:status.phase,canAuthor:status.canAuthor,connectedPeers:status.connectedPeers}}); $('#session-status').textContent = `${status.canAuthor ? 'Local signing/storage ready' : 'Not admitted yet (see Devices and access)'} · ${status.connectedPeers} peers · SQL ${status.database}. Stored submission does not wait for peers or a read.`; });

  window.tendril.application.install(createApplicationBackend(session));
  window.tendril.signals.install(session.signals);
  window.tendril.transport.install(session);
  telemetry=mountDevTelemetry({session,runtime:window.tendril});
  unregisterFlush=registerLifecycleFlush(()=>telemetry.sendSnapshot());
  devices = mountDevices({ root: $('#devices'), session, pageUrl: configuration.page_url, storage }); mountFinality({ root: $('#finality'), session });
  const viewError = error => { stale = true; $('#view-error').hidden = false; $('#view-error').textContent = `View not current: ${error.message}. The last snapshot and your local drafts are retained. On a fresh app, create the initial tables with the ordinary transaction button; storing that intent does not wait for this read.`; $('#summary').textContent = snapshot ? `${snapshot.value.stock.length} bins in last snapshot — not current` : 'No current domain snapshot; schema may not exist yet.'; renderDetail(); };
  live = createLiveView(session, deriveInventory, { onError: viewError });
  live.subscribe(render);
  try { await live.ready({ timeoutMs: 30_000 }); } catch (error) { viewError(error); }
  window.tendril.ready();
  if ($('#op-id').value) void inspect().catch(report);
} catch (error) { $('#session-status').textContent = `Local opening failed: ${error.message}. Preserve this browser's private identity/store and reload after fixing its named prerequisite.`; }
window.addEventListener('pagehide', event => { stopOperationObservation(); if (event.persisted) void attachment?.suspend().catch(report); else { telemetry?.close(); unregisterFlush?.(); live?.close(); devices?.close(); void attachment?.detach().catch(() => {}); } });
window.addEventListener('pageshow', event => { if (event.persisted) void attachment?.resume().then(() => { observeSelectedOperation(); return live?.refresh(); }).catch(report); });
