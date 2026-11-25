import { currentPrincipal, pagePolicy, type PagePrincipal } from './access';
import { pageAgents } from './agent-grants';
import { HttpError } from './http';
import type { Tendril } from './tendril';

const tag = 'publication-watch';
export const PUBLICATION_WATCH_PROTOCOL = 'tendriller.publication.v1';
interface Watch {
  kind: typeof tag;
  protocol: 1;
  principal: PagePrincipal;
  key: string;
  current: number;
}
const attachment = (socket: WebSocket): Watch | null => {
  const value = socket.deserializeAttachment() as Watch | null;
  return value?.kind === tag && value.protocol === 1 ? value : null;
};
export const isPublicationWatch = (socket: WebSocket): boolean => socket.deserializeAttachment()?.kind === tag;
const selected = (t: Tendril) => t.db.get<number>('current', 0);
function send(socket: WebSocket, value: Watch, current: number): void {
  socket.send(JSON.stringify({ type: 'publication', version: 1, current }));
  socket.serializeAttachment({ ...value, current } satisfies Watch);
}
function sendAgents(t: Tendril, socket: WebSocket, value: Watch): void {
  if (value.principal.role === 'display') return;
  const roster = pageAgents(t);
  socket.send(JSON.stringify({
    type: 'agents',
    version: 1,
    primary_agent_id: roster.primary_agent_id,
    agents: roster.agents,
    can_manage: value.principal.role === 'owner',
  }));
}

/** Authentication belongs to the page, not to the independently enrolled application participant. */
export function watchPublication(t: Tendril, req: Request, principal: PagePrincipal, key: string): Response {
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(x => x.trim()).includes(PUBLICATION_WATCH_PROTOCOL))
    throw new HttpError(400, 'publication_protocol_required');
  const active = t.ctx.getWebSockets(tag).filter(socket => {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return false;
    const value = attachment(socket);
    if (value && currentPrincipal(t, value.principal, value.key)) return true;
    socket.close(4003, 'Page access ended'); return false;
  });
  if (active.length >= 32) throw new HttpError(429, 'watch_limit', 'Too many publication viewers');
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, [tag]);
  const value: Watch = { kind: tag, protocol: 1, principal, key, current: selected(t) };
  send(server, value, value.current);
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PUBLICATION_WATCH_PROTOCOL } });
}

/** Every committed selection (including earlier versions and zero) invalidates the displayed notice. */
export function notifyPublicationWatchers(t: Tendril): void {
  t.afterCommit(async () => {
    const policies = new Map<string | null, ReturnType<typeof pagePolicy>>();
    const watchers = t.ctx.getWebSockets(tag).filter(socket => socket.readyState === WebSocket.READY_STATE_OPEN);
    await Promise.all(watchers.map(async socket => {
      const value = attachment(socket);
      if (!value) { socket.close(4003, 'Publication watch expired'); return; }
      try {
        if (!currentPrincipal(t, value.principal, value.key)) { socket.close(4003, 'Page access ended'); return; }
        if (value.current === selected(t)) return;
        const visitor = value.principal.role === 'guest' ? value.principal.accountId : null;
        let policy = policies.get(visitor);
        if (!policy) policies.set(visitor, policy = pagePolicy(t, visitor));
        if (await policy !== 'active' || !currentPrincipal(t, value.principal, value.key)) { socket.close(4003, 'Page access ended'); return; }
        if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
        const current = selected(t), latest = attachment(socket);
        if (latest && latest.current !== current) send(socket, latest, current);
      } catch { try { socket.close(1011, 'Publication watch interrupted'); } catch { /* disconnected */ } }
    }));
  });
}

/** Notify open authenticated browser tabs whenever the page's agent roster or primary changes. */
export function notifyAgentsWatchers(t: Tendril): void {
  t.afterCommit(async () => {
    const policies = new Map<string | null, ReturnType<typeof pagePolicy>>();
    const watchers = t.ctx.getWebSockets(tag).filter(socket => socket.readyState === WebSocket.READY_STATE_OPEN);
    await Promise.all(watchers.map(async socket => {
      const value = attachment(socket);
      if (!value) { socket.close(4003, 'Page watch expired'); return; }
      if (value.principal.role === 'display') return;
      try {
        if (!currentPrincipal(t, value.principal, value.key)) { socket.close(4003, 'Page access ended'); return; }
        const visitor = value.principal.role === 'guest' ? value.principal.accountId : null;
        let policy = policies.get(visitor);
        if (!policy) policies.set(visitor, policy = pagePolicy(t, visitor));
        if (await policy !== 'active' || !currentPrincipal(t, value.principal, value.key)) { socket.close(4003, 'Page access ended'); return; }
        if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
        sendAgents(t, socket, value);
      } catch { try { socket.close(1011, 'Page watch interrupted'); } catch { /* disconnected */ } }
    }));
  });
}
