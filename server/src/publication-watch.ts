import { currentPrincipal, pagePolicy, type PagePrincipal } from "./access";
import { HttpError } from "./http";
import type { Tendril } from "./tendril";

const tag = "publication-watch";
interface Watch {
  kind: typeof tag;
  principal: PagePrincipal;
  key: string;
}

export function isPublicationWatch(socket: WebSocket): boolean {
  return socket.deserializeAttachment()?.kind === tag;
}

function ready(socket: WebSocket): void {
  socket.send("ready");
  socket.close(1000, "Publication ready");
}

export function watchPublication(t: Tendril, principal: PagePrincipal, key: string): Response {
  const active = t.ctx.getWebSockets(tag).filter(socket => {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return false;
    const watch = socket.deserializeAttachment() as Watch;
    if (currentPrincipal(t, watch.principal, watch.key)) return true;
    socket.close(4003, "Page access ended");
    return false;
  });
  if (active.length >= 32)
    throw new HttpError(429, "watch_limit", "Too many viewers waiting for publication");
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, [tag]);
  server.serializeAttachment({ kind: tag, principal, key } satisfies Watch);
  // A publication may have landed between delivery of the holding HTML and
  // this upgrade. The same replay covers reconnection and hibernation.
  if (t.db.get<number>("current", 0) > 0) ready(server);
  return new Response(null, { status: 101, webSocket: client });
}

export async function notifyPublicationWatchers(t: Tendril): Promise<void> {
  const watchers = t.ctx.getWebSockets(tag).filter(socket => socket.readyState === WebSocket.READY_STATE_OPEN);
  if (!watchers.length) return;
  const policies = new Map<string | null, ReturnType<typeof pagePolicy>>();
  await Promise.all(watchers.map(async socket => {
    const { principal, key } = socket.deserializeAttachment() as Watch;
    const visitor = principal.role === "guest" ? principal.accountId : null;
    try {
      let check = policies.get(visitor);
      if (!check) policies.set(visitor, check = pagePolicy(t, visitor));
      const active = await check === "active";
      if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
      if (active && currentPrincipal(t, principal, key)) ready(socket);
      else socket.close(4003, "Page access ended");
    } catch {
      try { socket.close(1011, "Publication watch interrupted"); } catch { /* disconnected */ }
    }
  }));
}
