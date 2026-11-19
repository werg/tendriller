import { connectApplicationWorker } from '@chronolog/peer-session/browser';
import { serveWorkerWebRtcConnections } from '@chronolog/peer-session/webrtc';
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';
import { createAssistanceClient } from './client.mjs';
import { createPendingStorage } from './pending-storage.mjs';
import { visibleAssistanceStatus } from './projection.mjs';
import { createLiveView } from './helpers/live-view.mjs';

const $ = selector => document.querySelector(selector);
const configuration = await fetch(new URL('./configuration.json', import.meta.url)).then(response => {
  if (!response.ok) throw Error('The published application configuration is unavailable.');
  return response.json();
});
const storageKey = `tendriller-kitchen-${configuration.applicationId}:pending`;
const pendingStorage = createPendingStorage({ key: storageKey });
let worker, rtc, session, client, liveView, busy = false, operationRead = 0;
let terminalOperationId;
let selectedRequestId, detailRead = 0;
const pending = () => pendingStorage.load();
function controls() {
  const unresolved = Boolean(pending());
  $('#ask').disabled = $('#select-step').disabled = !session || busy || unresolved;
  $('#inspect').disabled = !session || busy || !(unresolved || pendingStorage.lastOperationId());
  $('#retry').disabled = !session || busy || !unresolved;
  $('#resolve').disabled = !session || busy || !terminalOperationId || pending()?.operationId !== terminalOperationId;
  $('#create-device').disabled = Boolean(session) || busy || unresolved;
  $('#connect').disabled = Boolean(session) || busy;
  $('#close').disabled = !session;
}
function report(error) { $('#result').textContent = error.message ?? String(error); controls(); }
function node(tag, text, className) {
  const element = document.createElement(tag); element.textContent = text;
  if (className) element.className = className;
  return element;
}
function render(value) {
  const list = $('#requests'); list.replaceChildren();
  if (!value.requests.length) list.append(node('p', 'Your first help request will appear here.'));
  for (const request of [...value.requests].reverse()) {
    const article = document.createElement('article');
    article.append(node('p', visibleAssistanceStatus(request), 'status'), node('h3', `${request.questionPreview}${request.questionTruncated ? '…' : ''}`),
      node('small', `Step ${request.cookingStepId} · request ${request.requestId}`));
    if (request.answerAvailable) article.append(node('p', 'An answer is available. Open details to read it.'));
    if (request.conflictCount) article.append(node('p', `${request.conflictCount} conflicting fact(s) retained for review.`, 'warning'));
    const details = node('button', 'Read request and answer', 'secondary');
    details.onclick = () => { selectedRequestId = request.requestId; void readRequestDetails().catch(report); };
    article.append(details);
    const handoff = document.createElement('button'); handoff.className = 'secondary';
    handoff.textContent = 'Copy request reference';
    handoff.addEventListener('click', async () => {
      const prompt = `Read Tendriller application ${configuration.applicationId}, request ${request.requestId}, using get_assistance_status. Help with the current request and use reply_to_assistance to return the answer after checking its step and context.`;
      try { await navigator.clipboard.writeText(prompt); $('#result').textContent = 'Request reference copied. Paste it into your connected assistant chat.'; }
      catch { $('#result').textContent = prompt; }
    });
    article.append(handoff); list.append(article);
  }
  const count = `${value.requestCount} request(s) in this history.${value.requestsTruncated ? ' Showing the latest 20; find older requests by ID below.' : ''}`;
  if (value.currentStep) $('#data-status').textContent = `Selected step: ${value.currentStep.text}. ${count}`;
  else $('#data-status').textContent = `${count} Choose a cooking step before asking.`;
  if (selectedRequestId) void readRequestDetails().catch(report);
}
async function readRequestDetails() {
  const currentSession = session, requestId = selectedRequestId, read = ++detailRead;
  const panel = $('#request-details'); panel.replaceChildren(node('p', 'Reading current request details…'));
  let value;
  try { ({ value } = await currentSession.query('assistanceStatus', { requestId })); }
  catch (error) { if (session === currentSession && read === detailRead) throw error; return; }
  if (session !== currentSession || read !== detailRead) return;
  if (!value) { panel.replaceChildren(node('p', 'This request is absent from the selected history.')); return; }
  panel.replaceChildren(node('p', visibleAssistanceStatus(value), 'status'), node('h3', value.question),
    node('small', `Request ${value.requestId} · step ${value.cookingStepId}`));
  if (value.answer) {
    panel.append(node('p', value.answer.answer, 'answer'));
    const steps = document.createElement('ol');
    for (const step of value.answer.suggestedSteps) steps.append(node('li', step));
    panel.append(steps);
  }
  for (const reply of value.replies.filter(reply => reply.eventId !== value.answer?.eventId)) {
    panel.append(node('p', `${reply.reasons.length ? `Response needs review: ${reply.reasons.join(', ')}` : 'Additional response'}. ${reply.answer}`, 'warning'));
  }
  if (value.conflictCount) panel.append(node('p', `${value.conflictCount} conflicting fact(s) retained.`, 'warning'));
  if (value.repliesTruncated || value.conflictsTruncated) panel.append(node('p',
    `Showing the canonical answer, up to 8 recent replies and 32 conflict references (${value.replyCount} replies total). The full facts remain in native history.`, 'warning'));
}
async function inspectOperation() {
  const currentSession = session, read = ++operationRead;
  const record = await client.inspect();
  if (session !== currentSession || read !== operationRead) return;
  if (record) {
    terminalOperationId = ['abandoned', 'needsReapply'].includes(record.state?.status) ? record.pending.operationId : undefined;
    $('#operation').textContent = `Operation ${record.pending.operationId}: ${record.state?.status ?? 'outcome unknown'}${record.state?.outcome ? ` (${record.state.outcome})` : ''}. Peer retention is separate.`;
    if (record.state?.status === 'applied') await client.acknowledge(record.pending.operationId);
  } else {
    terminalOperationId = undefined;
    const operationId = pendingStorage.lastOperationId();
    if (operationId) {
      const state = await currentSession.operations.get(operationId);
      if (session !== currentSession || read !== operationRead) return;
      $('#operation').textContent = `Last operation ${operationId}: ${state?.status ?? 'not visible'}${state?.outcome ? ` (${state.outcome})` : ''}. Peer retention is separate.`;
    }
  }
  $('#resolved-operations').replaceChildren(...pendingStorage.resolved().map(value => {
    const item = node('p', `${value.pending.operationId}: ${value.status}; released after review. `);
    const inspect = node('button', 'Inspect original operation', 'secondary');
    inspect.onclick = async () => {
      const currentSession = session;
      try {
        const state = await currentSession.operations.get(value.pending.operationId);
        if (session === currentSession) $('#operation').textContent = `Original operation ${value.pending.operationId}: ${state?.status ?? 'not visible'}. No reapplication was requested.`;
      } catch (error) { report(error); }
    };
    item.append(inspect); return item;
  }));
  controls();
}
async function refresh() {
  const result = await liveView.refresh();
  await inspectOperation();
  return result;
}
function waitFor(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('Opening timed out. Resume the existing device; do not replace it.')), 30000);
    const receive = ({ data }) => {
      if (data?.type === 'tutorial-failure') finish(Error(data.message));
      else if (data?.type === type) finish(null, data);
    };
    const failed = event => finish(Error(event.message || 'Worker failed to load.'));
    function finish(error, result) {
      clearTimeout(timer); worker.removeEventListener('message', receive); worker.removeEventListener('error', failed);
      error ? reject(error) : resolve(result);
    }
    worker.addEventListener('message', receive); worker.addEventListener('error', failed);
  });
}
$('#create-device').onclick = async () => {
  busy = true; controls();
  try {
    if (pending()) throw Error('Resolve the existing operation before creating any identity.');
    worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    const ready = waitFor('tutorial-identity'); worker.postMessage({ type: 'tutorial-create' });
    const { publicKey } = await ready;
    $('#device-key').value = publicKey; $('#enrollment').hidden = false;
    $('#enrollment-command').textContent = `npm run enroll -- ${publicKey}`;
    $('#connection').textContent = 'Browser identity created. Ask the owner to verify and enroll this key, then connect.';
  } catch (error) { report(error); }
  finally { worker?.terminate(); worker = undefined; busy = false; controls(); }
};
$('#connect').onclick = async () => {
  busy = true; controls();
  try {
    worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    rtc = serveWorkerWebRtcConnections(worker);
    const ready = waitFor('tutorial-opened'); worker.postMessage({ type: 'tutorial-connect' });
    await ready;
    session = await connectApplicationWorker(worker, { timeoutMs: 30000 });
    if (!window.tendril) throw Error('Open the signed published page to connect this application.');
    window.tendril.application.install(createApplicationBackend({ id: session.applicationId, session }));
    window.tendril.signals.install(session.signals);
    client = createAssistanceClient(session, { pendingStorage });
    session.participation.onStatus(status => {
      $('#connection').textContent = `Connection: ${status.phase}${status.error ? ` (${status.error})` : ''}. Keep an authorized native participant running.`;
    });
    $('#editor').disabled = false;
    liveView = createLiveView(session, { query: 'kitchenContext', input: null,
      onSnapshot(snapshot) { render(snapshot.value); void inspectOperation().catch(report); },
      onRecovery() {
        detailRead++; $('#request-details').replaceChildren(node('p', 'History changed. Reading the selected request again.'));
        $('#recovery').hidden = false;
        $('#recovery').textContent = 'Selected history changed. Inspect uncertain or abandoned commands before explicitly reapplying work.';
      }, onError: report,
    });
    await refresh();
  } catch (error) {
    report(error); liveView?.close();
    try { await session?.close(); } catch { /* Keep the original error. */ }
    rtc?.close(); worker?.terminate(); session = undefined;
    $('#editor').disabled = true;
    $('#connection').textContent = 'Connection unavailable. Reload and resume this existing device after fixing the reported prerequisite.';
  } finally { busy = false; controls(); }
};
async function act(action) {
  busy = true; controls();
  try {
    const result = await action();
    $('#operation').textContent = `Operation ${result.operationId} retained. Awaiting applied status; no delivery receipt inferred.`;
    if (result.operation) {
      const state = await result.operation.applied({ signal: AbortSignal.timeout(15000) });
      $('#result').textContent = `Application outcome: ${state.outcome}. Check the original operation after any later recovery.`;
    }
    await refresh();
  } catch (error) { report(Error(pending() ? `${error.message} Inspect or retry the original operation; keep its identity.` : error.message)); }
  finally { busy = false; controls(); }
}
$('#step-form').onsubmit = event => { event.preventDefault(); void act(() => client.selectStep({ stepId: $('#step-id').value.trim(), text: $('#step-text').value.trim() })); };
$('#ask-form').onsubmit = event => {
  event.preventDefault(); void act(async () => {
    const current = await refresh();
    if (!current.value.currentStep) throw Error('Choose a current step first.');
    return client.request({ question: $('#question').value.trim(), cookingStepId: current.value.currentStep.stepId,
      cookingStepEventId: current.value.currentStep.eventId,
      contextRevision: JSON.stringify(current.revision) });
  });
};
$('#inspect').onclick = () => refresh().catch(report);
$('#request-lookup').onsubmit = event => {
  event.preventDefault();
  const requestId = $('#request-id').value.trim();
  if (!session || !requestId || requestId.length > 128) { report(Error('Connect and enter a valid request ID.')); return; }
  selectedRequestId = requestId; void readRequestDetails().catch(report);
};
$('#retry').onclick = () => act(() => client.resume());
$('#resolve').onclick = async () => {
  busy = true; controls();
  try {
    const record = await client.inspect();
    if (!record || !['abandoned', 'needsReapply'].includes(record.state?.status)) throw Error('Inspect the current operation before resolving it.');
    if (!window.confirm(`Release the blocked slot for ${record.pending.operationId} (${record.state.status})? Its original reference will be retained. Nothing will be reapplied; review the current history before starting new work.`)) return;
    await client.resolve({ operationId: record.pending.operationId, confirmed: true });
    $('#result').textContent = 'Original operation retained for inspection. The slot is available; review the current history before starting new work.';
    await refresh();
  } catch (error) { report(error); }
  finally { busy = false; controls(); }
};
window.addEventListener('storage', event => {
  if (event.key !== storageKey) return;
  controls(); if (client) void inspectOperation().catch(report);
});
$('#close').onclick = async () => {
  detailRead++; $('#request-details').replaceChildren(node('p', 'Connection closed. Reconnect to read current request details.'));
  liveView?.close(); await session?.close(); rtc?.close(); worker?.terminate();
  session = undefined; $('#editor').disabled = true;
  $('#connection').textContent = 'Connection closed. Reload to reconnect the same device.';
  controls(); $('#create-device').disabled = $('#connect').disabled = true;
};
controls();
