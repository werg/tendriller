// Stable entry points and HTTP adaptation for named streams.
import type { StreamInfo, StreamRecord, StreamBatch, StreamAppendResult } from "../../contract/index.mjs";
import type { Tendril } from "./tendril";
import { HttpError, json, readJson } from "./http";
import { requireWritesOpen } from "./service-state";
import { allows, canReadStream, socketPrincipal, authenticateProducer, producerStillValid, producerMayAppend,
  recordProducerActivity, type StreamActor } from "./access";
import { streamInfo, streamDefinitions, createStream, appendToStore, readStream, latestStream, trimStream, builtinSignal } from "./streams/store";
import { builtinRecord } from "./streams/adapters";
import { createProducer, listProducers, deleteProducer } from "./streams/producers";
import { deliverStreamRecords } from "./streams/broker";
import { MAX_STREAM_BATCH_BYTES, streamCursor } from "./streams/limits";

export type { StreamInfo, StreamRecord, StreamBatch, StreamAppendResult, StreamActor };
export { canReadStream };
export { streamInfo, createStream, readStream, pruneStreams } from "./streams/store";
export { createProducer, listProducers, deleteProducer } from "./streams/producers";
export { subscribeStream, unsubscribeStream } from "./streams/broker";
export { MAX_STREAMS, MAX_PRODUCERS, MAX_STREAM_RECORD_BYTES, MAX_STREAM_BATCH_BYTES, MAX_STREAM_BYTES,
  MAX_STREAM_RECORDS, MAX_STREAM_REPLAY_BYTES } from "./streams/limits";

export function listStreams(t: Tendril, actor: StreamActor = { kind: "agent", name: "agent" }): StreamInfo[] {
  return streamDefinitions(t).filter(info => canReadStream(info, actor));
}
function requireReader(info: StreamInfo, actor: StreamActor): void {
  if (!canReadStream(info, actor)) throw new HttpError(403, "forbidden", "This stream is not shared with this reader");
}

/** Commit storage first; outer transactions retain ownership of delivery. */
export function appendRecords(t: Tendril, name: string, value: unknown, producer: string, producerKey = producer): StreamAppendResult {
  return appendAndDeliver(t, name, value, producer, producerKey);
}
function appendAndDeliver(t: Tendril, name: string, value: unknown, producer: string, producerKey: string, onAccepted?: () => void): StreamAppendResult {
  const { result, fresh } = appendToStore(t, name, value, producer, producerKey, onAccepted);
  // Notifications describe accepted bytes even if an in-process caller mutates
  // its input or the returned receipt before an enclosing transaction commits.
  const notifications = structuredClone(fresh);
  t.afterCommit(() => deliverStreamRecords(t, notifications));
  return result;
}

export function emitBuiltinRecord(t: Tendril, name: string, seq: number): void {
  const record = builtinRecord(t.db, name, seq);
  if (record) t.afterCommit(() => deliverStreamRecords(t, [record]));
}

export function emitBuiltinSignal(t: Tendril, name: "system.state" | "system.presence", type: string, data: unknown, producer = "system"): void {
  const record = builtinSignal(t, name, type, data, producer);
  t.afterCommit(() => deliverStreamRecords(t, [record]));
}

export async function handleProducer(t: Tendril, req: Request, rest: string): Promise<Response> {
  const principal = await authenticateProducer(t, req);
  const match = /^streams\/([a-z][a-z0-9._-]{0,63})\/records$/.exec(rest);
  if (req.method !== "POST" || !match || !producerMayAppend(principal, match[1]))
    throw new HttpError(403, "forbidden", "This credential can only append to its configured streams");
  const body = await readJson(req, MAX_STREAM_BATCH_BYTES);
  // Body I/O can yield: revocation must still take effect before committing.
  if (!producerStillValid(t, principal)) throw new HttpError(401, "unauthorized", "Producer credential was revoked");
  const result = appendAndDeliver(t, match[1], body, `producer:${principal.name}`, principal.credentialHash,
    () => recordProducerActivity(t, principal));
  return json(result);
}

export async function publishFromPage(t: Tendril, ws: WebSocket, name: string, value: unknown): Promise<StreamAppendResult> {
  await requireWritesOpen(t.env);
  const info = streamInfo(t, name), principal = socketPrincipal(t, ws);
  if (!principal || !allows(principal, "page.owner") || !canReadStream(info, principal))
    throw new HttpError(403, "forbidden", "Only the owner may publish custom stream data");
  return appendRecords(t, name, value, `device:${principal.deviceId}`);
}

export const STREAM_ROUTE = /^(?:streams(?:\/[a-z][a-z0-9._-]{0,63}(?:\/(?:records|latest))?)?|producers(?:\/[a-z][a-z0-9._-]{0,63})?)$/;
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
  if (parts[2] === "latest" && req.method === "GET") return json(latestStream(t, info.name));
  if (parts[2] === "records" && req.method === "GET") {
    const after = url.searchParams.get("after"), limit = url.searchParams.get("limit");
    if (after === null || after.trim() === "") throw new HttpError(400, "cursor_required", "Provide an explicit after cursor");
    return json(readStream(t, info.name, streamCursor(Number(after)), limit === null ? 100 : Number(limit)));
  }
  if (parts[2] === "records" && req.method === "POST" && actor.kind === "agent")
    return json(appendRecords(t, info.name, await readJson(req, MAX_STREAM_BATCH_BYTES), `agent:${actor.name}`));
  if (parts[2] === "records" && req.method === "DELETE") {
    if (actor.kind !== "agent") throw new HttpError(403, "forbidden", "Only an agent may trim retained stream records");
    const through = url.searchParams.get("through");
    if (through === null || through.trim() === "") throw new HttpError(400, "cursor_required", "Provide an explicit through cursor");
    return json(trimStream(t, info.name, streamCursor(Number(through), "through")));
  }
  throw new HttpError(405, "method_not_allowed");
}
