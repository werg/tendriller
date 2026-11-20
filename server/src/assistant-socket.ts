import type { Tendril } from './tendril';
import { activeAdapters, freshAdapters } from './assistant-admission';
import { ADAPTER_KEY, ASSISTANT_PROTOCOL, ASSISTANT_SOCKET_TAG, REQUEST_LIMIT, fields } from './assistant-shared';
import { pagePolicy } from './access';
import { HttpError } from './http';
import { safeEqual, sha256Hex } from './ids';
import { withSelectedAssistantGeneration } from './peer-generations';
import { ingestAssistantEvent } from './assistant-events';
import { providerBindingId } from './assistant-bindings';

type Attachment = { tag: typeof ASSISTANT_SOCKET_TAG; adapterHash: string; deviceId: string; connectionEpoch: number };
type Inflight = { socket: WebSocket; consumerId: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
const inflight = new WeakMap<Tendril, Map<string, Inflight>>();
const invalid = () => new HttpError(502, 'invalid_adapter_response');
const offline = () => new HttpError(503, 'application_participant_offline', 'Start the enrolled application participant, then try again.');

const attachment = (ws: WebSocket) => ws.deserializeAttachment() as Attachment | null;

export function isAssistantAdapter(ws: WebSocket): boolean {
  return attachment(ws)?.tag === ASSISTANT_SOCKET_TAG;
}

export async function upgradeAssistantAdapter(t: Tendril, req: Request) {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    throw new HttpError(426, 'websocket_required');
  const protocols = req.headers.get('Sec-WebSocket-Protocol')?.split(',').map(s => s.trim()) ?? [];
  const credential = protocols.find(token => ADAPTER_KEY.test(token));
  const deviceId = protocols.find(token => /^td_device_[a-f0-9]{64}$/u.test(token))?.slice('td_device_'.length);
  if (!protocols.includes(ASSISTANT_PROTOCOL) || !credential || !deviceId) throw new HttpError(401, 'adapter_not_approved');
  const adapterHash = await sha256Hex(credential), allowed = () => activeAdapters(t).some(hash => safeEqual(hash, adapterHash));
  if (!(await freshAdapters(t)).some(hash => safeEqual(hash, adapterHash))) throw new HttpError(401, 'adapter_not_approved');
  if (await pagePolicy(t) !== 'active') throw new HttpError(403, 'forbidden');
  await withSelectedAssistantGeneration(t, async (_generation, canUseDevice) => {
    if (!await canUseDevice(deviceId, false) && !await canUseDevice(deviceId, true) || !(await freshAdapters(t)).includes(adapterHash) || !allowed())
      throw new HttpError(403, 'adapter_device_not_enrolled');
    const previous = t.db.one<{ device_id: string }>('SELECT device_id FROM assistant_devices WHERE adapter_hash=?', adapterHash);
    if (previous && previous.device_id !== deviceId) throw new HttpError(409, 'adapter_device_changed', 'Use this credential with its original Chronolog device.');
    if (!previous) t.db.run('INSERT INTO assistant_devices(adapter_hash,device_id) VALUES(?,?)', adapterHash, deviceId);
  });
  if (!(await freshAdapters(t)).includes(adapterHash) || !allowed()) throw new HttpError(403, 'forbidden');
  const connectionEpoch = t.db.get<number>('assistant_adapter_epoch:' + adapterHash, 0) + 1;
  t.db.set('assistant_adapter_epoch:' + adapterHash, connectionEpoch);
  const [client, server] = Object.values(new WebSocketPair());
  for (const ws of t.ctx.getWebSockets(ASSISTANT_SOCKET_TAG)) {
    if (attachment(ws)?.adapterHash === adapterHash) ws.close(4000, 'Replaced by reconnected participant');
  }
  t.ctx.acceptWebSocket(server, [ASSISTANT_SOCKET_TAG]);
  server.serializeAttachment({ tag: ASSISTANT_SOCKET_TAG, adapterHash, deviceId, connectionEpoch } satisfies Attachment);
  return new Response(null, { status: 101, headers: { 'Sec-WebSocket-Protocol': ASSISTANT_PROTOCOL }, webSocket: client });
}

export function closeAssistantAdapter(t: Tendril, socket: WebSocket) {
  for (const pending of inflight.get(t)?.values() ?? []) if (pending.socket === socket) pending.reject(offline());
}

export async function handleAssistantFrame(t: Tendril, socket: WebSocket, frame: string | ArrayBuffer) {
  const attached = attachment(socket);
  if (!attached || !(await freshAdapters(t)).includes(attached.adapterHash)) { socket.close(4003, 'Application grant revoked'); return; }
  if (attached.connectionEpoch !== t.db.get('assistant_adapter_epoch:' + attached.adapterHash, 0)) {
    socket.close(4000, 'Provider connection superseded'); return;
  }
  if (typeof frame !== 'string' || frame.length > REQUEST_LIMIT || new TextEncoder().encode(frame).byteLength > REQUEST_LIMIT) {
    socket.close(1009, 'Application frame too large'); return;
  }
  let body;
  try { body = JSON.parse(frame); } catch { socket.close(1008, 'Invalid application frame'); return; }
  if (!body || typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(body.id)) {
    socket.close(1008, 'Invalid application frame'); return;
  }
  if (body.type === 'result') {
    const pending = inflight.get(t)?.get(body.id);
    if (!pending || pending.socket !== socket) return;
    try {
      fields(body, ['type', 'id', 'value', 'error'], ['type', 'id']);
      if (Object.hasOwn(body, 'value') === Object.hasOwn(body, 'error')) throw invalid();
      if (Object.hasOwn(body, 'error'))
        pending.reject(new HttpError(409, 'application_operation_failed',
          typeof body.error === 'string' ? body.error.slice(0, 200) : 'Application operation failed'));
      else pending.resolve(body.value);
    } catch { pending.reject(invalid()); }
    return;
  }
  if (body.type !== 'event') { socket.close(1008, 'Unsupported application frame'); return; }
  // Events share the page work queue with grant changes and outbox dispatch.
  try {
    const sequence = await t.serializeAssistant(() => ingestAssistantEvent(t, attached.adapterHash, attached.deviceId, body));
    socket.send(JSON.stringify({ type: 'ack', id: body.id, sequence }));
  } catch (error) {
    try { socket.send(JSON.stringify({ type: 'ack', id: body.id,
      error: error instanceof HttpError ? error.code : 'application_event_unavailable' })); } catch {}
  }
}

export async function onlineAssistantAdapters(t: Tendril): Promise<{ hash: string; bindingId: string; deviceId: string; connectionEpoch: number; socket: WebSocket }[]> {
  const sockets = t.ctx.getWebSockets(ASSISTANT_SOCKET_TAG);
  return (await freshAdapters(t)).flatMap(hash => {
    const socket = sockets.find(ws => ws.readyState === WebSocket.READY_STATE_OPEN && attachment(ws)?.adapterHash === hash &&
      attachment(ws)?.connectionEpoch === t.db.get('assistant_adapter_epoch:' + hash, 0));
    return socket ? [{ hash, bindingId: providerBindingId(hash), deviceId: attachment(socket)!.deviceId,
      connectionEpoch: attachment(socket)!.connectionEpoch, socket }] : [];
  });
}

export async function callAssistantAdapter(t: Tendril, ws: WebSocket, input: object, signal: AbortSignal, consumerId = 'bridge'): Promise<unknown> {
  const attached = attachment(ws);
  if (!attached || !(await freshAdapters(t)).includes(attached.adapterHash) || ws.readyState !== WebSocket.READY_STATE_OPEN ||
      attached.connectionEpoch !== t.db.get('assistant_adapter_epoch:' + attached.adapterHash, 0)) throw offline();
  let pending = inflight.get(t);
  if (!pending) inflight.set(t, pending = new Map());
  if (pending.size >= 8) throw new HttpError(429, 'application_busy');
  if ([...pending.values()].filter(value => value.consumerId === consumerId).length >= 2)
    throw new HttpError(429, 'agent_binding_busy', 'This binding already has two active calls; other bindings retain admission capacity.');
  const id = crypto.randomUUID();
  const message = JSON.stringify({ type: 'call', id, ...input });
  if (new TextEncoder().encode(message).byteLength > REQUEST_LIMIT) throw new HttpError(413, 'too_large');
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      pending.set(id, { socket: ws, consumerId, resolve, reject });
      abort = () => reject(new HttpError(408, 'application_call_cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new HttpError(504, 'application_call_timed_out',
        'The participant did not answer in time. Retry a command with the original operation ID and inputs.')), 5000);
      ws.send(message);
    });
  } finally {
    pending.delete(id);
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
