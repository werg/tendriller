/**
 * One AgentHub Durable Object per agent multiplexes its control traffic: setup
 * notices, discovery, invitations, and WebRTC rendezvous become virtual streams
 * backed by stateless DO-to-DO POSTs to page objects.
 *
 * AgentHub holds ONLY its hibernatable inbound agent WebSocket — zero outbound
 * WebSockets and zero long-lived in-memory stream tables — so both AgentHub and
 * Tendril hibernate at ~0 GB-s while idle.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { AGENT_HEADER, AGENT_SCOPES_HEADER } from './access';
import { HUB_PROTOCOL } from './agents';
import { listActiveBroadcasts, recordAgentVersions } from './broadcasts';
import { HttpError, json, readJson, toErrorResponse } from './http';
import { AGENT_ID_RE, AGENT_TOKEN_RE, TENDRIL_ID_RE } from './ids';

/** Page socket endpoints reachable through the hub. `peers/relay` stays a direct per-page socket. */
export const HUB_PATHS = new Set(['setup/watch', 'peers/discovery/watch', 'peers/invitations', 'peers/rendezvous']);
export const HUB_LIMITS = Object.freeze({ streams: 64, frameBytes: 1024 * 1024, protocols: 8, queuedFrames: 256 });
const AGENT_TAG = 'agent';
const PROTOCOL_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;

interface HubAttachment {
  agentId: string;
  connId: string;
}

interface HubStreamRow {
  s: number;
  conn_id: string;
  page: string;
  path: string;
  protocol: string;
}

interface PendingOpen {
  connId: string;
  page: string;
  path: string;
  queue: Array<{ text?: string; base64?: string }>;
  queued: number;
  closing?: { code: number; reason: string };
}

type Frame = Record<string, unknown> & { t?: unknown };

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Close codes an endpoint may send: 1000 or the registered/private 3000-4999 range. */
function closeCode(value: unknown, fallback = 1000): number {
  return Number.isInteger(value) && (value === 1000 || (value as number) >= 3000 && (value as number) <= 4999) ? value as number : fallback;
}

/** Close codes reported back to the agent from a Tendril virtual stream (standard 1000-4999 range). */
function reportedCloseCode(value: unknown, fallback = 1000): number {
  return Number.isInteger(value) && (value as number) >= 1000 && (value as number) <= 4999 ? value as number : fallback;
}

function closeReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  let reason = value;
  while (bytes(reason) > 123) reason = reason.slice(0, -1);
  return reason;
}

function hubAttachment(ws: WebSocket | null): HubAttachment | null {
  if (!ws) return null;
  try {
    const value = ws.deserializeAttachment() as Partial<HubAttachment> | null;
    if (typeof value?.agentId === 'string' && typeof value?.connId === 'string') {
      return { agentId: value.agentId, connId: value.connId };
    }
  } catch { /* ignore */ }
  return null;
}

export class AgentHub extends DurableObject<Env> {
  declare env: Env;
  private initialized = false;
  /** Transient maps only while a stream's `open` or `data` POST is in flight (~ms); empty at rest so hibernation is never blocked. */
  private pendingOpens = new Map<number, PendingOpen>();
  private streamTails = new Map<number, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  private init(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS hub_streams (
      s INTEGER PRIMARY KEY,
      conn_id TEXT NOT NULL,
      page TEXT NOT NULL,
      path TEXT NOT NULL,
      protocol TEXT NOT NULL
    )`);
    this.initialized = true;
  }

  private listStreams(connId?: string): HubStreamRow[] {
    this.init();
    const cursor = connId
      ? this.ctx.storage.sql.exec('SELECT s,conn_id,page,path,protocol FROM hub_streams WHERE conn_id=? ORDER BY s', connId)
      : this.ctx.storage.sql.exec('SELECT s,conn_id,page,path,protocol FROM hub_streams ORDER BY s');
    return cursor.toArray() as unknown as HubStreamRow[];
  }

  private getStream(connId: string, s: number): HubStreamRow | null {
    this.init();
    const rows = this.ctx.storage.sql.exec(
      'SELECT s,conn_id,page,path,protocol FROM hub_streams WHERE s=? AND conn_id=?',
      s, connId,
    ).toArray() as unknown as HubStreamRow[];
    return rows[0] ?? null;
  }

  private putStream(row: HubStreamRow): void {
    this.init();
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO hub_streams(s,conn_id,page,path,protocol) VALUES(?,?,?,?,?)',
      row.s, row.conn_id, row.page, row.path, row.protocol,
    );
  }

  private deleteStream(connId: string, s: number): boolean {
    this.init();
    const existing = this.getStream(connId, s);
    if (!existing) return false;
    this.ctx.storage.sql.exec('DELETE FROM hub_streams WHERE s=? AND conn_id=?', s, connId);
    return true;
  }

  private deleteStreamsForConn(connId: string): HubStreamRow[] {
    const rows = this.listStreams(connId);
    if (rows.length) this.ctx.storage.sql.exec('DELETE FROM hub_streams WHERE conn_id=?', connId);
    return rows;
  }

  private deleteStreamsForPage(page: string): HubStreamRow[] {
    this.init();
    const rows = this.ctx.storage.sql.exec(
      'SELECT s,conn_id,page,path,protocol FROM hub_streams WHERE page=? ORDER BY s',
      page,
    ).toArray() as unknown as HubStreamRow[];
    if (rows.length) this.ctx.storage.sql.exec('DELETE FROM hub_streams WHERE page=?', page);
    return rows;
  }

  private notifyPagesClose(agentId: string, rows: HubStreamRow[]): void {
    if (!rows.length || !agentId) return;
    const byPageAndConn = new Map<string, { page: string; connId: string; streams: number[] }>();
    for (const row of rows) {
      const key = `${row.page}:${row.conn_id}`;
      let group = byPageAndConn.get(key);
      if (!group) byPageAndConn.set(key, group = { page: row.page, connId: row.conn_id, streams: [] });
      group.streams.push(row.s);
    }
    const work = Promise.allSettled([...byPageAndConn.values()].map(group =>
      this.env.TENDRIL.get(this.env.TENDRIL.idFromName(group.page)).fetch(new Request('https://tendril.internal/hub/stream/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tendril-id': group.page },
        body: JSON.stringify({ agentId, connId: group.connId, streams: group.streams }),
      })).then(r => r.body?.cancel()).catch(() => {}),
    )).then(() => undefined);
    this.ctx.waitUntil(work);
  }

  async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname === '/connect') return this.accept(req);
      if (url.pathname === '/event' && req.method === 'POST') {
        const body = await readJson(req, 64 * 1024);
        const page = body.page === null ? null : typeof body.page === 'string' && TENDRIL_ID_RE.test(body.page) ? body.page : undefined;
        if (page === undefined || typeof body.kind !== 'string') throw new HttpError(400, 'bad_request');
        const ws = this.current();
        const att = hubAttachment(ws);
        const delivered = this.send({ t: 'event', page, kind: body.kind, data: body.data ?? {} }, ws);
        if (page && (body.kind === 'revoked' || body.kind === 'page-deleted')) {
          for (const [s, pending] of this.pendingOpens) {
            if (pending.page === page) pending.closing ??= { code: 4003, reason: 'Agent access revoked' };
            void s;
          }
          const removed = this.deleteStreamsForPage(page);
          for (const row of removed) {
            if (att && row.conn_id === att.connId) this.send({ t: 'closed', s: row.s, code: 4003, reason: 'Agent access revoked' }, ws);
          }
        }
        return json({ delivered }, 202);
      }
      if (url.pathname === '/stream/deliver' && req.method === 'POST') {
        const body = await readJson(req, HUB_LIMITS.frameBytes + 4096);
        const connId = typeof body.connId === 'string' ? body.connId : '';
        const s = body.s;
        if (!connId || !Number.isInteger(s)) throw new HttpError(400, 'bad_request');
        const ws = this.current();
        const att = hubAttachment(ws);
        if (!ws || !att || att.connId !== connId) return json({ delivered: false });
        const row = this.getStream(connId, s as number);
        if (!row) return json({ delivered: false });
        if (body.kind === 'closed') {
          this.deleteStream(connId, s as number);
          const delivered = this.send({
            t: 'closed',
            s,
            code: reportedCloseCode(body.code, 1000),
            reason: closeReason(body.reason ?? ''),
          }, ws);
          return json({ delivered });
        }
        if (body.kind === 'data') {
          const frame: Record<string, unknown> = { t: 'data', s };
          if (typeof body.text === 'string') frame.text = body.text;
          else if (typeof body.base64 === 'string') frame.base64 = body.base64;
          else throw new HttpError(400, 'bad_request');
          const text = JSON.stringify(frame);
          if (bytes(text) > HUB_LIMITS.frameBytes) {
            this.deleteStream(connId, s as number);
            this.send({ t: 'closed', s, code: 1009, reason: 'Stream message exceeds the hub frame limit' }, ws);
            return json({ delivered: false });
          }
          try {
            ws.send(text);
            return json({ delivered: true });
          } catch {
            this.deleteStream(connId, s as number);
            return json({ delivered: false });
          }
        }
        throw new HttpError(400, 'bad_request');
      }
      if (url.pathname === '/close' && req.method === 'POST') {
        const body = await readJson(req, 4096);
        const reason = closeReason(body.reason ?? 'Agent disconnected');
        const ws = this.current();
        const att = hubAttachment(ws);
        for (const pending of this.pendingOpens.values()) pending.closing ??= { code: 4003, reason };
        const allRows = this.listStreams();
        if (allRows.length) this.ctx.storage.sql.exec('DELETE FROM hub_streams');
        if (att) {
          for (const row of allRows) {
            if (row.conn_id === att.connId) this.send({ t: 'closed', s: row.s, code: 4003, reason }, ws);
          }
          this.notifyPagesClose(att.agentId, allRows);
        }
        for (const socket of this.ctx.getWebSockets(AGENT_TAG)) try { socket.close(4003, reason); } catch { /* gone */ }
        return json({ closed: true });
      }
      if (url.pathname === '/state' && req.method === 'GET') {
        const ws = this.current();
        const att = hubAttachment(ws);
        const rows = att ? this.listStreams(att.connId) : [];
        return json({ connected: !!ws, streams: rows.map(({ s, page, path }) => ({ s, page, path, open: true })) });
      }
      throw new HttpError(404, 'not_found');
    } catch (error) { return toErrorResponse(error); }
  }

  /** The router authenticated the token; a newer connection replaces the older one. */
  private accept(req: Request): Response {
    const agentId = req.headers.get(AGENT_HEADER) ?? '';
    if (!AGENT_ID_RE.test(agentId)) throw new HttpError(401, 'unauthorized');
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'websocket_required');
    for (const pending of this.pendingOpens.values()) pending.closing ??= { code: 1001, reason: 'Hub connection replaced' };
    const staleRows = this.listStreams();
    if (staleRows.length) this.ctx.storage.sql.exec('DELETE FROM hub_streams');
    this.notifyPagesClose(agentId, staleRows);
    for (const ws of this.ctx.getWebSockets(AGENT_TAG)) {
      const oldAtt = hubAttachment(ws);
      if (oldAtt) {
        for (const row of staleRows) {
          if (row.conn_id === oldAtt.connId) this.send({ t: 'closed', s: row.s, code: 1001, reason: 'Hub connection replaced' }, ws);
        }
      }
      try { ws.close(4000, 'Replaced by a newer hub connection'); } catch { /* gone */ }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [AGENT_TAG]);
    server.serializeAttachment({ agentId, connId: crypto.randomUUID() } satisfies HubAttachment);
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
    if (frame.t === 'hello') { await this.hello(ws, frame); return; }
    const s = frame.s;
    if (!Number.isInteger(s) || (s as number) < 1 || (s as number) > 2 ** 31) { ws.close(1008, 'Invalid stream id'); return; }
    if (frame.t === 'open') { await this.open(ws, s as number, frame); return; }
    if (frame.t === 'data') { await this.data(ws, s as number, frame); return; }
    if (frame.t === 'close') { this.closeStream(ws, s as number, closeCode(frame.code), closeReason(frame.reason)); return; }
    ws.close(1008, 'Unknown hub frame type');
  }

  private async hello(ws: WebSocket, frame: Frame): Promise<void> {
    const agentId = hubAttachment(ws)?.agentId ?? '';
    if (!AGENT_ID_RE.test(agentId)) return;
    if (frame.versions !== undefined && frame.versions !== null) {
      try { await recordAgentVersions(this.env, agentId, frame.versions); } catch { /* ignore invalid optional telemetry */ }
    }
    const since = Number.isSafeInteger(frame.last_broadcast_seq) && (frame.last_broadcast_seq as number) >= 0
      ? (frame.last_broadcast_seq as number) : 0;
    try {
      const feed = await listActiveBroadcasts(this.env, { audience: 'agents', since });
      this.send({
        t: 'broadcasts',
        issuer: feed.issuer,
        keys: feed.keys,
        latest_seq: feed.latest_seq,
        broadcasts: feed.broadcasts,
      }, ws);
    } catch { /* non-fatal */ }
  }

  private async open(ws: WebSocket, s: number, frame: Frame): Promise<void> {
    const att = hubAttachment(ws);
    if (!att || !AGENT_ID_RE.test(att.agentId)) { ws.close(1008, 'Unauthorized hub connection'); return; }
    const { agentId, connId } = att;
    if (this.pendingOpens.has(s) || this.getStream(connId, s)) { ws.close(1008, 'Stream id in use'); return; }
    const page = frame.page, rawPath = frame.path, protocols = frame.protocols ?? [];
    const [path, query = ''] = typeof rawPath === 'string' ? rawPath.split(/\?(.*)/s, 2) : [''];
    const refuse = (status: number, code: string) => this.send({ t: 'closed', s, code: 4000 + status, reason: code }, ws);
    if (typeof page !== 'string' || !TENDRIL_ID_RE.test(page) || !HUB_PATHS.has(path) || !Array.isArray(protocols) ||
        protocols.length > HUB_LIMITS.protocols || protocols.some(value => typeof value !== 'string' || !PROTOCOL_RE.test(value) || AGENT_TOKEN_RE.test(value))) {
      refuse(400, 'invalid_stream'); return;
    }
    if (this.listStreams(connId).length + this.pendingOpens.size >= HUB_LIMITS.streams) { refuse(429, 'stream_limit'); return; }

    const pending: PendingOpen = { connId, page, path, queue: [], queued: 0 };
    this.pendingOpens.set(s, pending);
    let response: Response;
    try {
      // Every open rechecks the agent and its page grant in D1.
      const grant = await this.env.ACCOUNTS.prepare(`SELECT g.scopes FROM agents a LEFT JOIN accounts c ON c.id=a.account_id
        JOIN agent_grants g ON g.agent_id=a.id AND g.page_id=?
        WHERE a.id=? AND a.revoked_at IS NULL AND (a.account_id IS NULL OR (c.suspended_at IS NULL AND c.deleting_at IS NULL))`)
        .bind(page, agentId).first<{ scopes: string }>();
      if (!grant) throw new HttpError(404, 'not_found', 'No such granted page');
      if (this.env.AGENT_RATE && !(await this.env.AGENT_RATE.limit({ key: 'agent:' + agentId })).success) throw new HttpError(429, 'rate_limited');
      const target = new URL('https://tendril.internal/hub/stream/open');
      target.search = query;
      response = await this.env.TENDRIL.get(this.env.TENDRIL.idFromName(page)).fetch(new Request(target.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tendril-id': page,
          'x-tendril-rest': encodeURIComponent(path),
          [AGENT_HEADER]: agentId,
          [AGENT_SCOPES_HEADER]: (JSON.parse(grant.scopes) as string[]).join(' '),
        },
        body: JSON.stringify({ agentId, connId, s, path, protocols }),
      }));
    } catch (error) {
      response = toErrorResponse(error);
    } finally {
      if (this.pendingOpens.get(s) === pending) this.pendingOpens.delete(s);
    }

    if (!response.ok) {
      let code = 'refused';
      try { code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? code; } catch { /* status only */ }
      refuse(Math.min(999, Math.max(0, response.status)), code);
      return;
    }
    const opened = await response.json() as { protocol?: string; initial?: string[] };
    const activeWs = this.current();
    const activeAtt = hubAttachment(activeWs);
    if (!activeWs || activeWs !== ws || !activeAtt || activeAtt.connId !== connId || pending.closing) {
      const closing = pending.closing ?? { code: 1001, reason: 'Hub stream cancelled' };
      this.notifyPagesClose(agentId, [{ s, conn_id: connId, page, path, protocol: opened.protocol ?? '' }]);
      this.send({ t: 'closed', s, code: closing.code, reason: closing.reason }, ws);
      return;
    }
    const row: HubStreamRow = { s, conn_id: connId, page, path, protocol: opened.protocol ?? '' };
    this.putStream(row);
    this.send({ t: 'opened', s, protocol: row.protocol }, ws);
    for (const text of opened.initial ?? []) {
      this.send({ t: 'data', s, text }, ws);
    }
    if (pending.queue.length) {
      await this.enqueueStream(s, async () => {
        for (const queued of pending.queue) {
          if (!this.getStream(connId, s)) break;
          await this.forwardData(ws, agentId, row, queued);
        }
      });
    }
  }

  private enqueueStream(s: number, work: () => Promise<void>): Promise<void> {
    const prev = this.streamTails.get(s) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tracked = next.finally(() => {
      if (this.streamTails.get(s) === tracked) this.streamTails.delete(s);
    });
    this.streamTails.set(s, tracked);
    return tracked;
  }

  private async data(ws: WebSocket, s: number, frame: Frame): Promise<void> {
    const att = hubAttachment(ws);
    if (!att) { this.send({ t: 'closed', s, code: 1011, reason: 'stream_unknown' }, ws); return; }
    let payload: { text?: string; base64?: string };
    let size: number;
    if (typeof frame.text === 'string' && frame.base64 === undefined) {
      payload = { text: frame.text };
      size = bytes(frame.text);
    } else if (typeof frame.base64 === 'string' && frame.text === undefined) {
      try { atob(frame.base64); } catch { ws.close(1008, 'Invalid base64 data'); return; }
      payload = { base64: frame.base64 };
      size = Math.ceil((frame.base64.length * 3) / 4);
    } else {
      ws.close(1008, 'Data frames carry text or base64');
      return;
    }
    const pending = this.pendingOpens.get(s);
    if (pending && pending.connId === att.connId) {
      if (pending.queue.length >= HUB_LIMITS.queuedFrames || pending.queued + size > HUB_LIMITS.frameBytes) {
        pending.closing = { code: 1009, reason: 'Too much data before the stream opened' };
        return;
      }
      pending.queue.push(payload);
      pending.queued += size;
      return;
    }
    await this.enqueueStream(s, async () => {
      const row = this.getStream(att.connId, s);
      if (!row) { this.send({ t: 'closed', s, code: 1011, reason: 'stream_unknown' }, ws); return; }
      await this.forwardData(ws, att.agentId, row, payload);
    });
  }

  private async forwardData(ws: WebSocket, agentId: string, row: HubStreamRow, payload: { text?: string; base64?: string }): Promise<void> {
    let response: Response;
    try {
      response = await this.env.TENDRIL.get(this.env.TENDRIL.idFromName(row.page)).fetch(new Request('https://tendril.internal/hub/stream/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tendril-id': row.page },
        body: JSON.stringify({ agentId, connId: row.conn_id, s: row.s, ...payload }),
      }));
    } catch {
      this.deleteStream(row.conn_id, row.s);
      this.send({ t: 'closed', s: row.s, code: 1011, reason: 'Page socket unavailable' }, ws);
      return;
    }
    if (!response.ok) {
      await response.body?.cancel();
      this.deleteStream(row.conn_id, row.s);
      this.send({ t: 'closed', s: row.s, code: 1011, reason: 'Page socket failed' }, ws);
      return;
    }
    const result = await response.json() as { frames?: string[]; close?: { code: number; reason: string } };
    for (const text of result.frames ?? []) {
      this.send({ t: 'data', s: row.s, text }, ws);
    }
    if (result.close) {
      this.deleteStream(row.conn_id, row.s);
      this.send({ t: 'closed', s: row.s, code: reportedCloseCode(result.close.code, 1000), reason: closeReason(result.close.reason) }, ws);
    }
  }

  private closeStream(ws: WebSocket, s: number, code: number, reason: string): void {
    const att = hubAttachment(ws);
    if (!att) return;
    const pending = this.pendingOpens.get(s);
    if (pending && pending.connId === att.connId) {
      pending.closing ??= { code, reason };
      return;
    }
    const row = this.getStream(att.connId, s);
    if (!row) return;
    this.deleteStream(att.connId, s);
    this.notifyPagesClose(att.agentId, [row]);
    this.send({ t: 'closed', s, code, reason }, ws);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = hubAttachment(ws);
    if (att) {
      for (const pending of this.pendingOpens.values()) {
        if (pending.connId === att.connId) pending.closing ??= { code: 1001, reason: 'Hub connection closed' };
      }
      const rows = this.deleteStreamsForConn(att.connId);
      this.notifyPagesClose(att.agentId, rows);
    }
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* gone */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const att = hubAttachment(ws);
    if (att) {
      for (const pending of this.pendingOpens.values()) {
        if (pending.connId === att.connId) pending.closing ??= { code: 1001, reason: 'Hub connection failed' };
      }
      const rows = this.deleteStreamsForConn(att.connId);
      this.notifyPagesClose(att.agentId, rows);
    }
  }
}
