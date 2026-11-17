import { HOSTED_SIGNAL_LIMITS as LIMITS, HOSTED_SIGNAL_PROTOCOL, signalPayload, signalTopic } from '../../contract/hosted-signals.mjs';
import { SignalError } from '../../contract/signals.mjs';
import type { EphemeralSignal } from '../../contract/signals.mjs';
import { accountActive, allows, currentPrincipal, pageAccessAllowed, type Principal } from './access';
import { HttpError, isPlainObject } from './http';
import { requireWritesOpen } from './service-state';
import type { Tendril } from './tendril';

export interface SignalSession {
  sessionId: string; sequence: number; subscribed: boolean;
  delivery: number; acknowledged: number; pending: number[];
  second: number; count: number;
}
type Reader = Exclude<Principal, { kind: 'producer' }>;
interface SignalAttachment { kind: 'signals'; principal: Reader; live: SignalSession }
type SocketMetadata = Record<string, unknown> & { live?: SignalSession };
const metadata = (ws: WebSocket): SocketMetadata => ws.deserializeAttachment() ?? {};
const fresh = (): SignalSession => ({ sessionId: crypto.randomUUID(), sequence: 0, subscribed: false, delivery: 0, acknowledged: 0, pending: [], second: 0, count: 0 });
const state = (ws: WebSocket): SignalSession => metadata(ws).live ?? fresh();
const save = (ws: WebSocket, live: SignalSession): void => ws.serializeAttachment({ ...metadata(ws), live });
export const isSignalSocket = (ws: WebSocket): boolean => metadata(ws).kind === 'signals';
const canRead = (principal: Principal | null): principal is Reader => !!principal && principal.kind !== 'producer';
const canSend = (principal: Principal | null): principal is Reader => canRead(principal) && (principal.kind === 'agent' || allows(principal, 'page.write'));
const open = (ws: WebSocket): boolean => ws.readyState === WebSocket.READY_STATE_OPEN;
const error = (code: string, message: string): SignalError => new SignalError(code, message);
/** Every live payload and reply consumes the same bounded transport window. */
function send(ws: WebSocket, message: Record<string, unknown>): void {
  if (!open(ws)) return;
  if (message.t === 'signal_ready') { ws.send(JSON.stringify(message)); return; }
  const live = state(ws);
  if (live.delivery >= Number.MAX_SAFE_INTEGER) { ws.close(1008, 'Live delivery sequence exhausted'); return; }
  const delivery = live.delivery + 1, frame = JSON.stringify({ ...message, delivery });
  const size = new TextEncoder().encode(frame).byteLength;
  if (live.pending.length >= LIMITS.inFlightFrames || live.pending.reduce((sum, bytes) => sum + bytes, 0) + size > LIMITS.queuedBytes) {
    ws.close(1013, 'Live signal reader too slow'); return;
  }
  save(ws, { ...live, delivery, pending: [...live.pending, size] });
  ws.send(frame);
}

async function authorize(t: Tendril, ws: WebSocket): Promise<Principal | null> {
  if (!t.exists() || !open(ws) || !isSignalSocket(ws)) return null;
  const original = (metadata(ws) as unknown as SignalAttachment).principal;
  if (!await pageAccessAllowed(t) || original.kind === 'page' && original.accountId && !await accountActive(t, original.accountId)) return null;
  const principal = currentPrincipal(t, original);
  return canRead(principal) ? principal : null;
}

/** Separate from conversational wake sockets: opening this creates no agent check-in. */
export async function openSignalSocket(t: Tendril, request: Request, principal: Principal): Promise<Response> {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes(HOSTED_SIGNAL_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Live signals require ${HOSTED_SIGNAL_PROTOCOL}`);
  if (!canRead(principal) || !await pageAccessAllowed(t) || principal.kind === 'page' && principal.accountId && !await accountActive(t, principal.accountId) ||
      !canRead(currentPrincipal(t, principal))) throw new HttpError(403, 'forbidden');
  if (t.ctx.getWebSockets('signals').filter(open).length >= LIMITS.connections) throw new HttpError(429, 'signal_backpressure', 'Too many live connections');
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, ['signals']);
  server.serializeAttachment({ kind: 'signals', principal, live: fresh() } satisfies SignalAttachment);
  send(server, { t: 'signal_ready', scope: `hosted:${t.tid}` });
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': HOSTED_SIGNAL_PROTOCOL } });
}

interface Queue { tail: Promise<void>; count: number; bytes: number }
const queues = new WeakMap<WebSocket, Queue>();
const totals = new WeakMap<Tendril, { count: number; bytes: number }>();

/** Dedicated live sockets never enter page activity, workflow or durable request handling. */
export function routeSignalMessage(t: Tendril, ws: WebSocket, raw: string | ArrayBuffer): Promise<void> | null {
  if (!isSignalSocket(ws)) return null;
  if (typeof raw === 'string'
    ? raw.length > LIMITS.frameBytes || new TextEncoder().encode(raw).byteLength > LIMITS.frameBytes
    : raw.byteLength > LIMITS.frameBytes) {
    ws.close(1009, 'Signal frame too large'); return Promise.resolve();
  }
  let message: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    if (!isPlainObject(value) || typeof value.t !== 'string' || !value.t.startsWith('signal_')) {
      ws.close(1008, 'Live connection accepts signal messages only'); return Promise.resolve();
    }
    message = value;
  } catch {
    ws.close(1008, 'Invalid live frame'); return Promise.resolve();
  }
  const size = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
  if (size > LIMITS.frameBytes) { ws.close(1009, 'Signal frame too large'); return Promise.resolve(); }
  if (message.t === 'signal_credit') {
    const live = metadata(ws).live;
    if (!live || Object.keys(message).some(key => key !== 't' && key !== 'through') || !Number.isSafeInteger(message.through) ||
        (message.through as number) < live.acknowledged || (message.through as number) > live.delivery) {
      ws.close(1008, 'Invalid live receipt credit'); return Promise.resolve();
    }
    const through = message.through as number;
    save(ws, { ...live, pending: live.pending.slice(through - live.acknowledged), acknowledged: through });
    return Promise.resolve();
  }
  let queue = queues.get(ws); if (!queue) { queue = { tail: Promise.resolve(), count: 0, bytes: 0 }; queues.set(ws, queue); }
  let total = totals.get(t); if (!total) { total = { count: 0, bytes: 0 }; totals.set(t, total); }
  if (queue.count >= 32 || queue.bytes + size > 256 * 1024 || total.count >= 128 || total.bytes + size > 1024 * 1024) {
    ws.close(1013, 'Live signal queue overflow'); return Promise.resolve();
  }
  queue.count++; queue.bytes += size; total.count++; total.bytes += size;
  const current = queue, aggregate = total;
  const next = current.tail.then(async () => {
    if (!open(ws)) return;
    let active = true;
    const timer = setTimeout(() => { active = false; if (open(ws)) ws.close(1013, 'Live authorization timed out'); }, 5000);
    try { await process(t, ws, message, () => active && open(ws)); }
    catch (failure) {
      if (!active || !open(ws)) return;
      const code = failure instanceof SignalError || failure instanceof HttpError ? failure.code : 'signal_disconnected';
      send(ws, { t: 'signal_ack', cid: message.cid, error: code, message: failure instanceof Error ? failure.message : 'Live dispatch failed' });
    } finally { active = false; clearTimeout(timer); }
  }).finally(() => { current.count--; current.bytes -= size; aggregate.count--; aggregate.bytes -= size; });
  current.tail = next.catch(() => { if (open(ws)) ws.close(1013, 'Live dispatch failed'); });
  return current.tail;
}

async function process(t: Tendril, ws: WebSocket, message: Record<string, unknown>, current: () => boolean): Promise<void> {
  const kind = message.t;
  const keys = kind === 'signal_send' ? ['t', 'cid', 'topic', 'payload', 'issuedAtMs', 'expiresAtMs'] : ['t', 'cid'];
  if (!['signal_send', 'signal_subscribe', 'signal_unsubscribe'].includes(String(kind)) || Object.keys(message).some(key => !keys.includes(key)) ||
      message.cid !== undefined && (typeof message.cid !== 'string' || message.cid.length > 100)) throw error('signal_frame_invalid', 'Invalid live request');
  const principal = await authorize(t, ws);
  if (!current()) return;
  if (!canRead(principal)) throw error('signal_unauthorized', 'Live application signals require current page access');
  if (kind === 'signal_subscribe' || kind === 'signal_unsubscribe') {
    if (kind === 'signal_subscribe' && !metadata(ws).live?.subscribed &&
        t.ctx.getWebSockets().filter(target => open(target) && metadata(target).live?.subscribed).length >= 64)
      throw error('signal_subscription_limit', 'At most 64 live reader connections are allowed');
    save(ws, { ...state(ws), subscribed: kind === 'signal_subscribe' });
    if (message.cid !== undefined) send(ws, { t: 'signal_ack', cid: message.cid });
    return;
  }
  if (!canSend(principal)) throw error('signal_unauthorized', 'Display links receive signals but cannot send them');
  await requireWritesOpen(t.env);
  if (!current()) return;
  const topic = signalTopic(message.topic), payload = signalPayload(message.payload);
  const issuedAtMs = message.issuedAtMs as number, expiresAtMs = message.expiresAtMs as number;
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > LIMITS.maxTtlMs || issuedAtMs > t.now() + LIMITS.futureSkewMs)
    throw error('signal_frame_invalid', 'Invalid original dispatch time or expiry');
  if (expiresAtMs <= t.now()) throw error('signal_expired', 'Signal expired before dispatch');
  // Recheck local credentials after every asynchronous policy check.
  const authenticated = currentPrincipal(t, principal);
  if (!canSend(authenticated)) throw error('signal_unauthorized', 'Live sender access was revoked');
  const live = state(ws);
  const second = Math.floor(t.now() / 1000), count = live.second === second ? live.count + 1 : 1;
  if (count > LIMITS.sendsPerSecond) throw error('signal_route_backpressure', 'Live sender rate exceeded before dispatch');
  save(ws, { ...live, second, count });
  if (live.sequence >= Number.MAX_SAFE_INTEGER) { ws.close(1008, 'Live session sequence exhausted'); return; }
  const value: EphemeralSignal = { scope: `hosted:${t.tid}`,
    authorId: `${authenticated.kind}:${authenticated.name}`,
    sessionId: live.sessionId, sequence: live.sequence + 1, topic, payload, issuedAtMs, expiresAtMs };
  // Check the complete live audience before disclosing bytes, then use its
  // current socket metadata so concurrent transport credits cannot be lost.
  const targets = t.ctx.getWebSockets('signals').filter(target => target !== ws && open(target) && metadata(target).live?.subscribed);
  const authorized = await Promise.all(targets.map(async target => ({ target, principal: await authorize(t, target) })));
  if (!current()) return;
  if (expiresAtMs <= t.now()) throw error('signal_expired', 'Signal expired during live authorization');
  if (!canSend(currentPrincipal(t, principal))) throw error('signal_unauthorized', 'Live sender access was revoked');
  save(ws, { ...state(ws), sessionId: live.sessionId, sequence: value.sequence });
  for (const { target, principal: reader } of authorized) {
    if (!reader || !canRead(currentPrincipal(t, reader))) { if (open(target)) target.close(4003, 'Live reader access revoked'); continue; }
    const recipient = metadata(target).live;
    if (!open(target) || !recipient?.subscribed) continue;
    try { send(target, { t: 'signal', signal: value }); }
    catch { target.close(1013, 'Live delivery failed'); }
  }
  send(ws, { t: 'signal_ack', cid: message.cid, signal: value });
}
