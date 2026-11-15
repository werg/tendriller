// Live subscriptions and bounded fanout. Storage admission happens elsewhere.
import type { StreamInfo, StreamRecord } from "../../../contract/index.mjs";
import type { Att, Tendril } from "../tendril";
import { HttpError } from "../http";
import { canReadStream, socketPrincipal, pageAccessAllowed, accountActive } from "../access";
import { streamInfo, streamHighWater, readStream } from "./store";
import { MAX_SUBSCRIPTIONS, streamCursor, jsonBytes } from "./limits";

function localReader(t: Tendril, ws: WebSocket, info: StreamInfo): Att | null {
  const principal = socketPrincipal(t, ws);
  return principal && canReadStream(info, principal) ? t.att(ws) : null;
}

export function subscribeStream(t: Tendril, ws: WebSocket, name: string, after?: number) {
  const info = streamInfo(t, name), att = localReader(t, ws, info);
  if (!att) throw new HttpError(403, "forbidden", "This reader cannot subscribe to this stream");
  if (after !== undefined && info.durability === "ephemeral") throw new HttpError(409, "not_replayable", "Subscribe to ephemeral streams without after");
  const subscriptions = { ...att.streams };
  if (!Object.hasOwn(subscriptions, name) && Object.keys(subscriptions).length >= MAX_SUBSCRIPTIONS)
    throw new HttpError(429, "quota", "At most 16 stream subscriptions per socket");
  // No await between capturing history and installing the live high-water mark.
  const batch = after === undefined ? undefined : readStream(t, name, streamCursor(after), 500);
  const latest = streamHighWater(t, name);
  subscriptions[name] = latest;
  ws.serializeAttachment({ ...att, streams: subscriptions });
  return { stream: name, durability: info.durability, cursor: latest, ...(batch ? { batch } : {}) };
}
export function unsubscribeStream(t: Tendril, ws: WebSocket, name: string): void {
  const att = t.att(ws); if (!att) return;
  const streams = { ...att.streams }; delete streams[name]; ws.serializeAttachment({ ...att, streams });
}

type DeliveryQueue = { tail: Promise<void>; bytes: number; jobs: number };
const deliveryQueues = new WeakMap<Tendril, DeliveryQueue>();
function closeStreamReaders(t: Tendril, records: StreamRecord[], code: number, reason: string): void {
  for (const { ws, att } of t.connectedSockets()) {
    if (!att.streams || !records.some(record => Object.hasOwn(att.streams!, record.stream))) continue;
    try { ws.close(code, reason); } catch {}
  }
}
export function deliverStreamRecords(t: Tendril, records: StreamRecord[]): void {
  if (!records.length || !t.connectedSockets().some(s => s.att.streams && records.some(r => Object.hasOwn(s.att.streams!, r.stream)))) return;
  let queue = deliveryQueues.get(t);
  if (!queue) { queue = { tail: Promise.resolve(), bytes: 0, jobs: 0 }; deliveryQueues.set(t, queue); }
  const size = jsonBytes(records);
  if (queue.bytes + size > 2 * 1024 * 1024 || queue.jobs >= 64) {
    // Durable readers resume from their last cursor; ephemeral readers see an
    // explicit disconnect. Never grow a hidden unbounded in-memory backlog.
    closeStreamReaders(t, records, 1013, "Stream delivery overloaded; reconnect");
    return;
  }
  queue.bytes += size; queue.jobs++;
  const current = queue;
  current.tail = current.tail.then(async () => {
    if (!await pageAccessAllowed(t)) {
      closeStreamReaders(t, records, 4003, "Page access revoked"); return;
    }
    const active = new Map<string, boolean>();
    for (const { ws } of t.connectedSockets()) {
      let att = t.att(ws);
      if (!att?.streams || !records.some(r => Object.hasOwn(att!.streams!, r.stream))) continue;
      if (att.accountId) {
        if (!active.has(att.accountId)) active.set(att.accountId, await accountActive(t, att.accountId));
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
