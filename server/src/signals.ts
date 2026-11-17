import { HOSTED_SIGNAL_PROTOCOL, SIGNAL_LIMITS, validateSignalInput } from '../../contract/hosted-signals.mjs';
import type { EphemeralSignal } from '../../contract/signals.mjs';
import type { Principal } from './access';
import { accountActive, currentPrincipal, pageAccessAllowed, socketPrincipal } from './access';
import { requireCloudflareApplication, selectedApplication } from './application';
import { HttpError } from './http';
import type { Tendril } from './tendril';

/** Session metadata only: no payloads, application receipts, stream rows or replay. */
export interface SignalSession { sessionId: string; sequence: number; subscribed: boolean; second: number; count: number }
interface SignalAttachment { kind: 'signals'; principal: Principal; live: SignalSession }
const session = (): SignalSession => ({ sessionId: crypto.randomUUID(), sequence: 0, subscribed: false, second: 0, count: 0 });
const attached = (ws: WebSocket): SignalAttachment | null => {
  const value = ws.deserializeAttachment();
  return value?.kind === 'signals' ? value : null;
};
export const isSignalSocket = (ws: WebSocket): boolean => attached(ws) !== null;
function principal(t: Tendril, ws: WebSocket): Principal | null {
  const live = attached(ws);
  return live ? currentPrincipal(t, live.principal) : socketPrincipal(t, ws);
}
function state(ws: WebSocket): SignalSession {
  const value = ws.deserializeAttachment();
  if (!value) throw new HttpError(403, 'forbidden');
  if (!value.live) ws.serializeAttachment({ ...value, live: session() });
  return ws.deserializeAttachment().live;
}
function update(ws: WebSocket, value: SignalSession): void { ws.serializeAttachment({ ...ws.deserializeAttachment(), live: value }); }
const canRead = (value: Principal | null): value is Exclude<Principal, { kind: 'producer' }> => !!value && value.kind !== 'producer';
const canSend = (value: Principal | null): boolean => canRead(value) && (value.kind === 'agent' || value.role !== 'display');
const actor = (value: Principal): string => `${value.kind}:${value.name}`;
const open = (ws: WebSocket): boolean => ws.readyState === WebSocket.READY_STATE_OPEN;
function send(ws: WebSocket, message: unknown): void {
  if (!open(ws)) return;
  if ((ws as WebSocket & { bufferedAmount?: number }).bufferedAmount! > 256 * 1024) {
    ws.close(1013, 'Live signal receiver is too slow'); return;
  }
  try { ws.send(JSON.stringify(message)); } catch { try { ws.close(1013, 'Live signal connection failed'); } catch {} }
}

export async function openSignalSocket(t: Tendril, req: Request, identity: Principal): Promise<Response> {
  requireCloudflareApplication(t);
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes(HOSTED_SIGNAL_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Live connections require ${HOSTED_SIGNAL_PROTOCOL}`);
  if (!canRead(currentPrincipal(t, identity)) || !await pageAccessAllowed(t) ||
      identity.kind === 'page' && identity.accountId && !await accountActive(t, identity.accountId) ||
      !canRead(currentPrincipal(t, identity))) throw new HttpError(403, 'forbidden', 'Live signal access revoked');
  if (t.ctx.getWebSockets('signals').filter(open).length >= SIGNAL_LIMITS.connections)
    throw new HttpError(429, 'signal_overflow', 'Too many live signal connections');
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, ['signals']);
  server.serializeAttachment({ kind: 'signals', principal: identity, live: session() } satisfies SignalAttachment);
  send(server, { t: 'signal_ready', scope: selectedApplication(t).id });
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': HOSTED_SIGNAL_PROTOCOL } });
}

/** The existing browser socket and explicit SDK sockets share live authorization and fanout. */
export async function signalCommand(t: Tendril, ws: WebSocket, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  requireCloudflareApplication(t);
  let author = principal(t, ws);
  if (!canRead(author) || !open(ws)) throw new HttpError(403, 'forbidden', 'Live signal access revoked');
  if (message.t === 'signal_subscribe' || message.t === 'signal_unsubscribe') {
    if (Object.keys(message).some(key => !['t', 'cid'].includes(key))) throw new HttpError(400, 'invalid_signal', 'Live subscriptions have no replay cursor');
    update(ws, { ...state(ws), subscribed: message.t === 'signal_subscribe' });
    return { subscribed: message.t === 'signal_subscribe' };
  }
  if (message.t !== 'signal_send' || Object.keys(message).some(key => !['t', 'cid', 'message'].includes(key)))
    throw new HttpError(400, 'invalid_signal', 'Unknown live signal command');
  if (!canSend(author)) throw new HttpError(403, 'forbidden', 'Display links cannot send live signals');
  let input;
  try { input = validateSignalInput(message.message, t.now()); }
  catch (error) { throw new HttpError(400, (error as { code?: string }).code ?? 'invalid_signal', (error as Error).message); }
  const current = state(ws), second = Math.floor(t.now() / 1000), count = current.second === second ? current.count + 1 : 1;
  if (count > 50) throw new HttpError(429, 'signal_overflow', 'Live sender rate exceeded');
  update(ws, { ...current, second, count });
  if (!await pageAccessAllowed(t) || author.kind === 'page' && author.accountId && !await accountActive(t, author.accountId))
    throw new HttpError(403, 'forbidden', 'Live signal access revoked');
  author = principal(t, ws);
  if (!canSend(author) || !open(ws)) throw new HttpError(403, 'forbidden', 'Live signal access revoked');
  if (input.expiresAtMs <= t.now()) throw new HttpError(409, 'signal_expired', 'The live message expired before dispatch');
  const next = state(ws);
  if (!Number.isSafeInteger(next.sequence + 1)) throw new HttpError(429, 'signal_overflow', 'Reconnect to start a new live session');
  const envelope: EphemeralSignal = { ...input, scope: selectedApplication(t).id, authorId: actor(author!), sessionId: next.sessionId, sequence: next.sequence + 1 };
  update(ws, { ...next, sequence: envelope.sequence });
  const accounts = new Map<string, boolean>();
  for (const recipient of t.ctx.getWebSockets()) {
    if (recipient === ws || !open(recipient) || !recipient.deserializeAttachment()?.live?.subscribed) continue;
    let reader = principal(t, recipient);
    if (reader?.kind === 'page' && reader.accountId) {
      if (!accounts.has(reader.accountId)) accounts.set(reader.accountId, await accountActive(t, reader.accountId));
      if (!accounts.get(reader.accountId)) { recipient.close(4003, 'Live access revoked'); continue; }
    }
    // Account lookups yield: recheck both endpoints and expiry before releasing bytes.
    reader = principal(t, recipient);
    if (!canRead(reader)) { recipient.close(4003, 'Live access revoked'); continue; }
    if (!canSend(principal(t, ws)) || !open(ws)) throw new HttpError(403, 'forbidden', 'Live sender access revoked');
    if (input.expiresAtMs <= t.now()) break;
    if (recipient.deserializeAttachment()?.live?.subscribed) send(recipient, { t: 'signal', signal: envelope });
  }
  return { signal: envelope };
}

interface Pending { tail: Promise<void>; count: number; bytes: number }
const queues = new WeakMap<WebSocket, Pending>();
/** Bound work before asynchronous authorization, then preserve each session's order. */
export async function handleSignalMessage(t: Tendril, ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
  if (!open(ws)) return;
  if (!t.exists()) { ws.close(4004, 'Tendril deleted'); return; }
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw).length : raw.byteLength;
  if (typeof raw !== 'string' || bytes > SIGNAL_LIMITS.bytes) { ws.close(1009, 'Live message is too large'); return; }
  let queue = queues.get(ws);
  if (!queue) { queue = { tail: Promise.resolve(), count: 0, bytes: 0 }; queues.set(ws, queue); }
  if (queue.count >= SIGNAL_LIMITS.pending || queue.bytes + bytes > SIGNAL_LIMITS.bytes * SIGNAL_LIMITS.pending) {
    ws.close(1013, 'Live signal sender is too fast'); return;
  }
  queue.count++; queue.bytes += bytes;
  const current = queue;
  const task = current.tail.then(async () => {
    if (!open(ws)) return;
    let cid: string | undefined;
    try {
      const message = JSON.parse(raw);
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.cid !== 'string' ||
          !/^[A-Za-z0-9_.:-]{1,200}$/.test(message.cid)) { ws.close(1008, 'Invalid live request'); return; }
      cid = message.cid;
      send(ws, { t: 'ack', cid, ...await signalCommand(t, ws, message) });
    } catch (error) {
      send(ws, { t: 'ack', cid, error: error instanceof HttpError ? error.code : 'invalid_signal', message: (error as Error).message });
    }
  }).finally(() => { current.count--; current.bytes -= bytes; });
  current.tail = task.catch(() => { if (open(ws)) ws.close(1011, 'Live signal dispatch failed'); });
  await current.tail;
}
