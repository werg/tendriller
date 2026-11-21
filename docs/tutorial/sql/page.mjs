// Minimal working SQL starter UI (W7) with live SQL query view, guarded transfer command,
// operation lifecycle inspector, encrypted checkpoint export, and DevTools-free diagnostics panel.
import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { createLiveView, describeOperationLifecycle } from '@chronolog/peer-session/browser';
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';
import { mountDiagnosticsPanel, registerLifecycleFlush } from '../helpers/diagnostics-panel.mjs';

const $ = selector => document.querySelector(selector);
const diagnostics = mountDiagnosticsPanel($('#diagnostics-slot'), { appName: 'Shared Inventory (SQL)' });
let session, liveView, lastRevision = null;

function renderStock(snapshot) {
  lastRevision = snapshot.revision;
  $('#revision-label').textContent = `Generation ${snapshot.revision.generation.slice(0, 12)} · seq ${snapshot.revision.sequence}`;
  const tbody = $('#stock-rows');
  tbody.replaceChildren();
  const rows = snapshot.value?.stock ?? [];
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.textContent = 'No stock rows recorded yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const value of [row.sku, row.location, String(row.quantity)]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

async function boot() {
  const isLocalPreview = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  let configuration;
  try {
    const res = await fetch(new URL('./configuration.json', import.meta.url));
    if (!res.ok) throw new Error('configuration.json unavailable');
    configuration = await res.json();
  } catch {
    $('#session-status').textContent = isLocalPreview ? 'Static layout preview (no live SQL owner)' : 'Missing configuration.json';
    diagnostics.update({ leaderStatus: 'preview-only' });
    return;
  }

  const profileId = `tendriller-inventory-${configuration.applicationId}`;
  const attachment = await openBrowserOwner({
    workerUrl: new URL('./worker.mjs', import.meta.url),
    profileId,
    applicationId: configuration.applicationId,
    definitionId: 'shared-inventory',
    definitionVersion: '1',
    requiresDedicatedWorker: true,
    context: { viewId: crypto.randomUUID(), documentPath: location.pathname },
  });
  session = attachment.session;
  if (window.tendril?.application) {
    window.tendril.application.install(createApplicationBackend({ id: session.applicationId, session }));
    window.tendril.signals?.install(session.signals);
    if (session.participation) window.tendril.transport?.install(session.participation);
  }
  diagnostics.update({ leaderStatus: 'dedicated-worker-elected', storageBackend: 'opfs-sql-wasm' });
  registerLifecycleFlush(() => { /* Worker flushes OPFS SAH pool on close/visibility change. */ });

  liveView = createLiveView(session, {
    query: 'inventory',
    input: null,
    onStatus(status) {
      $('#session-status').textContent = `${status.phase} · db ${status.database} · role ${status.role}`;
      diagnostics.update({ coordinatorStatus: status });
    },
    onError(error) { $('#result').textContent = String(error?.message ?? error); },
  });
  liveView.subscribe(renderStock);
  await liveView.ready({ timeoutMs: 30_000 });
}

$('#refresh').addEventListener('click', () => { void liveView?.refresh(); });

$('#transfer-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!session) return;
  const operationId = $('#op-id').value.trim() || `sql-${crypto.randomUUID()}`;
  $('#op-id').value = operationId;
  $('#operation-status').textContent = `Submitting ${operationId}…`;
  try {
    const handle = await session.command('transferStock', {
      sku: $('#sku').value.trim(),
      from: $('#from-loc').value.trim(),
      to: $('#to-loc').value.trim(),
      quantity: Number($('#qty').value),
    }, { operationId, ...(lastRevision ? { basedOn: lastRevision } : {}) });
    const applied = await handle.applied();
    const state = await handle.get();
    const summary = describeOperationLifecycle(operationId, state);
    $('#operation-status').textContent = `${operationId}: ${summary.lifecycle}${summary.errorCode ? ` (${summary.errorCode})` : ''}`;
    $('#result').textContent = JSON.stringify({ summary, applied }, null, 2);
    if (summary.lifecycle === 'applied') diagnostics.update({ lastAppliedOperationId: operationId });
  } catch (error) {
    $('#operation-status').textContent = `${operationId}: outcome unknown — inspect before retrying.`;
    $('#result').textContent = JSON.stringify({ error: { code: error?.code ?? 'unknown', message: error?.message ?? String(error) } }, null, 2);
  }
});

$('#inspect-op').addEventListener('click', async () => {
  if (!session) return;
  const opId = $('#op-id').value.trim();
  if (!opId) { $('#result').textContent = 'Enter an operation ID to inspect.'; return; }
  const state = await session.operations.get(opId);
  const summary = describeOperationLifecycle(opId, state);
  $('#operation-status').textContent = `${opId}: ${summary.lifecycle}`;
  $('#result').textContent = JSON.stringify({ summary, state }, null, 2);
});

$('#export-checkpoint').addEventListener('click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    diagnostics: diagnostics.snapshot(),
    note: 'Use tendril checkpoint export on the native owner or pass your browser BytesStore + secret to exportDeviceCheckpoint() to create an AES-256-GCM encrypted migration snapshot.',
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'tendriller-sql-diagnostics.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

void boot().catch(error => {
  $('#session-status').textContent = 'Startup failed';
  $('#result').textContent = String(error?.message ?? error);
});
