/**
 * One AgentHub Durable Object per agent multiplexes its control traffic: setup
 * notices, discovery, invitations, WebRTC rendezvous and assistant adapters
 * become virtual streams onto the page objects' existing socket endpoints.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { AGENT_HEADER, AGENT_SCOPES_HEADER } from './access';
import { HUB_PROTOCOL } from './agents';
import { HttpError, json, readJson, toErrorResponse } from './http';
import { AGENT_ID_RE, AGENT_TOKEN_RE, TENDRIL_ID_RE } from './ids';

/** Page socket endpoints reachable through the hub. `peers/relay` stays a direct per-page socket. */
export const HUB_PATHS = new Set(['setup/watch', 'peers/discovery/watch', 'peers/invitations', 'peers/rendezvous']);
export const HUB_LIMITS = Object.freeze({ streams: 64, frameBytes: 1024 * 1024, protocols: 8, queuedFrames: 256 });
const AGENT_TAG = 'agent';
const PROTOCOL_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;

interface Stream {
  s: number; page: string; path: string; agent: WebSocket;
  socket?: WebSocket; queue: (string | ArrayBuffer)[]; queued: number; closing?: { code: number; reason: string };
}
type Frame = Record<string, unknown> & { t?: unknown };

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function toBase64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}
function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text), out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}
/** Close codes an endpoint may send: 1000 or the registered/private 3000-4999 range. */
function closeCode(value: unknown, fallback = 1000): number {
  return Number.isInteger(value) && (value === 1000 || (value as number) >= 3000 && (value as number) <= 4999) ? value as number : fallback;
}
function closeReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  let reason = value;
  while (bytes(reason) > 123) reason = reason.slice(0, -1);
  return reason;
}

export class AgentHub extends DurableObject<Env> {
  declare env: Env;
  private streams = new Map<number, Stream>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/connect") return this.accept(req);
      if (url.pathname === '/event' && req.method === 'POST') {
        const body = await readJson(req, 64 * 1024);
        if (typeof body.page !== 'string' || !TENDRIL_ID_RE.test(body.page) || typeof body.kind !== 'string') throw new HttpError(400, 'bad_request');
        const delivered = this.send({ t: 'event', page: body.page, kind: body.kind, data: body.data ?? {} });
        if (body.kind === 'revoked' || body.kind === 'page-deleted')
          for (const stream of [...this.streams.values()]) if (stream.page === body.page) this.closeStream(stream, 4003, 'Agent access revoked');
        return json({ delivered }, 202);
      }
      if (url.pathname === '/close' && req.method === 'POST') {
        const body = await readJson(req, 4096);
        const reason = closeReason(body.reason ?? 'Agent disconnected');
        for (const stream of [...this.streams.values()]) this.closeStream(stream, 4003, reason);
        for (const ws of this.ctx.getWebSockets(AGENT_TAG)) try { ws.close(4003, reason); } catch { /* gone */ }
        return json({ closed: true });
      }
      if (url.pathname === '/state' && req.method === 'GET')
        return json({ connected: !!this.current(), streams: [...this.streams.values()].map(({ s, page, path, socket }) => ({ s, page, path, open: !!socket })) });
      throw new HttpError(404, 'not_found');
    } catch (error) { return toErrorResponse(error); }
  }

  /** The router authenticated the token; a newer connection replaces the older one. */
  private accept(req: Request): Response {
    const agentId = req.headers.get(AGENT_HEADER) ?? '';
    if (!AGENT_ID_RE.test(agentId)) throw new HttpError(401, 'unauthorized');
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'websocket_required');
    for (const stream of [...this.streams.values()]) this.closeStream(stream, 1001, 'Hub connection replaced');
    for (const ws of this.ctx.getWebSockets(AGENT_TAG)) try { ws.close(4000, 'Replaced by a newer hub connection'); } catch { /* gone */ }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [AGENT_TAG]);
    server.serializeAttachment({ agentId });
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': HUB_PROTOCOL } });
  }

  private current(): WebSocket | null {
    return this.ctx.getWebSockets(AGENT_TAG).find(ws => ws.readyState === WebSocket.READY_STATE_OPEN) ?? null;
  }

  private send(frame: Record<string, unknown>, to: WebSocket | null = this.current()): boolean {
    if (!to || to.readyState !== WebSocket.READY_STATE_OPEN) return false;
    try { to.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') { ws.close(1003, 'Hub frames are JSON text'); return; }
    if (bytes(message) > HUB_LIMITS.frameBytes) { ws.close(1009, 'Hub frame exceeds 1 MiB'); return; }
    let frame: Frame;
    try { frame = JSON.parse(message); if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('frame'); }
    catch { ws.close(1008, 'Invalid hub frame'); return; }
    if (frame.t === 'ping') { this.send({ t: 'pong' }, ws); return; }
    if (frame.t === 'pong') return;
    const s = frame.s;
    if (!Number.isInteger(s) || (s as number) < 1 || (s as number) > 2 ** 31) { ws.close(1008, 'Invalid stream id'); return; }
    if (frame.t === 'open') { await this.open(ws, s as number, frame); return; }
    if (frame.t === 'data') { this.data(ws, s as number, frame); return; }
    if (frame.t === 'close') {
      const stream = this.streams.get(s as number);
      if (stream) this.closeStream(stream, closeCode(frame.code), closeReason(frame.reason));
      return;
    }
    ws.close(1008, 'Unknown hub frame type');
  }

  private async open(ws: WebSocket, s: number, frame: Frame): Promise<void> {
    const agentId = (ws.deserializeAttachment() as { agentId?: string } | null)?.agentId ?? '';
    if (this.streams.has(s)) { ws.close(1008, 'Stream id in use'); return; }
    const page = frame.page, rawPath = frame.path, protocols = frame.protocols ?? [];
    const [path, query = ''] = typeof rawPath === 'string' ? rawPath.split(/\?(.*)/s, 2) : [''];
    const refuse = (status: number, code: string) => this.send({ t: 'closed', s, code: 4000 + status, reason: code }, ws);
    if (typeof page !== 'string' || !TENDRIL_ID_RE.test(page) || !HUB_PATHS.has(path) || !Array.isArray(protocols) ||
        protocols.length > HUB_LIMITS.protocols || protocols.some(value => typeof value !== 'string' || !PROTOCOL_RE.test(value) || AGENT_TOKEN_RE.test(value))) {
      refuse(400, 'invalid_stream'); return;
    }
    if (this.streams.size >= HUB_LIMITS.streams) { refuse(429, 'stream_limit'); return; }
    const stream: Stream = { s, page, path, agent: ws, queue: [], queued: 0 };
    this.streams.set(s, stream);
    let response: Response;
    try {
      // Every open rechecks the agent and its page grant in D1.
      const grant = await this.env.ACCOUNTS.prepare(`SELECT g.scopes FROM agents a LEFT JOIN accounts c ON c.id=a.account_id
        JOIN agent_grants g ON g.agent_id=a.id AND g.page_id=?
        WHERE a.id=? AND a.revoked_at IS NULL AND (a.account_id IS NULL OR (c.suspended_at IS NULL AND c.deleting_at IS NULL))`)
        .bind(page, agentId).first<{ scopes: string }>();
      if (!grant) throw new HttpError(404, 'not_found', 'No such granted page');
      if (this.env.AGENT_RATE && !(await this.env.AGENT_RATE.limit({ key: 'agent:' + agentId })).success) throw new HttpError(429, 'rate_limited');
      const target = new URL('https://tendril.internal/agent');
      target.search = query;
      response = await this.env.TENDRIL.get(this.env.TENDRIL.idFromName(page)).fetch(new Request(target.toString(), { headers: {
        Upgrade: 'websocket', ...(protocols.length ? { 'Sec-WebSocket-Protocol': (protocols as string[]).join(', ') } : {}),
        'x-tendril-id': page, 'x-tendril-rest': encodeURIComponent(path),
        [AGENT_HEADER]: agentId, [AGENT_SCOPES_HEADER]: (JSON.parse(grant.scopes) as string[]).join(' '),
      } }));
    } catch (error) { response = toErrorResponse(error); }
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) {
      let code = 'refused';
      try { code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? code; } catch { /* status only */ }
      if (this.streams.get(s) === stream) this.streams.delete(s);
      refuse(Math.min(999, Math.max(0, response.status)), code);
      return;
    }
    socket.accept();
    if (this.streams.get(s) !== stream || stream.closing) {
      const closing = stream.closing ?? { code: 1001, reason: 'Hub stream cancelled' };
      try { socket.close(closing.code, closing.reason); } catch { /* gone */ }
      if (this.streams.get(s) === stream) this.streams.delete(s);
      this.send({ t: 'closed', s, code: closing.code, reason: closing.reason }, ws);
      return;
    }
    stream.socket = socket;
    socket.addEventListener('message', event => {
      if (this.streams.get(s) !== stream) return;
      const frame = typeof event.data === 'string' ? { t: 'data', s, text: event.data } : { t: 'data', s, base64: toBase64(event.data as ArrayBuffer) };
      const text = JSON.stringify(frame);
      if (bytes(text) > HUB_LIMITS.frameBytes) { this.closeStream(stream, 1009, 'Stream message exceeds the hub frame limit'); return; }
      try { stream.agent.send(text); } catch { this.closeStream(stream, 1011, 'Hub connection unavailable'); }
    });
    socket.addEventListener('close', event => {
      if (this.streams.get(s) !== stream) return;
      this.streams.delete(s);
      this.send({ t: 'closed', s, code: event.code, reason: event.reason }, stream.agent);
    });
    socket.addEventListener('error', () => {
      if (this.streams.get(s) !== stream) return;
      this.streams.delete(s);
      this.send({ t: 'closed', s, code: 1011, reason: 'Page socket failed' }, stream.agent);
    });
    this.send({ t: 'opened', s, protocol: response.headers.get('Sec-WebSocket-Protocol') ?? '' }, ws);
    for (const item of stream.queue.splice(0)) socket.send(item);
    stream.queued = 0;
  }

  private data(ws: WebSocket, s: number, frame: Frame): void {
    const stream = this.streams.get(s);
    if (!stream || stream.agent !== ws) { this.send({ t: 'closed', s, code: 1011, reason: 'stream_unknown' }, ws); return; }
    let payload: string | ArrayBuffer;
    if (typeof frame.text === 'string' && frame.base64 === undefined) payload = frame.text;
    else if (typeof frame.base64 === 'string' && frame.text === undefined) {
      try { payload = fromBase64(frame.base64); } catch { ws.close(1008, 'Invalid base64 data'); return; }
    } else { ws.close(1008, 'Data frames carry text or base64'); return; }
    if (stream.socket) {
      try { stream.socket.send(payload); } catch { this.closeStream(stream, 1011, 'Page socket unavailable'); }
      return;
    }
    const size = typeof payload === 'string' ? bytes(payload) : payload.byteLength;
    if (stream.queue.length >= HUB_LIMITS.queuedFrames || stream.queued + size > HUB_LIMITS.frameBytes) {
      this.closeStream(stream, 1009, 'Too much data before the stream opened'); return;
    }
    stream.queue.push(payload); stream.queued += size;
  }

  /** Closes the page side and reports `closed` to the agent once. */
  private closeStream(stream: Stream, code: number, reason: string): void {
    if (!stream.socket) {
      // Opening: the pending open closes the page socket and reports closed.
      stream.closing ??= { code, reason };
      return;
    }
    if (this.streams.get(stream.s) === stream) this.streams.delete(stream.s);
    try { stream.socket.close(code, reason); } catch { /* gone */ }
    this.send({ t: 'closed', s: stream.s, code, reason }, stream.agent);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    for (const stream of [...this.streams.values()]) if (stream.agent === ws) this.closeStream(stream, 1001, 'Hub connection closed');
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* gone */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    for (const stream of [...this.streams.values()]) if (stream.agent === ws) this.closeStream(stream, 1001, 'Hub connection failed');
  }
}
