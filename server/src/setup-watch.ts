import { currentPrincipal, freshPrincipal, pageAccessAllowed, requireAgentScope, type AgentPrincipal } from './access';
import { HttpError } from './http';
import type { Tendril } from './tendril';

export const SETUP_WATCH_PROTOCOL = 'tendriller.setup.v1';
const TAG = 'setup-watch';
interface Attachment { kind: typeof TAG; principal: AgentPrincipal }
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

/** A bounded, receive-only setup channel. No heartbeat, timer, payload queue or application data. */
export async function upgradeSetupWatch(t: Tendril, req: Request, principal: AgentPrincipal) {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'websocket_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(x => x.trim()).includes(SETUP_WATCH_PROTOCOL))
    throw new HttpError(400, 'setup_protocol_required');
  if (!await authorized(t, principal)) throw new HttpError(403, 'forbidden');
  const sockets = t.ctx.getWebSockets(TAG).filter(ws => {
    const old = attachment(ws);
    if (!old || ws.readyState !== WebSocket.READY_STATE_OPEN) return false;
    if (!currentPrincipal(t, old.principal)) { ws.close(4003, 'Setup access revoked'); return false; }
    return true;
  });
  if (sockets.length >= 8 || sockets.filter(ws => attachment(ws)?.principal.agentId === principal.agentId).length >= 2)
    throw new HttpError(429, 'setup_watch_full');
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, [TAG]);
  server.serializeAttachment({ kind: TAG, principal } satisfies Attachment);
  server.send(snapshot(t)); // Reconnection reconciles changes missed while disconnected.
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': SETUP_WATCH_PROTOCOL } });
}

export function notifySetupChanged(t: Tendril): void {
  t.afterCommit(async () => {
    for (const ws of t.ctx.getWebSockets(TAG)) {
      const value = attachment(ws);
      if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      try {
        if (!await authorized(t, value.principal)) { ws.close(4003, 'Setup access revoked'); continue; }
        ws.send(snapshot(t));
      } catch { try { ws.close(4003, 'Setup access unavailable'); } catch {} }
    }
  });
}
