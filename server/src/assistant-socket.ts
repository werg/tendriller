import type { Tendril } from './tendril';
import { activeAdapter, connection } from './assistant-admission';
import { ADAPTER_KEY, ASSISTANT_PROTOCOL, ASSISTANT_SOCKET_TAG, REQUEST_LIMIT, fields } from './assistant-shared';
import { pagePolicy } from './access';
import { HttpError } from './http';
import { safeEqual, sha256Hex } from './ids';
import { ingestAssistantEvent } from './assistant-events';

type Attachment = { tag: typeof ASSISTANT_SOCKET_TAG; connectionId: string };
type Inflight = { socket: WebSocket; resolve: (value: unknown) => void; reject: (error: Error) => void };
const inflight = new WeakMap<Tendril, Map<string, Inflight>>();
const invalid = () => new HttpError(502, 'invalid_adapter_response');
const offline = () => new HttpError(503, 'application_participant_offline', 'Start the enrolled application participant, then try again.');

export function isAssistantAdapter(ws: WebSocket): boolean {
  return (ws.deserializeAttachment() as Attachment | null)?.tag === ASSISTANT_SOCKET_TAG;
}

export async function upgradeAssistantAdapter(t: Tendril, req: Request) {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    throw new HttpError(426, 'websocket_required');
  const protocols = req.headers.get('Sec-WebSocket-Protocol')?.split(',').map(s => s.trim()) ?? [];
  const credential = protocols.find(token => ADAPTER_KEY.test(token)), adapter = activeAdapter(t);
  if (!protocols.includes(ASSISTANT_PROTOCOL) || !credential || !adapter || !safeEqual(await sha256Hex(credential), adapter.hash))
    throw new HttpError(401, 'adapter_not_approved');
  if (await pagePolicy(t) !== 'active' || activeAdapter(t)?.id !== adapter.id) throw new HttpError(403, 'forbidden');
  const [client, server] = Object.values(new WebSocketPair());
  for (const ws of t.ctx.getWebSockets(ASSISTANT_SOCKET_TAG)) ws.close(4000, 'Replaced by reconnected participant');
  t.ctx.acceptWebSocket(server, [ASSISTANT_SOCKET_TAG]);
  server.serializeAttachment({ tag: ASSISTANT_SOCKET_TAG, connectionId: adapter.id } satisfies Attachment);
  return new Response(null, { status: 101, headers: { 'Sec-WebSocket-Protocol': ASSISTANT_PROTOCOL }, webSocket: client });
}

export function closeAssistantAdapter(t: Tendril, socket: WebSocket) {
  for (const pending of inflight.get(t)?.values() ?? []) if (pending.socket === socket) pending.reject(offline());
}

export async function handleAssistantFrame(t: Tendril, socket: WebSocket, frame: string | ArrayBuffer) {
  const attached = socket.deserializeAttachment() as Attachment | null;
  const adapter = activeAdapter(t);
  if (!adapter || adapter.id !== attached?.connectionId) { socket.close(4003, 'Application grant revoked'); return; }
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
    const sequence = await t.serializeAssistant(() => ingestAssistantEvent(t, adapter, body));
    socket.send(JSON.stringify({ type: 'ack', id: body.id, sequence }));
  } catch (error) {
    try { socket.send(JSON.stringify({ type: 'ack', id: body.id,
      error: error instanceof HttpError ? error.code : 'application_event_unavailable' })); } catch {}
  }
}

export function assistantOnline(t: Tendril, id: string): boolean {
  return t.ctx.getWebSockets(ASSISTANT_SOCKET_TAG).some(ws =>
    ws.readyState === WebSocket.READY_STATE_OPEN && (ws.deserializeAttachment() as Attachment | null)?.connectionId === id);
}

export async function callAssistantAdapter(t: Tendril, input: object, signal: AbortSignal): Promise<unknown> {
  const adapter = activeAdapter(t);
  const ws = t.ctx.getWebSockets(ASSISTANT_SOCKET_TAG).find(socket =>
    socket.readyState === WebSocket.READY_STATE_OPEN && (socket.deserializeAttachment() as Attachment | null)?.connectionId === adapter?.id);
  if (!ws || !adapter || !connection(t)) throw offline();
  let pending = inflight.get(t);
  if (!pending) inflight.set(t, pending = new Map());
  if (pending.size >= 8) throw new HttpError(429, 'application_busy');
  const id = crypto.randomUUID();
  const message = JSON.stringify({ type: 'call', id, ...input });
  if (new TextEncoder().encode(message).byteLength > REQUEST_LIMIT) throw new HttpError(413, 'too_large');
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      pending.set(id, { socket: ws, resolve, reject });
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
