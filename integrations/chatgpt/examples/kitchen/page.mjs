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
    article.append(node('p', visibleAssistanceStatus(request), 'status'), node('h3', request.question),
      node('small', `Step ${request.cookingStepId} · request ${request.requestId}`));
    if (request.answer) {
      article.append(node('p', request.answer.answer, 'answer'));
      const steps = document.createElement('ol');
      for (const step of request.answer.suggestedSteps) steps.append(node('li', step));
      article.append(steps);
    }
    for (const reply of request.replies.filter(reply => reply.reasons.length)) {
      article.append(node('p', `Response needs review: ${reply.reasons.join(', ')}. ${reply.answer}`, 'warning'));
    }
    if (request.conflicts.length) article.append(node('p', `${request.conflicts.length} conflicting fact(s) retained for review.`, 'warning'));
    const handoff = document.createElement('button'); handoff.className = 'secondary';
    handoff.textContent = 'Copy request reference';
    handoff.addEventListener('click', async () => {
      const prompt = `Read Tendriller application ${configuration.applicationId}, request ${request.requestId}, using get_assistance_status. Help with the current request and use reply_to_assistance to return the answer after checking its step and context.`;
      try { await navigator.clipboard.writeText(prompt); $('#result').textContent = 'Request reference copied. Paste it into your connected assistant chat.'; }
      catch { $('#result').textContent = prompt; }
    });
    article.append(handoff); list.append(article);
  }
  if (value.currentStep) $('#data-status').textContent = `Selected step: ${value.currentStep.text}. ${value.requests.length} request(s) in this history.`;
  else $('#data-status').textContent = `${value.requests.length} request(s) in this history. Choose a cooking step before asking.`;
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
      contextRevision: JSON.stringify(current.revision) });
  });
};
$('#inspect').onclick = () => refresh().catch(report);
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
  liveView?.close(); await session?.close(); rtc?.close(); worker?.terminate();
  session = undefined; $('#editor').disabled = true;
  $('#connection').textContent = 'Connection closed. Reload to reconnect the same device.';
  controls(); $('#create-device').disabled = $('#connect').disabled = true;
};
controls();
