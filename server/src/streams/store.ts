// Stream definitions, storage, retention and bounded history. No socket effects.
import { assertValid } from "../../../contract/index.mjs";
import { STREAM_LIMITS, streamRecordLimit } from "../../../contract/limits.mjs";
import type { StreamInfo, StreamRecord, StreamBatch, StreamLatest, StreamTrimResult, StreamAppendResult, StreamInput } from "../../../contract/index.mjs";
import type { Tendril } from "../tendril";
import { HttpError } from "../http";
import { BUILTIN_STREAMS, builtinTable, tableHistorySource, renderBuiltinRecord } from "./adapters";
import { readHistory, type HistorySource } from "./history";
import { MAX_STREAMS, MAX_STREAM_RECORD_BYTES, MAX_STREAM_SNAPSHOT_RECORD_BYTES, MAX_STREAM_BATCH_BYTES, MAX_STREAM_RECORDS,
  MAX_STREAM_REPLAY_BYTES, STREAM_NAME_PATTERN, streamCursor, jsonBytes, effectiveStreamLimits } from "./limits";

type StreamStoreContext = Pick<Tendril, "db" | "now" | "transaction">;
type StreamRow = Omit<StreamInfo, "builtin"> & { latest_seq: number };
type RecordRow = { stream: string; seq: number; ts: number; received_at: number; type: string; data: string; producer: string; id: string; bytes: number };
const rowInfo = (row: StreamRow): StreamInfo => ({ name: row.name, durability: row.durability, readers: row.readers,
  builtin: false, max_records: row.max_records, max_age_seconds: row.max_age_seconds });

export function streamInfo(t: StreamStoreContext, name: string): StreamInfo {
  if (!STREAM_NAME_PATTERN.test(name)) throw new HttpError(400, "bad_request", "Invalid stream name");
  const builtin = BUILTIN_STREAMS.find(s => s.name === name);
  if (builtin) return { ...builtin };
  const row = t.db.one<StreamRow>("SELECT * FROM streams WHERE name=?", name);
  if (!row) throw new HttpError(404, "not_found", "No such stream");
  return rowInfo(row);
}


export function streamDefinitions(t: StreamStoreContext): StreamInfo[] {
  return [...BUILTIN_STREAMS.map(s => ({ ...s })), ...t.db.all<StreamRow>("SELECT * FROM streams ORDER BY name").map(rowInfo)];
}
export function createStream(t: StreamStoreContext, value: unknown): StreamInfo {
  const body = assertValid("streamCreate", value);
  if (body.name.startsWith("system.")) throw new HttpError(400, "reserved_stream", "system.* streams are built in");
  if (t.db.one("SELECT name FROM streams WHERE name=?", body.name)) throw new HttpError(409, "exists", "Stream configuration is immutable");
  if ((t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM streams")?.n ?? 0) >= MAX_STREAMS)
    throw new HttpError(429, "quota", "At most 64 custom streams per tendril");
  t.db.run("INSERT INTO streams(name,durability,readers,max_records,max_age_seconds,latest_seq) VALUES(?,?,?,?,?,0)",
    body.name, body.durability, body.readers ?? "owner", body.durability === "durable" ? body.max_records ?? STREAM_LIMITS.stream_records : null,
    body.durability === "durable" ? body.max_age_seconds ?? 86400 : null);
  return streamInfo(t, body.name);
}


export function streamHighWater(t: StreamStoreContext, name: string): number {
  if (builtinTable(name)) return t.db.one<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name=?", builtinTable(name))?.seq ?? 0;
  if (name === "system.state") return t.db.get<number>("rev", 0);
  if (name === "system.presence") return t.db.one<{ seq: number }>("SELECT seq FROM stream_counters WHERE name=?", name)?.seq ?? 0;
  return t.db.one<{ latest_seq: number }>("SELECT latest_seq FROM streams WHERE name=?", name)?.latest_seq ?? 0;
}

/** Ephemeral signals retain sequence metadata only; their payload stays in memory. */
export function builtinSignal(t: StreamStoreContext, name: "system.state" | "system.presence", type: string, data: unknown, producer: string): StreamRecord {
  const seq = name === "system.state" ? streamHighWater(t, name)
    : t.db.one<{ seq: number }>(`INSERT INTO stream_counters(name,seq) VALUES(?,1)
        ON CONFLICT(name) DO UPDATE SET seq=seq+1 RETURNING seq`, name)!.seq;
  return { stream: name, seq, ts: t.now(), received_at: t.now(), type, data: structuredClone(data), producer, id: null };
}

function renderRecord(row: RecordRow): StreamRecord {
  return { stream: row.stream, seq: row.seq, ts: row.ts, received_at: row.received_at,
    type: row.type, data: JSON.parse(row.data), producer: row.producer, id: row.id };
}

/** Pruning never resets high-water marks and dedupe lasts for retained records. */
export function pruneStreams(t: StreamStoreContext): void {
  for (const s of t.db.all<StreamRow>("SELECT * FROM streams WHERE durability='durable'")) pruneStream(t, rowInfo(s));
  t.db.run("DELETE FROM stream_rate WHERE minute<?", Math.floor(t.now() / 60_000) - 2);
}
function pruneStream(t: StreamStoreContext, info: StreamInfo): void {
  t.db.run("DELETE FROM stream_records WHERE stream=? AND received_at<?", info.name, t.now() - info.max_age_seconds! * 1000);
  const boundary = t.db.one<{ seq: number }>("SELECT seq FROM stream_records WHERE stream=? ORDER BY seq DESC LIMIT 1 OFFSET ?", info.name, info.max_records);
  if (boundary) t.db.run("DELETE FROM stream_records WHERE stream=? AND seq<=?", info.name, boundary.seq);
}


export function streamHistorySource(t: StreamStoreContext, name: string): HistorySource<StreamRecord> {
  const table = builtinTable(name);
  if (table) return tableHistorySource(t.db, table, row => renderBuiltinRecord(name, row));
  return {
    highWater: () => streamHighWater(t, name),
    earliest: () => t.db.one<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM stream_records WHERE stream=?", name)?.seq ?? null,
    *read(after, limit) {
      for (const row of t.db.all<RecordRow>("SELECT * FROM stream_records WHERE stream=? AND seq>? ORDER BY seq LIMIT ?", name, after, limit))
        yield renderRecord(row);
    },
  };
}

export function readStream(t: StreamStoreContext, name: string, after: number, limit = 100): StreamBatch {
  const info = streamInfo(t, name);
  if (info.durability === "ephemeral") throw new HttpError(409, "not_replayable", "Ephemeral streams have no retained records");
  streamCursor(after);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > STREAM_LIMITS.replay_records) throw new HttpError(400, "bad_request", "limit must be an integer from 1 to 500");
  if (!info.builtin) pruneStream(t, info);
  const page = readHistory(streamHistorySource(t, name), after, limit, { maxBytes: MAX_STREAM_REPLAY_BYTES, sizeOf: jsonBytes });
  if (after > page.history.latest_seq) throw new HttpError(400, "cursor_ahead", "after is beyond this stream's history", { latest_seq: page.history.latest_seq });
  return { stream: name, durability: info.durability, records: page.records, cursor: page.cursor, history: page.history };
}

/** A current snapshot deliberately skips history; it never acknowledges events. */
export function latestStream(t: StreamStoreContext, name: string): StreamLatest {
  const info = streamInfo(t, name);
  if (info.durability === "ephemeral") throw new HttpError(409, "not_replayable", "Ephemeral streams have no retained records");
  if (!info.builtin) pruneStream(t, info);
  const table = builtinTable(name);
  const row = table ? t.db.one(`SELECT * FROM ${table} ORDER BY seq DESC LIMIT 1`)
    : t.db.one<RecordRow>("SELECT * FROM stream_records WHERE stream=? ORDER BY seq DESC LIMIT 1", name);
  const record = row ? table ? renderBuiltinRecord(name, row) : renderRecord(row as RecordRow) : null;
  return { stream: name, durability: "durable", record, cursor: streamHighWater(t, name) };
}

/** Trim an explicitly observed prefix; sequence numbers and stream policy never reset. */
export function trimStream(t: StreamStoreContext, name: string, through: number): StreamTrimResult {
  const info = streamInfo(t, name);
  if (info.builtin) throw new HttpError(403, "readonly_stream", "Built-in streams are managed through their existing APIs");
  if (info.durability === "ephemeral") throw new HttpError(409, "not_replayable", "Ephemeral streams have no retained records");
  streamCursor(through, "through");
  return t.transaction(() => {
    const cursor = streamHighWater(t, name);
    if (through > cursor) throw new HttpError(400, "cursor_ahead", "through is beyond this stream's history", { latest_seq: cursor });
    const deleted = t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM stream_records WHERE stream=? AND seq<=?", name, through)!.n;
    t.db.run("DELETE FROM stream_records WHERE stream=? AND seq<=?", name, through);
    return { stream: name, through, deleted_records: deleted, cursor };
  });
}

/** Bounded per-principal and aggregate budgets survive hibernation/restarts. */
function chargeRate(t: StreamStoreContext, principal: string, amount: number): void {
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


/** onAccepted joins synchronous database work; external effects must use afterCommit. */
export function appendToStore(t: StreamStoreContext, name: string, value: unknown, producer: string, producerKey = producer,
  onAccepted?: () => void): { result: StreamAppendResult; fresh: StreamRecord[] } {
  const info = streamInfo(t, name);
  if (info.builtin) throw new HttpError(403, "readonly_stream", "Built-in streams are written through their existing APIs");
  const body = assertValid("streamAppend", value);
  const size = jsonBytes(body);
  if (size > MAX_STREAM_BATCH_BYTES) throw new HttpError(413, "too_large", "Stream batch exceeds 256 KiB");
  const recordLimit = streamRecordLimit(info);
  for (const record of body.records) if (jsonBytes(record) > recordLimit)
    throw new HttpError(413, "too_large", `Stream record exceeds ${recordLimit / 1024} KiB`);
  chargeRate(t, producer, size);
  const receivedAt = t.now(), fresh: StreamRecord[] = [];
  const result = t.transaction(() => {
    let seq = streamHighWater(t, name);
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
        jsonBytes(record) + new TextEncoder().encode(producerKey).byteLength);
      fresh.push(record); records.push(record);
    }
    t.db.run("UPDATE streams SET latest_seq=? WHERE name=?", seq, name);
    if (info.durability === "durable") {
      pruneStream(t, info);
      const usage = t.db.one<{ count: number; bytes: number }>("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM stream_records")!;
      const allowance = effectiveStreamLimits(t).retained_bytes;
      if (usage.count > MAX_STREAM_RECORDS || usage.bytes > allowance)
        throw new HttpError(413, "quota", "Custom stream retention allowance reached", { max_records: MAX_STREAM_RECORDS, max_bytes: allowance });
    }
    onAccepted?.();
    return { records, cursor: seq, durability: info.durability };
  });
  return { result, fresh };
}
