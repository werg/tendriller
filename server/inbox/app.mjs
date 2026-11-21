import { createWidgetBridge } from './bridge.mjs';

const status = document.querySelector('#status');
const send = document.querySelector('#send');
const bridge = createWidgetBridge({ window, onClose: disconnect });
let application, socket, timer, handledProof, submitting = false;

function disconnect() {
  clearTimeout(timer);
  if (socket) {
    const previous = socket;
    socket = undefined;
    previous.close();
  }
}

function accept(result) {
  const value = result.structuredContent;
  if (!/^[a-f0-9]{64}$/u.test(value?.applicationId) || !/^[a-z2-7]{12}$/u.test(value?.pageId)) return;
  application = value.applicationId;
  document.querySelector('#name').textContent = typeof value.label === 'string' ? value.label.slice(0, 100) : 'Application inbox';
  send.disabled = !bridge.canMessage;
  const activity = result._meta?.activity, origin = result._meta?.origin;
  if (handledProof && activity?.proof === handledProof) return;
  disconnect();
  if (typeof origin !== 'string' || !activity?.proof || activity.exp <= Date.now()) {
    status.textContent = 'Ask the chat to check the inbox when you are ready.';
    return;
  }
  try {
    const service = new URL(origin);
    if (service.protocol !== 'https:' || service.origin !== origin || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(activity.proof))
      throw Error('Invalid inbox connection');
    service.protocol = 'wss:';
    service.pathname = '/api/t/' + value.pageId + '/assistant/activity';
    const transport = new WebSocket(service, ['tendriller.application-activity.v1', 'td_watch.' + activity.proof]);
    socket = transport;
    handledProof = activity.proof;
    timer = setTimeout(() => {
      disconnect();
      status.textContent = 'The live card expired. Open it again or ask the chat to check the inbox.';
    }, Math.min(activity.exp - Date.now(), 30 * 60_000));
    transport.addEventListener('open', () => { if (socket === transport) status.textContent = 'Watching for activity while this card is open.'; });
    transport.addEventListener('message', event => {
      if (socket === transport && event.data === '{"type":"changed"}')
        status.textContent = 'New application activity. Check the inbox when you are ready.';
    });
    transport.addEventListener('close', () => {
      if (socket !== transport) return;
      disconnect();
      status.textContent = 'Live activity disconnected. Ask the chat to check the inbox.';
    });
  } catch { status.textContent = 'Live activity is unavailable here. Ask the chat to check the inbox.'; }
}

bridge.onResult(accept);
try {
  const { mode } = await bridge.connect();
  if (mode === 'unavailable') status.textContent = 'Open this card in a compatible chat. You can still ask the chat to check the inbox directly.';
} catch {
  bridge.close();
  send.disabled = true;
  status.textContent = 'This chat did not establish the inbox connection. Ask the chat to check the inbox directly.';
}
if (application) send.disabled = !bridge.canMessage;
send.addEventListener('click', async () => {
  if (submitting || !application || !bridge.canMessage) return;
  submitting = true;
  send.disabled = true;
  try {
    // App payloads are never embedded in messages sent to the model.
    const delivery = await bridge.sendMessage('Check my Tendriller inbox with read_application_events for applicationId ' + application +
      '. Continue from the last cursor if you have one. Summarize new activity for me.');
    if (delivery?.isError) throw Error('Inbox follow-up rejected');
    status.textContent = 'Inbox request sent to this chat.';
  } catch { status.textContent = 'The chat did not confirm receipt. Check the conversation before trying again.'; }
  finally { send.disabled = false; submitting = false; }
});
window.addEventListener('pagehide', () => bridge.close(), { once: true });
