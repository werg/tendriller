import { currentPrincipal, freshPrincipal, pageAccessAllowed, requireAgentScope, type AgentPrincipal } from './access';
import { HttpError } from './http';
import {
  closeHubSubscriber, deliverHubData, listHubSubscribers, putHubSubscriber,
  type HubStreamOpenResult, type HubStreamRef,
} from './hub-streams';
import type { Tendril } from './tendril';

export const SETUP_WATCH_PROTOCOL = 'tendriller.setup.v1';
const TAG = 'setup-watch';
interface SetupState { principal: AgentPrincipal }
interface Attachment extends SetupState { kind: typeof TAG }
const attachment = (ws: WebSocket) => {
  const value = ws.deserializeAttachment() as Attachment | null;
  return value?.kind === TAG ? value : null;
};
export const isSetupWatch = (ws: WebSocket) => attachment(ws) !== null;
function snapshot(t: Tendril) {
  const mcp = t.db.all<{ grant_id: string; updated_at: number }>('SELECT grant_id,updated_at FROM mcp_connections ORDER BY grant_id');
  return JSON.stringify({ type: 'setup', version: 1,
    mcp: { connected: mcp.length > 0, grants: mcp.map(item => item.grant_id), updatedAt: mcp.reduce((max, item) => Math.max(max, item.updated_at), 0) } });
}
async function authorized(t: Tendril, principal: AgentPrincipal) {
  requireAgentScope(principal, 'control:write');
  return Boolean(currentPrincipal(t, principal)) && await pageAccessAllowed(t) && await freshPrincipal(t, principal)
    && Boolean(currentPrincipal(t, principal));
}

function activeWatchers(t: Tendril): AgentPrincipal[] {
  const result: AgentPrincipal[] = [];
  for (const ws of t.ctx.getWebSockets(TAG)) {
    const old = attachment(ws);
    if (!old || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
    if (!currentPrincipal(t, old.principal)) { ws.close(4003, 'Setup access revoked'); continue; }
    result.push(old.principal);
  }
  for (const sub of listHubSubscribers<SetupState>(t, TAG)) {
    if (!currentPrincipal(t, sub.state.principal)) {
      closeHubSubscriber(t, sub, 4003, 'Setup access revoked');
      continue;
    }
    result.push(sub.state.principal);
  }
  return result;
}

/** A bounded, receive-only setup channel. No heartbeat, timer, payload queue or application data. */
export async function upgradeSetupWatch(t: Tendril, req: Request, principal: AgentPrincipal) {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'websocket_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(x => x.trim()).includes(SETUP_WATCH_PROTOCOL))
    throw new HttpError(400, 'setup_protocol_required');
  if (!await authorized(t, principal)) throw new HttpError(403, 'forbidden');
  const watchers = activeWatchers(t);
  if (watchers.length >= 8 || watchers.filter(p => p.agentId === principal.agentId).length >= 2)
    throw new HttpError(429, 'setup_watch_full');
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, [TAG]);
  server.serializeAttachment({ kind: TAG, principal } satisfies Attachment);
  server.send(snapshot(t)); // Reconnection reconciles changes missed while disconnected.
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': SETUP_WATCH_PROTOCOL } });
}

/** Stateless hub-backed setup watch subscription. */
export async function openSetupHubStream(
  t: Tendril,
  protocols: string[],
  principal: AgentPrincipal,
  ref: HubStreamRef,
): Promise<HubStreamOpenResult> {
  if (!protocols.includes(SETUP_WATCH_PROTOCOL)) throw new HttpError(400, 'setup_protocol_required');
  if (!await authorized(t, principal)) throw new HttpError(403, 'forbidden');
  const watchers = activeWatchers(t);
  if (watchers.length >= 8 || watchers.filter(p => p.agentId === principal.agentId).length >= 2)
    throw new HttpError(429, 'setup_watch_full');
  putHubSubscriber<SetupState>(t, { ...ref, kind: TAG, state: { principal }, createdAt: t.now() });
  return { protocol: SETUP_WATCH_PROTOCOL, initial: [snapshot(t)] };
}

export function notifySetupChanged(t: Tendril): void {
  t.afterCommit(async () => {
    for (const ws of t.ctx.getWebSockets(TAG)) {
      const value = attachment(ws);
      if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      try {
        if (!await authorized(t, value.principal)) { ws.close(4003, 'Setup access revoked'); continue; }
        ws.send(snapshot(t));
      } catch (err) {
        const revoked = err instanceof HttpError && err.status === 403;
        try { ws.close(revoked ? 4003 : 1013, revoked ? 'Setup access unavailable' : 'Transient setup error; reconnect'); } catch {}
      }
    }
    for (const sub of listHubSubscribers<SetupState>(t, TAG)) {
      try {
        if (!await authorized(t, sub.state.principal)) { closeHubSubscriber(t, sub, 4003, 'Setup access revoked'); continue; }
        const delivery = await deliverHubData(t, sub, snapshot(t));
        if (delivery === 'gone') closeHubSubscriber(t, sub, 1001, 'Hub stream unavailable', { notify: false });
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) closeHubSubscriber(t, sub, 4003, 'Setup access unavailable');
      }
    }
  });
}
