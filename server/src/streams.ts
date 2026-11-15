// Named data streams. Legacy sources are adapters over their original tables;
// custom data never enters the conversational event queue or wake machinery.
import { assertValid } from "../../contract/index.mjs";
import type { StreamInfo, StreamRecord, StreamBatch, StreamAppendResult, StreamInput } from "../../contract/index.mjs";
import type { Att, Role, Tendril } from "./tendril";
import { HttpError, json, readJson } from "./http";
import { randomB32, sha256Hex } from "./ids";
import { requireWritesOpen } from "./service-state";

export type { StreamInfo, StreamRecord, StreamBatch, StreamAppendResult };
export interface StreamActor { kind: "agent" | "page"; name: string; role?: Role }
type StreamRow = Omit<StreamInfo, "builtin"> & { latest_seq: number };
type RecordRow = { stream: string; seq: number; ts: number; received_at: number; type: string; data: string; producer: string; id: string; bytes: number };
type ProducerRow = { name: string; hash: string; streams: string; created_at: number; last_seen: number | null };

export const MAX_STREAMS = 64;
export const MAX_PRODUCERS = 32;
export const MAX_STREAM_RECORD_BYTES = 64 * 1024;
export const MAX_STREAM_BATCH_BYTES = 256 * 1024;
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const MAX_STREAM_RECORDS = 20_000;
export const MAX_STREAM_REPLAY_BYTES = 512 * 1024;
const MAX_SUBSCRIPTIONS = 16;
const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const BUILTINS: StreamInfo[] = [
  { name: "system.events", durability: "durable", readers: "agent", builtin: true, max_records: 10_000, max_age_seconds: 30 * 86400 },
  { name: "system.logs", durability: "durable", readers: "agent", builtin: true, max_records: 2000, max_age_seconds: null },
  { name: "system.transcript", durability: "durable", readers: "page", builtin: true, max_records: 100, max_age_seconds: null },
  { name: "system.state", durability: "ephemeral", readers: "page", builtin: true, max_records: null, max_age_seconds: null },
  { name: "system.presence", durability: "ephemeral", readers: "page", builtin: true, max_records: null, max_age_seconds: null },
];
const TABLES: Record<string, string> = Object.assign(Object.create(null), {
  "system.events": "events", "system.logs": "logs", "system.transcript": "transcript",
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const rowInfo = (row: StreamRow): StreamInfo => ({ name: row.name, durability: row.durability, readers: row.readers,
  builtin: false, max_records: row.max_records, max_age_seconds: row.max_age_seconds });

export function streamInfo(t: Tendril, name: string): StreamInfo {
  if (!NAME.test(name)) throw new HttpError(400, "bad_request", "Invalid stream name");
  const builtin = BUILTINS.find(s => s.name === name);
  if (builtin) return { ...builtin };
  const row = t.db.one<StreamRow>("SELECT * FROM streams WHERE name=?", name);
  if (!row) throw new HttpError(404, "not_found", "No such stream");
  return rowInfo(row);
}

export function canReadStream(info: StreamInfo, actor: StreamActor): boolean {
  return actor.kind === "agent" || info.readers === "page" || info.readers === "owner" && actor.role === "owner";
}
function requireReader(info: StreamInfo, actor: StreamActor): void {
  if (!canReadStream(info, actor)) throw new HttpError(403, "forbidden", "This stream is not shared with this reader");
}
export function listStreams(t: Tendril, actor: StreamActor = { kind: "agent", name: "agent" }): StreamInfo[] {
  return [...BUILTINS.map(s => ({ ...s })), ...t.db.all<StreamRow>("SELECT * FROM streams ORDER BY name").map(rowInfo)]
    .filter(info => canReadStream(info, actor));
}
export function createStream(t: Tendril, value: unknown): StreamInfo {
  const body = assertValid("streamCreate", value);
  if (body.name.startsWith("system.")) throw new HttpError(400, "reserved_stream", "system.* streams are built in");
  if (t.db.one("SELECT name FROM streams WHERE name=?", body.name)) throw new HttpError(409, "exists", "Stream configuration is immutable");
  if ((t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM streams")?.n ?? 0) >= MAX_STREAMS)
    throw new HttpError(429, "quota", "At most 64 custom streams per tendril");
  t.db.run("INSERT INTO streams(name,durability,readers,max_records,max_age_seconds,latest_seq) VALUES(?,?,?,?,?,0)",
    body.name, body.durability, body.readers ?? "owner", body.durability === "durable" ? body.max_records ?? 10_000 : null,
    body.durability === "durable" ? body.max_age_seconds ?? 86400 : null);
  return streamInfo(t, body.name);
}

function highWater(t: Tendril, name: string): number {
  if (TABLES[name]) return t.db.one<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name=?", TABLES[name])?.seq ?? 0;
  if (name === "system.state") return t.getState().rev;
  if (name === "system.presence") return t.db.one<{ seq: number }>("SELECT seq FROM stream_counters WHERE name=?", name)?.seq ?? 0;
  return t.db.one<{ latest_seq: number }>("SELECT latest_seq FROM streams WHERE name=?", name)?.latest_seq ?? 0;
}
function renderRecord(row: RecordRow): StreamRecord {
  return { stream: row.stream, seq: row.seq, ts: row.ts, received_at: row.received_at,
    type: row.type, data: JSON.parse(row.data), producer: row.producer, id: row.id };
}
function renderBuiltin(name: string, row: Record<string, any>): StreamRecord {
  let data: unknown, type: string, producer: string;
  if (name === "system.events") {
    data = { seq: row.seq, ts: row.ts, type: row.type, data: row.data == null ? null : JSON.parse(row.data),
      device: row.device ?? null, role: row.role ?? null, wake: !!row.wake, withheld: !!row.withheld, by: row.by ?? null };
    type = row.type; producer = row.by ?? (row.device ? `device:${row.device}` : "system");
  } else if (name === "system.logs") {
    data = { seq: row.seq, ts: row.ts, device: row.device, version: row.version, level: row.level, message: row.message,
      ...(row.stack ? { stack: row.stack } : {}) };
    type = row.level; producer = row.device ? `device:${row.device}` : "system";
  } else {
    data = { ts: row.ts, from: row.src, text: row.text }; type = "message"; producer = row.src;
  }
  // Legacy sources did not retain separate receipt timestamps; expose their
  // stored timestamp without inventing a second historical clock.
  return { stream: name, seq: row.seq, ts: row.ts, received_at: row.ts, type, data, producer, id: null };
}

/** Pruning never resets high-water marks and dedupe lasts for retained records. */
export function pruneStreams(t: Tendril): void {
  for (const s of t.db.all<StreamRow>("SELECT * FROM streams WHERE durability='durable'")) pruneStream(t, rowInfo(s));
  t.db.run("DELETE FROM stream_rate WHERE minute<?", Math.floor(t.now() / 60_000) - 2);
}
function pruneStream(t: Tendril, info: StreamInfo): void {
  t.db.run("DELETE FROM stream_records WHERE stream=? AND received_at<?", info.name, t.now() - info.max_age_seconds! * 1000);
  const boundary = t.db.one<{ seq: number }>("SELECT seq FROM stream_records WHERE stream=? ORDER BY seq DESC LIMIT 1 OFFSET ?", info.name, info.max_records);
  if (boundary) t.db.run("DELETE FROM stream_records WHERE stream=? AND seq<=?", info.name, boundary.seq);
}

function cursor(value: unknown, label = "after"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HttpError(400, "bad_request", `${label} must be an explicit nonnegative safe integer`);
  return value as number;
}
export function readStream(t: Tendril, name: string, after: number, limit = 100): StreamBatch {
  const info = streamInfo(t, name);
  if (info.durability === "ephemeral") throw new HttpError(409, "not_replayable", "Ephemeral streams have no retained records");
  cursor(after);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "bad_request", "limit must be an integer from 1 to 500");
  if (!info.builtin) pruneStream(t, info);
  const latest = highWater(t, name);
  if (after > latest) throw new HttpError(400, "cursor_ahead", "after is beyond this stream's history", { latest_seq: latest });
  const table = TABLES[name];
  const rows = table ? t.db.all(`SELECT * FROM ${table} WHERE seq>? ORDER BY seq LIMIT ?`, after, limit)
    : t.db.all<RecordRow>("SELECT * FROM stream_records WHERE stream=? AND seq>? ORDER BY seq LIMIT ?", name, after, limit);
  const records: StreamRecord[] = [];
  let replayBytes = 0;
  for (const row of rows) {
    const record = table ? renderBuiltin(name, row) : renderRecord(row as RecordRow), size = bytes(record);
    if (records.length && replayBytes + size > MAX_STREAM_REPLAY_BYTES) break;
    records.push(record); replayBytes += size;
  }
  const earliest = table ? t.db.one<{ seq: number | null }>(`SELECT MIN(seq) AS seq FROM ${table}`)?.seq ?? null
    : t.db.one<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM stream_records WHERE stream=?", name)?.seq ?? null;
  let next = after + 1, missingThrough: number | null = null;
  for (const record of records) {
    if (record.seq > next) missingThrough = record.seq - 1;
    next = record.seq + 1;
  }
  if (records.length === rows.length && rows.length < limit && next <= latest) missingThrough = latest;
  return { stream: name, durability: info.durability, records, cursor: records.at(-1)?.seq ?? after,
    history: { earliest_available_seq: earliest, latest_seq: latest, gap: missingThrough !== null, missing_through: missingThrough } };
}

/** Bounded per-principal and aggregate budgets survive hibernation/restarts. */
function chargeRate(t: Tendril, principal: string, amount: number): void {
  const minute = Math.floor(t.now() / 60_000);
  t.db.run("DELETE FROM stream_rate WHERE minute<?", minute - 2);
  for (const key of ["all", principal]) {
    t.db.run(`INSERT INTO stream_rate(principal,minute,requests,bytes) VALUES(?,?,1,?)
      ON CONFLICT(principal) DO UPDATE SET minute=excluded.minute,
      requests=CASE WHEN stream_rate.minute=excluded.minute THEN stream_rate.requests+1 ELSE 1 END,
      bytes=CASE WHEN stream_rate.minute=excluded.minute THEN stream_rate.bytes+excluded.bytes ELSE excluded.bytes END`, key, minute, amount);
    const rate = t.db.one<{ requests: number; bytes: number }>("SELECT requests,bytes FROM stream_rate WHERE principal=?", key)!;
    if (rate.requests > (key === "all" ? 600 : 120) || rate.bytes > 8 * 1024 * 1024)
      throw new HttpError(429, "rate_limited", "Stream ingestion budget reached; retry next minute", { retry_after_seconds: 60 - Math.floor(t.now() / 1000) % 60 });
  }
}

export function appendRecords(t: Tendril, name: string, value: unknown, producer: string, producerKey = producer): StreamAppendResult {
  const info = streamInfo(t, name);
  if (info.builtin) throw new HttpError(403, "readonly_stream", "Built-in streams are written through their existing APIs");
  const body = assertValid("streamAppend", value);
  const size = bytes(body);
  if (size > MAX_STREAM_BATCH_BYTES) throw new HttpError(413, "too_large", "Stream batch exceeds 256 KiB");
  for (const record of body.records) if (bytes(record) > MAX_STREAM_RECORD_BYTES)
    throw new HttpError(413, "too_large", "Stream record exceeds 64 KiB");
  chargeRate(t, producer, size);
  const receivedAt = t.now(), fresh: StreamRecord[] = [];
  const result = t.ctx.storage.transactionSync(() => {
    let seq = highWater(t, name);
    const records: StreamRecord[] = [];
    if (info.durability === "durable") pruneStreams(t);
    for (const input of body.records as StreamInput[]) {
      if (info.durability === "durable") {
        const previous = t.db.one<RecordRow>("SELECT * FROM stream_records WHERE stream=? AND producer_key=? AND id=?", name, producerKey, input.id);
        if (previous) {
          if (previous.type !== input.type || previous.data !== JSON.stringify(input.data) || input.ts !== undefined && previous.ts !== input.ts)
            throw new HttpError(409, "id_conflict", "Record ID already identifies a different record");
          records.push(renderRecord(previous)); continue;
        }
      }
      const record: StreamRecord = { stream: name, seq: ++seq, ts: input.ts ?? receivedAt, received_at: receivedAt,
        type: input.type, data: input.data, producer, id: input.id };
      if (info.durability === "durable") t.db.run(`INSERT INTO stream_records(stream,seq,ts,received_at,type,data,producer,producer_key,id,bytes)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, name, seq, record.ts, receivedAt, record.type, JSON.stringify(record.data), producer, producerKey, record.id,
        bytes(record) + new TextEncoder().encode(producerKey).byteLength);
      fresh.push(record); records.push(record);
    }
    t.db.run("UPDATE streams SET latest_seq=? WHERE name=?", seq, name);
    if (info.durability === "durable") {
      pruneStream(t, info);
      const usage = t.db.one<{ count: number; bytes: number }>("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM stream_records")!;
      const allowance = t.db.get<string | null>("owner_account", null) ? MAX_STREAM_BYTES : 1024 * 1024;
      if (usage.count > MAX_STREAM_RECORDS || usage.bytes > allowance)
        throw new HttpError(413, "quota", "Custom stream retention allowance reached", { max_records: MAX_STREAM_RECORDS, max_bytes: allowance });
    }
    return { records, cursor: seq, durability: info.durability };
  });
  // Payloads are never put in dedupe, activity, events, or metadata. Only durable
  // custom records enter stream_records. Fan-out begins after commit.
  queueDelivery(t, fresh);
  return result;
}

function publicProducer(row: ProducerRow) {
  return { name: row.name, streams: JSON.parse(row.streams) as string[], created_at: row.created_at, last_seen: row.last_seen };
}
export function listProducers(t: Tendril) { return t.db.all<ProducerRow>("SELECT * FROM stream_producers ORDER BY name").map(publicProducer); }
export async function createProducer(t: Tendril, value: unknown) {
  const body = assertValid("producerCreate", value);
  for (const name of body.streams) if (streamInfo(t, name).builtin) throw new HttpError(400, "bad_request", "Producers can publish only custom streams");
  const token = `tp_${randomB32(40)}`, hash = await sha256Hex(token);
  if (t.db.one("SELECT name FROM stream_producers WHERE name=?", body.name)) throw new HttpError(409, "exists", "Producer already exists");
  if ((t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM stream_producers")?.n ?? 0) >= MAX_PRODUCERS)
    throw new HttpError(429, "quota", "At most 32 producers per tendril");
  t.db.run("INSERT INTO stream_producers(name,hash,streams,created_at,last_seen) VALUES(?,?,?,?,NULL)", body.name, hash,
    JSON.stringify([...new Set(body.streams)]), t.now());
  return { producer: publicProducer(t.db.one<ProducerRow>("SELECT * FROM stream_producers WHERE name=?", body.name)!), token };
}
export function deleteProducer(t: Tendril, name: string): void {
  if (!NAME.test(name)) throw new HttpError(400, "bad_request", "Invalid producer name");
  if (!t.db.one("SELECT name FROM stream_producers WHERE name=?", name)) throw new HttpError(404, "not_found", "No such producer");
  t.db.run("DELETE FROM stream_producers WHERE name=?", name);
}
export async function handleProducer(t: Tendril, req: Request, rest: string): Promise<Response> {
  const token = /^Bearer\s+(tp_[a-z2-7]{40})\s*$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "unauthorized", "Invalid producer credential");
  const hash = await sha256Hex(token);
  const producer = t.db.one<ProducerRow>("SELECT * FROM stream_producers WHERE hash=?", hash);
  if (!producer) throw new HttpError(401, "unauthorized", "Invalid or revoked producer credential");
  const match = /^streams\/([a-z][a-z0-9._-]{0,63})\/records$/.exec(rest);
  if (req.method !== "POST" || !match || !(JSON.parse(producer.streams) as string[]).includes(match[1]))
    throw new HttpError(403, "forbidden", "This credential can only append to its configured streams");
  const body = await readJson(req, MAX_STREAM_BATCH_BYTES);
  // Body I/O can yield: revocation must still take effect before committing.
  if (!t.db.one("SELECT name FROM stream_producers WHERE hash=?", hash)) throw new HttpError(401, "unauthorized", "Producer credential was revoked");
  const result = appendRecords(t, match[1], body, `producer:${producer.name}`, hash);
  t.db.run("UPDATE stream_producers SET last_seen=? WHERE hash=?", t.now(), hash);
  t.db.set("last_producer_seen", t.now());
  t.scheduleAlarm();
  return json(result);
}

export const STREAM_ROUTE = /^(?:streams(?:\/[a-z][a-z0-9._-]{0,63}(?:\/records)?)?|producers(?:\/[a-z][a-z0-9._-]{0,63})?)$/;
export async function handleStreams(t: Tendril, req: Request, url: URL, rest: string, actor: StreamActor): Promise<Response> {
  const parts = rest.split("/");
  if (parts[0] === "producers") {
    if (actor.kind !== "agent") throw new HttpError(403, "forbidden");
    if (parts.length === 1 && req.method === "GET") return json({ producers: listProducers(t) });
    if (parts.length === 1 && req.method === "POST") return json(await createProducer(t, await readJson(req, 8192)), 201);
    if (parts.length === 2 && req.method === "DELETE") { deleteProducer(t, parts[1]); return json({ ok: true }); }
    throw new HttpError(405, "method_not_allowed");
  }
  if (parts.length === 1) {
    if (req.method === "GET") return json({ streams: listStreams(t, actor) });
    if (req.method === "POST" && actor.kind === "agent") return json(createStream(t, await readJson(req, 4096)), 201);
    throw new HttpError(405, "method_not_allowed");
  }
  const info = streamInfo(t, parts[1]); requireReader(info, actor);
  if (parts.length === 2 && req.method === "GET") return json(info);
  if (parts[2] === "records" && req.method === "GET") {
    const after = url.searchParams.get("after"), limit = url.searchParams.get("limit");
    if (after === null || after.trim() === "") throw new HttpError(400, "cursor_required", "Provide an explicit after cursor");
    return json(readStream(t, info.name, cursor(Number(after)), limit === null ? 100 : Number(limit)));
  }
  if (parts[2] === "records" && req.method === "POST" && actor.kind === "agent")
    return json(appendRecords(t, info.name, await readJson(req, MAX_STREAM_BATCH_BYTES), `agent:${actor.name}`));
  throw new HttpError(405, "method_not_allowed");
}

/** All checks are repeated on delivery, including link/session expiry/revocation. */
function localReader(t: Tendril, ws: WebSocket, info: StreamInfo): Att | null {
  const att = t.att(ws);
  if (!att?.deviceId || !att.sessionRole || t.db.get("disabled", false) || !t.device(att.deviceId)) return null;
  const link = t.db.one<{ role: Role; expires_at: number | null; created_by_agent: number }>("SELECT role,expires_at,created_by_agent FROM links WHERE id=?", att.linkId);
  if (!link || link.role !== att.sessionRole || link.expires_at !== null && link.expires_at <= t.now()) return null;
  if (att.sessionRole === "display") {
    if (link.created_by_agent || !t.db.get("owner_account", null)) return null;
  } else {
    if (!att.sessionHash || !t.db.one("SELECT 1 FROM page_sessions WHERE hash=? AND account_id=? AND role=? AND expires_at>?", att.sessionHash, att.accountId, att.sessionRole, t.now())) return null;
    if (att.sessionRole === "owner" && att.accountId !== t.db.get("owner_account", null)) return null;
    if (att.sessionRole === "guest" && !t.db.one("SELECT 1 FROM guest_accounts WHERE account_id=? AND link_id=? AND approved=1", att.accountId, att.linkId)) return null;
  }
  return canReadStream(info, { kind: "page", name: att.deviceId, role: att.sessionRole }) ? att : null;
}

export function subscribeStream(t: Tendril, ws: WebSocket, name: string, after?: number) {
  const info = streamInfo(t, name), att = localReader(t, ws, info);
  if (!att) throw new HttpError(403, "forbidden", "This reader cannot subscribe to this stream");
  if (after !== undefined && info.durability === "ephemeral") throw new HttpError(409, "not_replayable", "Subscribe to ephemeral streams without after");
  const subscriptions = { ...att.streams };
  if (!Object.hasOwn(subscriptions, name) && Object.keys(subscriptions).length >= MAX_SUBSCRIPTIONS)
    throw new HttpError(429, "quota", "At most 16 stream subscriptions per socket");
  // No await between capturing history and installing the live high-water mark.
  const batch = after === undefined ? undefined : readStream(t, name, cursor(after), 500);
  const latest = highWater(t, name);
  subscriptions[name] = latest;
  ws.serializeAttachment({ ...att, streams: subscriptions });
  return { stream: name, durability: info.durability, cursor: latest, ...(batch ? { batch } : {}) };
}
export function unsubscribeStream(t: Tendril, ws: WebSocket, name: string): void {
  const att = t.att(ws); if (!att) return;
  const streams = { ...att.streams }; delete streams[name]; ws.serializeAttachment({ ...att, streams });
}
export async function publishFromPage(t: Tendril, ws: WebSocket, name: string, value: unknown): Promise<StreamAppendResult> {
  await requireWritesOpen(t.env);
  const info = streamInfo(t, name), att = localReader(t, ws, info);
  if (!att || att.sessionRole !== "owner") throw new HttpError(403, "forbidden", "Only the owner may publish custom stream data");
  return appendRecords(t, name, value, `device:${att.deviceId}`);
}

type DeliveryQueue = { tail: Promise<void>; bytes: number; jobs: number };
const deliveryQueues = new WeakMap<Tendril, DeliveryQueue>();
function closeStreamReaders(t: Tendril, records: StreamRecord[], code: number, reason: string): void {
  for (const { ws, att } of t.connectedSockets()) {
    if (!att.streams || !records.some(record => Object.hasOwn(att.streams!, record.stream))) continue;
    try { ws.close(code, reason); } catch {}
  }
}
function queueDelivery(t: Tendril, records: StreamRecord[], verify?: () => boolean): void {
  if (!records.length || !t.connectedSockets().some(s => s.att.streams && records.some(r => Object.hasOwn(s.att.streams!, r.stream)))) return;
  let queue = deliveryQueues.get(t);
  if (!queue) { queue = { tail: Promise.resolve(), bytes: 0, jobs: 0 }; deliveryQueues.set(t, queue); }
  const size = bytes(records);
  if (queue.bytes + size > 2 * 1024 * 1024 || queue.jobs >= 64) {
    // Durable readers resume from their last cursor; ephemeral readers see an
    // explicit disconnect. Never grow a hidden unbounded in-memory backlog.
    closeStreamReaders(t, records, 1013, "Stream delivery overloaded; reconnect");
    return;
  }
  queue.bytes += size; queue.jobs++;
  const current = queue;
  current.tail = current.tail.then(async () => {
    // Defer built-in notifications until a surrounding SQLite transaction has
    // committed. A rolled-back source row must never reach a stream reader.
    if (verify && !verify()) return;
    const status = await t.env.ACCOUNTS.prepare(`SELECT t.state,a.suspended_at,a.deleting_at FROM tendrils t
      LEFT JOIN accounts a ON a.id=t.owner_account WHERE t.id=?`).bind(t.tid)
      .first<{ state: string; suspended_at: number | null; deleting_at: number | null }>();
    if (!status || status.state !== "active" || status.suspended_at || status.deleting_at) {
      closeStreamReaders(t, records, 4003, "Page access revoked"); return;
    }
    const active = new Map<string, boolean>();
    for (const { ws } of t.connectedSockets()) {
      let att = t.att(ws);
      if (!att?.streams || !records.some(r => Object.hasOwn(att!.streams!, r.stream))) continue;
      if (att.accountId) {
        if (!active.has(att.accountId)) active.set(att.accountId, !!await t.env.ACCOUNTS.prepare("SELECT 1 FROM accounts WHERE id=? AND suspended_at IS NULL AND deleting_at IS NULL").bind(att.accountId).first());
        if (!active.get(att.accountId)) { ws.close(4003, "Page access revoked"); continue; }
      }
      for (const record of records) {
        att = localReader(t, ws, streamInfo(t, record.stream));
        if (!att) { ws.close(4003, "Stream access revoked"); break; }
        const after = att.streams && Object.hasOwn(att.streams, record.stream) ? att.streams[record.stream] : undefined;
        if (after === undefined || record.seq <= after) continue;
        // Native sockets may expose a buffered byte count; avoid buffering
        // arbitrarily behind a slow browser when the transport supplies it.
        if ((ws as WebSocket & { bufferedAmount?: number }).bufferedAmount! > 1024 * 1024) { ws.close(1013, "Stream reader too slow"); break; }
        try { ws.send(JSON.stringify({ t: "stream_record", record })); }
        catch { try { ws.close(1013, "Stream delivery failed; reconnect"); } catch {} break; }
        ws.serializeAttachment({ ...att, streams: { ...att.streams, [record.stream]: record.seq } });
      }
    }
  }).catch(error => {
    console.error("stream delivery failed", error);
    // Do not leave a healthy-looking connection that can advance past a
    // failed durable delivery. Reconnect resumes from the browser's cursor.
    closeStreamReaders(t, records, 1013, "Stream delivery failed; reconnect");
  }).finally(() => { current.bytes -= size; current.jobs--; });
  t.ctx.waitUntil(current.tail);
}

export function emitBuiltinRecord(t: Tendril, name: string, seq: number): void {
  const table = TABLES[name]; if (!table) return;
  const row = t.db.one(`SELECT * FROM ${table} WHERE seq=?`, seq); if (!row) return;
  const record = renderBuiltin(name, row), fingerprint = JSON.stringify(row);
  queueDelivery(t, [record], () => JSON.stringify(t.db.one(`SELECT * FROM ${table} WHERE seq=?`, seq)) === fingerprint);
}
export function emitBuiltinSignal(t: Tendril, name: "system.state" | "system.presence", type: string, data: unknown, producer = "system"): void {
  let seq: number;
  if (name === "system.state") seq = t.getState().rev;
  else seq = t.db.one<{ seq: number }>(`INSERT INTO stream_counters(name,seq) VALUES(?,1)
    ON CONFLICT(name) DO UPDATE SET seq=seq+1 RETURNING seq`, name)!.seq;
  // These are ephemeral observations of current state. Reading uncached SQL
  // suppresses rolled-back transitions; newer transitions may coalesce them.
  const state = name === "system.state" ? t.db.one<{ v: string }>("SELECT v FROM meta WHERE k='state'")?.v : null;
  queueDelivery(t, [{ stream: name, seq, ts: t.now(), received_at: t.now(), type, data, producer, id: null }], () =>
    name === "system.state"
      ? t.db.one<{ v: string }>("SELECT v FROM meta WHERE k='rev'")?.v === String(seq)
        && t.db.one<{ v: string }>("SELECT v FROM meta WHERE k='state'")?.v === state
      : t.db.one<{ seq: number }>("SELECT seq FROM stream_counters WHERE name=?", name)?.seq === seq
        && JSON.stringify(t.presence()) === JSON.stringify(data));
}
