import { SIGNAL_LIMITS as LIMITS, HOSTED_SIGNAL_PROTOCOL, validateSignalInput } from '../../contract/hosted-signals.mjs';
import { SignalError } from '../../contract/signals.mjs';
import type { EphemeralSignal } from '../../contract/signals.mjs';
import { accountActive, authorizeSocket, currentPrincipal, pageAccessAllowed, socketPrincipal, type Principal } from './access';
import { selectedApplication } from './application';
import { HttpError } from './http';
import type { Tendril } from './tendril';

export interface SignalSession { sessionId: string; sequence: number; subscribed: boolean; second: number; count: number }
interface SignalAttachment { kind?: string; principal?: Principal; live?: SignalSession }
const attachment = (ws: WebSocket): SignalAttachment => ws.deserializeAttachment() ?? {};
export const isSignalSocket = (ws: WebSocket): boolean => attachment(ws).kind === 'signals';
const session = (): SignalSession => ({ sessionId: crypto.randomUUID(), sequence: 0, subscribed: false, second: 0, count: 0 });
const live = (ws: WebSocket): SignalSession => {
  const value = attachment(ws);
  if (value.live) return value.live;
  const created = session(); ws.serializeAttachment({ ...value, live: created }); return created;
};
const save = (ws: WebSocket, value: SignalSession) => ws.serializeAttachment({ ...attachment(ws), live: value });
const authorized = (t: Tendril, principal: Principal): boolean => {
  const current = currentPrincipal(t, principal);
  return !!current && (current.kind === 'agent' || current.kind === 'page' && current.role === 'owner');
};
const current = (t: Tendril, ws: WebSocket): Principal | null => {
  const value = attachment(ws);
  const principal = value.kind === 'signals' && value.principal ? currentPrincipal(t, value.principal) : socketPrincipal(t, ws);
  return principal && authorized(t, principal) ? principal : null;
};
function revokeLive(ws: WebSocket): void {
  const value = attachment(ws);
  if (value.live?.subscribed) ws.serializeAttachment({ ...value, live: { ...value.live, subscribed: false } });
  // The live handler owns dedicated sessions, but only its subscription on a
  // shared page socket. Durable socket authorization has its own lifecycle.
  if (value.kind === 'signals') { try { ws.close(4003, 'Live signal access revoked'); } catch { /* Already closed. */ } }
}
/** Reclaim locally revoked slots without queuing asynchronous account checks. */
function currentLiveSockets(t: Tendril): WebSocket[] {
  return t.ctx.getWebSockets().filter(ws => {
    const value = attachment(ws);
    if (ws.readyState !== WebSocket.READY_STATE_OPEN || !value.live && value.kind !== 'signals') return false;
    if (current(t, ws)) return true;
    revokeLive(ws); return false;
  });
}
async function principalFor(t: Tendril, ws: WebSocket): Promise<Principal | null> {
  if (!isSignalSocket(ws)) {
    const principal = await authorizeSocket(t, ws, { fresh: true });
    return principal && authorized(t, principal) ? principal : null;
  }
  const principal = current(t, ws);
  if (!principal || !await pageAccessAllowed(t) ||
      principal.kind === 'page' && principal.accountId && !await accountActive(t, principal.accountId)) return null;
  return current(t, ws);
}

/** Transport pressure drops live traffic; it never closes the shared durable socket. */
function send(ws: WebSocket, message: unknown): boolean {
  if (ws.readyState !== WebSocket.READY_STATE_OPEN) return false;
  const encoded = JSON.stringify(message);
  if (((ws as WebSocket & { bufferedAmount?: number }).bufferedAmount ?? 0) + new TextEncoder().encode(encoded).byteLength > LIMITS.pendingBytes)
    return false;
  try { ws.send(encoded); return true; }
  catch {
    // Actual transport failure can retire a dedicated live connection. The
    // live handler never owns the lifecycle of a shared durable page socket.
    if (isSignalSocket(ws)) { try { ws.close(1011, 'Live signal connection failed'); } catch { /* Already closed. */ } }
    return false;
  }
}

/** A live session is not a conversation listener or a retained application writer. */
export async function openSignalSocket(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes(HOSTED_SIGNAL_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Signals require ${HOSTED_SIGNAL_PROTOCOL}`);
  if (!authorized(t, principal) || !await pageAccessAllowed(t) ||
      principal.kind === 'page' && principal.accountId && !await accountActive(t, principal.accountId) || !authorized(t, principal))
    throw new HttpError(403, 'forbidden', 'Hosted signals are private to page owners and agents');
  if (currentLiveSockets(t).filter(isSignalSocket).length >= LIMITS.connections)
    throw new HttpError(429, 'signal_backpressure', 'Too many live signal connections');
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, ['signals']);
  server.serializeAttachment({ kind: 'signals', principal, live: session() } satisfies SignalAttachment);
  server.send(JSON.stringify({ t: 'signal_ready', scope: selectedApplication(t).id }));
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': HOSTED_SIGNAL_PROTOCOL } });
}

const busy = new WeakSet<WebSocket>(), active = new WeakMap<Tendril, number>();
/** Bounded live work: no authorization backlog, SQL payload, event, outbox or wake. */
export async function handleSignalMessage(t: Tendril, ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
  if (ws.readyState !== WebSocket.READY_STATE_OPEN) return;
  let cid: string | undefined, entered = false;
  try {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > LIMITS.frameBytes) {
      // Malformed oversized input is a protocol violation, not ordinary pressure.
      if (isSignalSocket(ws)) ws.close(1009, 'Live frame exceeds 20 KiB');
      throw new SignalError('signal_too_large', 'Signal frame exceeds 20 KiB');
    }
    const input = JSON.parse(raw);
    if (input && typeof input.cid === 'string' && input.cid.length <= 80) cid = input.cid;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        !['signal_send', 'signal_subscribe', 'signal_unsubscribe'].includes(input.t) ||
        typeof input.cid !== 'string' || input.cid.length > 80 || !input.cid.length ||
        Object.keys(input).some(key => !['t', 'cid', ...(input.t === 'signal_send' ? ['message'] : [])].includes(key)))
      throw new SignalError('invalid_signal', 'Invalid live signal request');
    cid = input.cid;
    if (!current(t, ws)) throw new SignalError('signal_unauthorized', 'Hosted signals require a current owner or agent identity');
    const state = live(ws);
    if (input.t !== 'signal_send') {
      const subscribed = input.t === 'signal_subscribe';
      if (subscribed && !state.subscribed && currentLiveSockets(t).filter(peer => attachment(peer).live?.subscribed).length >= LIMITS.connections)
        throw new SignalError('signal_backpressure', 'Too many live signal subscribers');
      // No I/O: unsubscribe takes effect even while another message awaits
      // authorization. Every payload delivery still checks account access fresh.
      state.subscribed = subscribed; save(ws, state);
      send(ws, { t: 'ack', cid }); return;
    }
    if (busy.has(ws) || (active.get(t) ?? 0) >= LIMITS.authorizations)
      throw new SignalError('signal_backpressure', 'Live authorization is busy');
    const value = validateSignalInput(input.message, t.now());
    const second = Math.floor(t.now() / 1000);
    if (state.second !== second) { state.second = second; state.count = 0; }
    if (++state.count > LIMITS.messagesPerSecond) { save(ws, state); throw new SignalError('signal_backpressure', 'Live message rate exceeded'); }
    save(ws, state);
    busy.add(ws); active.set(t, (active.get(t) ?? 0) + 1); entered = true;
    const principal = await principalFor(t, ws);
    if (!principal || !authorized(t, principal)) throw new SignalError('signal_unauthorized', 'Hosted signals require a current owner or agent identity');
    if (value.expiresAtMs <= t.now()) throw new SignalError('signal_expired', 'Signal expired before live dispatch');
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) return;
    // Refresh metadata after I/O so a concurrent unsubscribe is not overwritten.
    const currentSession = live(ws);
    if (!Number.isSafeInteger(currentSession.sequence + 1)) throw new SignalError('signal_closed', 'Start a fresh live sender session');
    currentSession.sequence++; save(ws, currentSession);
    const envelope: EphemeralSignal = { scope: selectedApplication(t).id,
      authorId: principal.kind === 'agent' ? `agent:${principal.name}` : `account:${principal.kind === 'page' ? principal.accountId : ''}`,
      sessionId: currentSession.sessionId, sequence: currentSession.sequence, ...value };
    const recipients = currentLiveSockets(t).filter(peer => peer !== ws && attachment(peer).live?.subscribed).slice(0, LIMITS.connections);
    for (const peer of recipients) {
      if (t.now() >= value.expiresAtMs || !authorized(t, principal) || ws.readyState !== WebSocket.READY_STATE_OPEN) break;
      const recipient = await principalFor(t, peer);
      // All local authorization and subscription checks occur again after each
      // asynchronous account read, immediately before any bytes are released.
      if (t.now() >= value.expiresAtMs || !authorized(t, principal) || ws.readyState !== WebSocket.READY_STATE_OPEN) break;
      if (!recipient || !authorized(t, recipient)) { revokeLive(peer); continue; }
      if (!attachment(peer).live?.subscribed) continue;
      send(peer, { t: 'signal', signal: envelope });
    }
    if (!authorized(t, principal)) throw new SignalError('signal_unauthorized', 'Signal access changed during dispatch');
    send(ws, { t: 'ack', cid, signal: envelope });
  } catch (error) {
    send(ws, { t: 'ack', cid, error: error instanceof SignalError || error instanceof HttpError ? error.code : 'invalid_signal',
      message: error instanceof Error ? error.message : 'Invalid live signal' });
  } finally {
    if (entered) { busy.delete(ws); active.set(t, Math.max(0, (active.get(t) ?? 1) - 1)); }
  }
}
