import { assertValid } from "../../contract/index.mjs";
import { streamReadQuery } from "../../contract/streams-client.mjs";
import type { BrowserStreams, StreamBatch, StreamHistory, StreamRecord, StreamSubscribeOptions } from "../../contract/index.mjs";
import type { Bus } from "./types";

interface Host {
  bus: Bus;
  base: string;
  connected(): boolean;
  headers(): Record<string, string>;
  request(message: { t: string; [key: string]: any }): Promise<any>;
  fetch?: typeof globalThis.fetch;
}
interface Subscriber {
  cursor: number | null;
  joinAfter?: number;
  handler: (record: StreamRecord) => void;
  options: StreamSubscribeOptions;
  active: boolean;
}
interface Channel {
  name: string;
  subscribers: Set<Subscriber>;
  generation: number;
  durability?: "durable" | "ephemeral";
  active: boolean;
  pending: boolean;
  observed?: number;
  buffer: StreamRecord[];
  bufferedBytes: number;
  retry?: ReturnType<typeof setTimeout>;
  attempts: number;
  abort?: AbortController;
}

const MAX_BUFFER_RECORDS = 1000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const TERMINAL = new Set(["unauthorized", "forbidden", "not_found", "not_replayable", "bad_request", "cursor_ahead", "invalid_response"]);
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const asError = (value: unknown): Error & { code?: string } => value instanceof Error ? value : failure("stream_error", String(value));

/** One socket subscription per stream; each local consumer keeps its own delivery cursor. */
export function createStreams(host: Host): BrowserStreams {
  const channels = new Map<string, Channel>();
  const path = (name: string) => `streams/${encodeURIComponent(assertValid("streamName", name))}`;
  const fetcher = host.fetch || globalThis.fetch.bind(globalThis);

  async function get<K extends "streamList" | "streamInfo" | "streamBatch">(suffix: string, schema: K, signal?: AbortSignal) {
    const response = await fetcher(host.base + "_tendril/" + suffix, { headers: host.headers(), cache: "no-store", signal });
    let value: any;
    try { value = await response.json(); }
    catch { throw failure("invalid_response", "The stream service returned an invalid response"); }
    if (!response.ok) throw failure(value?.error?.code || "http_error", value?.error?.message || `HTTP ${response.status}`);
    try { return assertValid(schema, value); }
    catch { throw failure("invalid_response", `The service response does not match ${schema}`); }
  }

  const generationFence = (channel: Channel) => {
    const generation = channel.generation;
    return () => channel.generation === generation && channels.get(channel.name) === channel && host.connected();
  };

  const report = (channel: Channel, error: unknown, only?: Subscriber, current = generationFence(channel)) => {
    const err = asError(error);
    host.bus.emit("stream_error", { stream: channel.name, error: err });
    for (const subscriber of only ? [only] : [...channel.subscribers]) {
      if (!current()) break;
      if (!subscriber.active || !subscriber.options.onError) continue;
      try { subscriber.options.onError(err); } catch { /* An error observer cannot stop another consumer. */ }
    }
  };

  const deliver = (channel: Channel, record: StreamRecord, current: () => boolean) => {
    for (const subscriber of [...channel.subscribers]) {
      if (!current()) return false;
      if (!subscriber.active || subscriber.cursor === null || record.seq <= subscriber.cursor) continue;
      // This is a delivery checkpoint only. Applications needing handled/transactional
      // acknowledgement use explicit reads and persist their own processing checkpoint.
      subscriber.cursor = record.seq;
      try { subscriber.handler(record); }
      catch (error) { if (current()) report(channel, failure("handler_error", asError(error).message), subscriber, current); }
    }
    return current();
  };

  const applyBatch = (channel: Channel, batch: StreamBatch, current: () => boolean): number | null => {
    const missing = batch.history.missing_through;
    const affected = batch.history.gap && missing !== null
      ? [...channel.subscribers].filter(sub => sub.active && sub.cursor !== null && sub.cursor < missing) : [];
    if (affected.length) {
      host.bus.emit("stream_gap", { stream: channel.name, history: batch.history });
      for (const subscriber of affected) {
        if (!current()) return null;
        if (!subscriber.active) continue;
        try { subscriber.options.onGap?.(batch.history); }
        catch (error) { if (current()) report(channel, error, subscriber, current); }
      }
    }
    if (!current()) return null;
    for (const record of batch.records) if (!deliver(channel, record, current)) return null;
    // An entirely expired range has no record with which to advance the cursor.
    // Advance only after exposing the gap, including to the public stream_gap event.
    for (const subscriber of affected) if (subscriber.active) subscriber.cursor = Math.max(subscriber.cursor!, missing!);
    return Math.max(batch.cursor, batch.history.gap ? missing ?? 0 : 0);
  };

  const cancelRetry = (channel: Channel) => {
    if (channel.retry) clearTimeout(channel.retry);
    channel.retry = undefined;
  };
  const retry = (channel: Channel) => {
    if (channel.retry || !host.connected() || !channel.subscribers.size) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(channel.attempts++, 5));
    channel.retry = setTimeout(() => { channel.retry = undefined; void start(channel); }, delay);
  };

  async function start(channel: Channel) {
    if (!host.connected() || !channel.subscribers.size) return;
    cancelRetry(channel);
    channel.abort?.abort();
    channel.abort = new AbortController();
    channel.generation++;
    const current = generationFence(channel);
    channel.active = false;
    channel.pending = true;
    channel.buffer = [];
    channel.bufferedBytes = 0;
    const cursors = [...channel.subscribers].flatMap(sub => sub.cursor === null ? [] : [sub.cursor]);
    const after = channel.durability === "ephemeral" || !cursors.length ? undefined : Math.min(...cursors);
    try {
      const ack = assertValid("streamSubscription", await host.request({ t: "stream_subscribe", stream: channel.name, ...(after === undefined ? {} : { after }) }));
      if (!current()) return;
      channel.pending = false;
      if (ack.stream !== channel.name) throw failure("invalid_response", "The subscription response names another stream");
      channel.durability = ack.durability;
      channel.observed = Math.max(channel.observed ?? 0, ack.cursor);
      for (const subscriber of channel.subscribers) if (subscriber.cursor === null) {
        subscriber.cursor = Math.max(ack.cursor, subscriber.joinAfter ?? 0);
      }
      if (after !== undefined && ack.durability === "durable") {
        if (!ack.batch) throw failure("invalid_response", "Durable replay requires an initial stream batch");
        let cursor = applyBatch(channel, ack.batch, current);
        if (cursor === null) return;
        // The subscription is already attached at ack.cursor. Buffer its live frames
        // while fetching any older pages; otherwise >500 pending records would be lost.
        while (current() && cursor < ack.cursor) {
          const batch = await get(`${path(channel.name)}/records?${streamReadQuery({ after: cursor, limit: 500 })}`, "streamBatch", channel.abort.signal);
          if (!current()) return;
          if (batch.stream !== channel.name) throw failure("invalid_response", "History response names another stream");
          const next = applyBatch(channel, batch, current);
          if (next === null) return;
          if (next <= cursor) throw failure("invalid_response", "Stream replay did not advance through its subscription boundary");
          cursor = next;
        }
      }
      if (!current()) return;
      const buffered = channel.buffer.sort((a, b) => a.seq - b.seq);
      channel.buffer = [];
      channel.bufferedBytes = 0;
      channel.active = true;
      channel.attempts = 0;
      for (const record of buffered) if (!deliver(channel, record, current)) break;
    } catch (error) {
      if (!current()) return;
      channel.active = false;
      channel.pending = false;
      channel.buffer = [];
      channel.bufferedBytes = 0;
      report(channel, error, undefined, current);
      if (current() && !TERMINAL.has(asError(error).code || "")) retry(channel);
    }
  }

  host.bus.on("stream_record", (value: StreamRecord) => {
    const channel = channels.get(value?.stream);
    if (!channel) return;
    let record: StreamRecord;
    try { record = assertValid("streamRecord", value); }
    catch { report(channel, failure("invalid_response", "The service sent an invalid stream record")); return; }
    channel.observed = Math.max(channel.observed ?? 0, record.seq);
    if (channel.active) {
      if (channel.durability === "durable" && [...channel.subscribers].some(sub => sub.active && sub.cursor !== null && record.seq > sub.cursor + 1)) {
        // Recover a dropped live frame before advancing past it. The server's
        // retained history will either supply it or expose an explicit gap.
        void start(channel);
      } else deliver(channel, record, generationFence(channel));
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (channel.buffer.length >= MAX_BUFFER_RECORDS || channel.bufferedBytes + bytes > MAX_BUFFER_BYTES) {
      channel.generation++;
      channel.pending = false;
      channel.abort?.abort();
      channel.buffer = [];
      channel.bufferedBytes = 0;
      report(channel, failure("stream_overflow", channel.durability === "ephemeral"
        ? "Live samples were dropped while this consumer was catching up"
        : "Stream buffer filled; replay will resume from the last delivered cursor"));
      retry(channel);
      return;
    }
    channel.buffer.push(record);
    channel.bufferedBytes += bytes;
  });
  host.bus.on("connect", () => { for (const channel of channels.values()) void start(channel); });
  host.bus.on("disconnect", () => {
    for (const channel of channels.values()) {
      channel.generation++;
      channel.active = false;
      channel.pending = false;
      channel.observed = undefined;
      channel.abort?.abort();
      cancelRetry(channel);
      channel.buffer = [];
      channel.bufferedBytes = 0;
      if (channel.durability === "ephemeral") for (const subscriber of channel.subscribers) {
        subscriber.cursor = null;
        subscriber.joinAfter = undefined;
      }
    }
  });

  return {
    list: () => get("streams", "streamList"),
    info: name => get(path(name), "streamInfo"),
    read: (name, options) => get(`${path(name)}/records?${streamReadQuery(options)}`, "streamBatch", options.signal),
    subscribe(name, handler, options = {}) {
      assertValid("streamName", name);
      if (typeof handler !== "function") throw new TypeError("A stream subscriber needs a callback");
      if (options.after !== undefined) streamReadQuery({ after: options.after });
      let channel = channels.get(name);
      if (channel?.durability === "ephemeral" && options.after !== undefined) throw failure("not_replayable", "Ephemeral streams do not support replay cursors");
      if (!channel) {
        channel = { name, subscribers: new Set(), generation: 0, active: false, pending: false, buffer: [], bufferedBytes: 0, attempts: 0 };
        channels.set(name, channel);
      }
      const reuseLive = channel.durability === "ephemeral" && channel.active;
      const subscriber: Subscriber = { handler, options, active: true,
        cursor: reuseLive ? channel.observed ?? 0 : options.after ?? null,
        joinAfter: options.after === undefined ? channel.observed : undefined };
      channel.subscribers.add(subscriber);
      // Live consumers can share an established subscription or pending handshake.
      // Their join boundary skips pre-join buffered frames without discarding them
      // for existing consumers. Explicit replay cursors still start fresh catch-up.
      if (!reuseLive && !(channel.pending && options.after === undefined)) void start(channel);
      return () => {
        if (!subscriber.active) return;
        subscriber.active = false;
        channel!.subscribers.delete(subscriber);
        if (channel!.subscribers.size) return;
        channel!.generation++;
        channel!.abort?.abort();
        cancelRetry(channel!);
        channels.delete(name);
        if (host.connected()) void host.request({ t: "stream_unsubscribe", stream: name }).catch(() => {});
      };
    },
    async publish(name, body) {
      assertValid("streamCustomName", name);
      assertValid("streamAppend", body);
      if (!host.connected()) throw failure("offline", "Stream publishing needs a connected page; nothing was queued");
      const ack = await host.request({ t: "stream_publish", stream: name, records: body.records });
      return assertValid("streamAppendResult", { records: ack.records, cursor: ack.cursor, durability: ack.durability });
    },
  };
}
