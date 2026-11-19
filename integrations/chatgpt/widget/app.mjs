import { createWidgetBridge, requestReference, followupPrompt } from './bridge.mjs';

const $ = selector => document.querySelector(selector), bridge = createWidgetBridge({ window });
let reference = null, working = false;
const bounded = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';
function controls() {
  $('#ask').disabled = working || !reference || !bridge.canMessage;
  $('#refresh').disabled = working || !reference || !bridge.canCallTool;
}
function render(result) {
  if (result.isError) { $('#notice').textContent = 'This request is unavailable. Check the connection and its permissions.'; return; }
  const data = result.structuredContent;
  const next = requestReference(data);
  if (!next) return;
  reference = next;
  $('#reference').textContent = `Application ${reference.applicationId.slice(0, 12)} · request ${reference.requestId}`;
  const assistance = data.assistance;
  $('#question').textContent = bounded(assistance?.question, 4000) || 'Request not present in the current selected history.';
  let state = bounded(assistance?.status, 64) || 'unavailable';
  if (state === 'requested' && Number.isFinite(assistance.expiresAtMs) && Date.now() >= assistance.expiresAtMs) state = 'expired';
  $('#status').textContent = state;
  $('#answer').textContent = bounded(assistance?.answer?.answer, 8000) || 'No canonical answer observed yet.';
  $('#steps').replaceChildren();
  for (const step of (Array.isArray(assistance?.answer?.suggestedSteps) ? assistance.answer.suggestedSteps : []).slice(0, 12)) {
    const item = document.createElement('li'); item.textContent = bounded(step, 500); $('#steps').append(item);
  }
  const jobs = Array.isArray(data.delivery?.jobs) ? data.delivery.jobs.slice(-8) : [];
  $('#delivery').textContent = jobs.length ? `Delivery: ${jobs.map(job => bounded(job.state, 40)).join(', ')}` : 'No delivery receipt is available for this request.';
  $('#notice').textContent = assistance?.conflicts?.length ? 'This request has conflicting facts. Review its current state before answering.' : '';
  controls();
}
bridge.onInput(input => {
  const next = requestReference(input);
  if (next) { reference = next; controls(); }
});
bridge.onResult(render);
$('#ask').onclick = async () => {
  if (working || !reference) return;
  working = true; controls();
  try { await bridge.sendMessage(followupPrompt(reference)); $('#notice').textContent = 'Message accepted by the host. An assistant response has not been observed yet.'; }
  catch (error) { $('#notice').textContent = `Message outcome unavailable: ${bounded(error.message, 200)}. Check the conversation before sending again.`; }
  finally { working = false; controls(); }
};
$('#refresh').onclick = async () => {
  if (working || !reference) return;
  working = true; controls();
  try { render(await bridge.callTool('get_assistance_status', reference)); }
  catch (error) { $('#notice').textContent = `Refresh unavailable: ${bounded(error.message, 200)}.`; }
  finally { working = false; controls(); }
};
const { mode } = await bridge.connect();
$('#host').textContent = mode === 'unavailable' ? 'Open this card in a compatible MCP Apps host. You can still ask your chat to use the tools directly.'
  : 'Use the buttons when you want to refresh or ask the assistant. This card does not send background messages.';
controls();
window.addEventListener('pagehide', () => bridge.close(), { once: true });
