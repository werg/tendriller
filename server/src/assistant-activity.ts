import { activeGrant } from './accounts/oauth-data';
import { activeAdapters, connection } from './assistant-admission';
import { APP_ID, assistantOAuth, type Principal } from './assistant-shared';
import { HttpError } from './http';
import { TENDRIL_ID_RE } from './ids';
import type { Env } from './env';
import type { Tendril } from './tendril';

export const ACTIVITY_PROTOCOL = 'tendriller.application-activity.v1';
export const ACTIVITY_TAG = 'application-activity';
const TTL = 30 * 60_000, limit = 4;
type Ticket = { p: string; a: string; v: string; g: string; exp: number };
type Attachment = Ticket & { tag: typeof ACTIVITY_TAG };
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/gu, '+').replace(/_/gu, '/')), c => c.charCodeAt(0));
const keys = new WeakMap<Env, { configured: string; key: Promise<CryptoKey> }>();
async function ticketKey(env: Env) {
  const configured = env.ASSISTANT_STORE_KEY;
  if (!configured) return null;
  try {
    let cached = keys.get(env);
    if (cached?.configured !== configured) {
      const bytes = decode(configured);
      if (bytes.byteLength !== 32) return null;
      const key = crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']).then(raw =>
        crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0),
          info: new TextEncoder().encode(ACTIVITY_PROTOCOL) }, raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
      cached = { configured, key };
      keys.set(env, cached);
    }
    return await cached.key;
  } catch { return null; }
}

export async function makeActivityTicket(t: Tendril, principal: Principal, version: string) {
  const scope = connection(t);
  if (!scope?.events.length) return null;
  const key = await ticketKey(t.env);
  if (!key) return null;
  const exp = Date.now() + TTL;
  const data: Ticket = { p: t.tid, a: principal.account, v: version, g: principal.grant, exp };
  const raw = new TextEncoder().encode(JSON.stringify(data));
  const proof = await crypto.subtle.sign('HMAC', key, raw);
  return { proof: encode(raw) + '.' + encode(new Uint8Array(proof)), exp };
}

export async function parseActivityTicket(env: Env, req: Request, pageId: string): Promise<Ticket | null> {
  if (!TENDRIL_ID_RE.test(pageId) || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return null;
  const protocols = req.headers.get('Sec-WebSocket-Protocol')?.split(',').map(s => s.trim()) ?? [];
  if (!protocols.includes(ACTIVITY_PROTOCOL)) return null;
  const proof = protocols.find(item => /^td_watch\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43}$/u.test(item));
  if (!proof) return null;
  try {
    const [, payload, signature] = proof.split('.'), raw = decode(payload), key = await ticketKey(env);
    if (!key || !await crypto.subtle.verify('HMAC', key, decode(signature), raw)) return null;
    const data: Ticket = JSON.parse(new TextDecoder().decode(raw));
    return data.p === pageId && data.exp > Date.now() ? data : null;
  } catch { return null; }
}

export function isAssistantActivity(ws: WebSocket) {
  return (ws.deserializeAttachment() as Attachment | null)?.tag === ACTIVITY_TAG;
}

export async function upgradeAssistantActivity(t: Tendril, req: Request) {
  const supplied = await parseActivityTicket(t.env, req, t.tid), oauth = await assistantOAuth(t.env), scope = connection(t);
  if (!supplied || !oauth || !scope?.events.length || supplied.a !== scope.owner || supplied.v !== scope.inboxVersion ||
      !activeAdapters(t).length || !APP_ID.test(scope.applicationId)) throw new HttpError(401, 'activity_ticket_expired');
  const grant = await activeGrant(t.env, oauth, supplied.g, supplied.a);
  if (!grant?.scope.split(' ').includes('applications:read') || connection(t)?.inboxVersion !== scope.inboxVersion)
    throw new HttpError(403, 'forbidden');
  const sockets = t.ctx.getWebSockets(ACTIVITY_TAG);
  if (sockets.length >= limit) throw new HttpError(429, 'activity_socket_limit');
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, [ACTIVITY_TAG]);
  server.serializeAttachment({ ...supplied, tag: ACTIVITY_TAG } satisfies Attachment);
  return new Response(null, { status: 101, headers: { 'Sec-WebSocket-Protocol': ACTIVITY_PROTOCOL }, webSocket: client });
}

/** Mounted inboxes receive a size-constant hint. A normal tool call fetches content. */
export async function notifyAssistantActivity(t: Tendril) {
  const sockets = t.ctx.getWebSockets(ACTIVITY_TAG);
  if (!sockets.length) return;
  const scope = connection(t), oauth = await assistantOAuth(t.env);
  if (!scope || !oauth) return;
  const grants = new Map<string, ReturnType<typeof activeGrant>>();
  await Promise.all(sockets.map(async socket => {
    const value = socket.deserializeAttachment() as Attachment | null;
    if (!value || value.exp <= Date.now() || value.v !== scope.inboxVersion) { socket.close(4003, 'Inbox access expired'); return; }
    let grant = grants.get(value.g);
    if (!grant) { grant = activeGrant(t.env, oauth, value.g, scope.owner); grants.set(value.g, grant); }
    if (!(await grant)?.scope.split(' ').includes('applications:read') || connection(t)?.inboxVersion !== scope.inboxVersion || !activeAdapters(t).length) {
      socket.close(4003, 'Inbox access revoked'); return;
    }
    try { socket.send('{"type":"changed"}'); } catch { /* disconnected */ }
  }));
}
