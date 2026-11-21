import { openBrowserOwner, createBrowserIdentity } from '@tendriller/core/browser-owner';
import { createLiveView, createViewStore, describeOperationLifecycle } from '@chronolog/peer-session/browser';
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';
import { mountDiagnosticsPanel } from '../helpers/diagnostics-panel.mjs';
import { createSubmissionState } from '../helpers/submission-state.mjs';
import { transferIntent, checkIntentSession, retryIntent } from './ui-state.mjs';

const $ = selector => document.querySelector(selector);
const diagnostics = mountDiagnosticsPanel($('#diagnostics-slot'), { appName: 'Shared Inventory (SQL)' });
let session, attachment, liveView, store, pending, options, working = false;
const report = error => { $('#result').textContent = error.message ?? String(error); };
const submission = createSubmissionState(state => {
  $('#submit-transfer').disabled = !state.canSubmit;
  $('#retry-op').disabled = !state.canRetry;
  $('#inspect-op').disabled = !state.canInspect;
  $('#refresh').disabled = !state.attached || state.working;
  for (const id of ['from-loc', 'to-loc', 'qty']) $('#' + id).disabled = Boolean(state.pending) || state.working;
  $('#operation-status').textContent = state.pending ? `Retained ${state.pending.id}. Inspect or retry the original reviewed transfer.`
    : state.canSubmit ? 'Ready to review and transfer units.' : 'Waiting for connection and a coherent inventory read.';
});
function retain(intent) {
  const reference = { applicationId: session.applicationId, historyId: session.historyId,
    author: session.deviceId, operationId: intent.id };
  store.retainOperation(reference, intent); // Failure must prevent sending.
  pending = { ...intent, reference };
  $('#op-id').value = intent.id;
  submission.update({ pending, selected: intent.id, observed: null });
}
function showState(state) {
  const id = $('#op-id').value;
  $('#result').textContent = JSON.stringify({ reviewed: pending, summary: describeOperationLifecycle(id, state), state }, null, 2);
  submission.update({ observed: state });
  if (state?.status === 'applied' && pending?.id === state.operationId) {
    if (state.outcome === 'accepted') diagnostics.update({ lastAppliedOperationId: state.operationId });
    store.removeOperation(pending.reference); pending = null;
    submission.update({ pending });
  }
}
function renderStock(snapshot) {
  $('#revision-label').textContent = `Generation ${snapshot.revision.generation.slice(0, 12)} · seq ${snapshot.revision.sequence}`;
  const tbody = $('#stock-rows'); tbody.replaceChildren();
  for (const row of snapshot.value.stock) {
    const tr = document.createElement('tr');
    for (const value of [row.id, String(row.units)]) {
      const td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  if (!snapshot.value.stock.length) {
    const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 2;
    td.textContent = 'No bins yet. Run npm run demo in the native SQL project, then refresh.'; tr.appendChild(td); tbody.appendChild(tr);
  }
  submission.read(snapshot);
}
async function boot() {
  const response = await fetch(new URL('./configuration.json', import.meta.url));
  if (!response.ok) throw Error('Missing configuration.json. Run npm run init and npm run build, then publish page/.');
  const configuration = await response.json();
  if (new URL(configuration.page_url).origin !== location.origin)
    throw Error('Open the signed published page at its authorized origin. A local preview cannot use its account or device.');
  const profileId = `tendriller-inventory-${configuration.applicationId}`;
  const viewKey = `${profileId}:sql-view`;
  let viewId = sessionStorage.getItem(viewKey) || crypto.randomUUID(); sessionStorage.setItem(viewKey, viewId);
  const loadStore = () => {
    store = createViewStore({ storage: localStorage, applicationId: configuration.applicationId, profileId, viewId });
    const saved = store.pending()[0]; pending = saved ? { ...saved.context, reference: saved.reference } : null;
    if (pending) {
      $('#op-id').value = pending.id;
      $('#from-loc').value = pending.input.from; $('#to-loc').value = pending.input.to; $('#qty').value = pending.input.units;
      $('#result').textContent = JSON.stringify({ retained: pending }, null, 2);
    }
    submission.update({ pending, selected: $('#op-id').value });
  };
  loadStore();
  options = { workerUrl: new URL('./worker.mjs', import.meta.url), profileId,
    applicationId: configuration.applicationId, definitionId: 'shared-inventory', definitionVersion: '1',
    requiresDedicatedWorker: true, context: { viewId, documentPath: location.pathname } };
  $('#create-device').disabled = false;
  attachment = await openBrowserOwner(options); session = attachment.session;
  if (session.endpoint.context.viewId !== viewId) { viewId = session.endpoint.context.viewId; sessionStorage.setItem(viewKey, viewId); loadStore(); }
  if (pending) checkIntentSession(pending, session);
  $('#device-key').value = session.deviceId;
  $('#close').disabled = false;
  diagnostics.update({ leaderStatus: attachment.mode, storageBackend: 'opfs-sql-wasm' });
  liveView = createLiveView(session, { query: 'inventory', input: null,
    onStatus(status) {
      $('#session-status').textContent = `${status.phase} · db ${status.database} · role ${status.role}`;
      submission.application(status); diagnostics.update({ coordinatorStatus: status });
    },
    onRecovery() { submission.update({ coherent: false }); report(Error('Selected history changed. Inspect retained operations before reviewing new balances.')); },
    onError(error) { submission.update({ coherent: false }); report(error); },
  });
  liveView.subscribe(renderStock);
  session.participation.onStatus(status => {
    const connected = submission.snapshot.connected; submission.participation(status);
    if (!connected && submission.snapshot.connected) void liveView.refresh().catch(report);
  });
  submission.update({ attached: true });
  await liveView.ready({ timeoutMs: 30_000 });
  if (!window.tendril) throw Error('Open the signed published Tendriller page.');
  window.tendril.application.install(createApplicationBackend({ id: session.applicationId, session }));
  window.tendril.signals?.install(session.signals);
  window.tendril.transport?.install(session.participation);
  $('#create-device').disabled = true;
}
async function action(kind, run) {
  let release;
  try { if (working) return; working = true;
    if (kind === 'inspect') {
      if (!submission.snapshot.canInspect) throw Error('Connect this browser before inspecting its retained operation.');
      submission.update({ working: true }); release = () => submission.update({ working: false });
    } else release = submission.begin(kind);
    await run(); }
  catch (error) { report(Error(`${error.message ?? error}${pending ? ' Preserve this operation ID and reviewed input; inspect or retry the original attempt.' : ''}`)); }
  finally { working = false; release?.(); }
}
$('#transfer-form').addEventListener('submit', event => {
  event.preventDefault();
  void action('submit', async () => {
    // Capture exactly the balances displayed for review, before any asynchronous work.
    const intent = transferIntent(liveView.snapshot, { from: $('#from-loc').value, to: $('#to-loc').value, units: Number($('#qty').value) }, crypto.randomUUID());
    retain(intent);
    const handle = await session.command(intent.command, intent.input, { operationId: intent.id, basedOn: intent.basedOn });
    showState(await handle.applied({ signal: AbortSignal.timeout(15_000) })); await liveView.refresh();
  });
});
$('#retry-op').addEventListener('click', () => { void action('retry', async () => { showState(await retryIntent(session, pending)); await liveView.refresh(); }); });
$('#inspect-op').addEventListener('click', () => {
  void action('inspect', async () => { if (pending) checkIntentSession(pending, session); showState(await session.operations.get($('#op-id').value)); });
});
$('#refresh').addEventListener('click', () => { void liveView?.refresh().catch(report); });
$('#create-device').addEventListener('click', () => {
  $('#create-device').disabled = true;
  void createBrowserIdentity(options).then(key => {
    $('#device-key').value = key;
    $('#result').textContent = `Verify this browser public key, stop the native peer, then run npm run enroll -- ${key} in the original SQL project. Restart npm run peer and reload this page. Keep this browser profile and all private native records.`;
  }).catch(report).finally(() => { $('#create-device').disabled = Boolean(session); });
});
$('#export-diagnostics').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(diagnostics.snapshot(), null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'tendriller-sql-diagnostics.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
async function close() {
  submission.update({ attached: false, coherent: false }); liveView?.close();
  await attachment?.detach(); attachment = session = undefined;
  $('#close').disabled = true; $('#session-status').textContent = 'Detached. Reload to reconnect. Other views and the native peer keep their own lifetimes.';
}
$('#close').addEventListener('click', () => { void close().catch(report); });
window.addEventListener('pagehide', event => {
  submission.update({ coherent: false });
  if (event.persisted) void attachment?.suspend().catch(report);
  else void close().catch(report);
});
window.addEventListener('pageshow', event => { if (event.persisted && attachment) void attachment.resume().then(() => liveView.refresh()).catch(report); });
void boot().catch(async error => {
  $('#session-status').textContent = 'Connection unavailable'; report(error);
  submission.update({ attached: false, coherent: false }); liveView?.close();
  try { await attachment?.detach(); } catch (cleanup) { report(Error(`${error.message}; detach failed: ${cleanup.message}. Reload with this same browser profile.`)); }
  attachment = session = undefined;
});
