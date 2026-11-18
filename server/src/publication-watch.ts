import { accountActive, currentPrincipal, pageAccessAllowed, type PagePrincipal } from "./access";
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
  if (t.ctx.getWebSockets(tag).filter(socket => socket.readyState === WebSocket.READY_STATE_OPEN).length >= 32)
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
  const permitted = pageAccessAllowed(t);
  const visitors = new Map<string, Promise<boolean>>();
  await Promise.all(watchers.map(async socket => {
    const { principal, key } = socket.deserializeAttachment() as Watch;
    try {
      let active = await permitted;
      if (active && principal.role === "guest" && principal.accountId) {
        let check = visitors.get(principal.accountId);
        if (!check) visitors.set(principal.accountId, check = accountActive(t, principal.accountId));
        active = await check;
      }
      if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
      if (active && currentPrincipal(t, principal, key)) ready(socket);
      else socket.close(4003, "Page access ended");
    } catch {
      try { socket.close(1011, "Publication watch interrupted"); } catch { /* disconnected */ }
    }
  }));
}
