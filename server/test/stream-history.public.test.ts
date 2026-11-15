import { expect, it } from "vitest";
import { addEvent } from "../src/events";
import { appendRecords } from "../src/streams";
import { historyPage, mergeHistoryGaps, readHistory } from "../src/streams/history";
import { appendToStore, streamHistorySource } from "../src/streams/store";
import { legacyHistorySource } from "../src/streams/adapters";
import type { Db } from "../src/db";
import { api, apiJson, create, inDO, PageClient, sleep } from "./helpers";

it("distinguishes byte-truncated history from genuinely missing sequences", () => {
  const page = historyPage([{ seq: 2 }, { seq: 4 }, { seq: 7 }], {
    after: 0, earliest: 2, latest: 10, limit: 100, maxBytes: 2, sizeOf: () => 1,
  });
  expect(page.records.map(r => r.seq)).toEqual([2, 4]);
  expect(page.cursor).toBe(4);
  expect(page.gap).toEqual({ from: 1, through: 3 });
  // Sequences 5..10 were not inspected: byte pagination is not a retention gap.
  expect(page.history.missing_through).toBe(3);
  const next = historyPage([{ seq: 7 }], { after: 4, earliest: 2, latest: 10, limit: 100 });
  expect(next.gap).toEqual({ from: 5, through: 10 });
});

it("decodes only the byte-bounded prefix while unbounded consumer reads still render the entire page", () => {
  let decoded = 0;
  const rows = Array.from({ length: 500 }, (_, i) => ({
    stream: "training", seq: i + 1, ts: i, received_at: i, type: "metric", producer: "test", id: `sample-${i}`,
    get data() { decoded++; return '{"loss":1}'; },
  }));
  const db = {
    one: (sql: string) => sql.includes("MIN(seq)") ? { seq: 1 } : { seq: 500, latest_seq: 500 },
    all: () => rows,
  } as unknown as Db;
  const legacy = legacyHistorySource(db, "events", row => ({ seq: row.seq, data: JSON.parse(row.data) }));
  const custom = streamHistorySource({ db, now: () => 1000, transaction: write => write() }, "training");
  for (const source of [legacy, custom]) {
    decoded = 0;
    const page = readHistory(source, 0, 500, { maxBytes: 2, sizeOf: () => 1 });
    expect(page.records.map(record => record.seq)).toEqual([1, 2]);
    expect(decoded).toBe(3); // One lookahead measures the first row that exceeds the bound.
    expect(page.cursor).toBe(2); expect(page.history.gap).toBe(false);
    decoded = 0;
    const unbounded = readHistory(source, 0, 500);
    expect(unbounded.records).toHaveLength(500); expect(decoded).toBe(500);
    expect(unbounded.cursor).toBe(500); expect(unbounded.history.gap).toBe(false);
  }
});

it("preserves sticky lease gaps across narrower pages and never invents a delivered cursor", () => {
  const wide = historyPage([{ seq: 2 }, { seq: 4 }], { after: 0, earliest: 2, latest: 8, limit: 100 });
  const narrow = historyPage([{ seq: 2 }], { after: 0, earliest: 2, latest: 8, limit: 1 });
  expect(narrow.gap).toEqual({ from: 1, through: 1 });
  expect(mergeHistoryGaps(wide.gap, narrow.gap)).toEqual({ from: 1, through: 8 });
  const empty = historyPage([], { after: 4, earliest: null, latest: 8, limit: 100 });
  expect(empty.cursor).toBe(4); expect(empty.gap).toEqual({ from: 5, through: 8 });
  const oversized = historyPage([{ seq: 5 }], { after: 4, earliest: 5, latest: 5, limit: 100, maxBytes: 1, sizeOf: () => 100 });
  expect(oversized.cursor).toBe(5); expect(oversized.history.gap).toBe(false);
});

it("shares original event history while leased checkpoints retain their own gap proof", async () => {
  const h = await create({ listener: false });
  const sequences = await inDO(h.id, t => t.transaction(() => {
    const sequences = Array.from({ length: 7 }, (_, i) => addEvent(t, { type: "event", data: { i }, wake: false }).seq);
    t.db.run("DELETE FROM events WHERE seq IN (?,?,?,?)", sequences[0], sequences[2], sequences[5], sequences[6]);
    return sequences;
  }));
  const after = sequences[0] - 1;
  const lease = await apiJson(h, "POST", "consumers/checker/claim", { holder: "history-check", after });
  const readLease = async (limit: number) => {
    const response = await api(h, "GET", `consumers/checker/events?limit=${limit}`, undefined, { "X-Tendril-Lease": lease.lease_token });
    expect(response.status).toBe(200); return response.json<any>();
  };
  const stream = await apiJson(h, "GET", `streams/system.events/records?after=${after}`), wide = await readLease(100);
  expect(stream.records.map((r: any) => r.data)).toEqual(wide.events);
  expect(stream.history).toEqual(wide.history);
  expect(wide.history.missing_through).toBe(sequences[6]);
  const narrow = await readLease(1);
  expect(narrow.events.map((e: any) => e.seq)).toEqual([sequences[1]]);
  expect(narrow.history.missing_through).toBe(sequences[6]);
  expect(narrow.consumer.handled_seq).toBe(after);
  const ordinary = await apiJson(h, "GET", `streams/system.events/records?after=${after}&limit=1`);
  expect(ordinary.history.missing_through).toBe(sequences[0]);
  expect((await api(h, "POST", "consumers/checker/ack", { through: sequences[4] }, { "X-Tendril-Lease": lease.lease_token })).status).toBe(409);
  expect((await api(h, "POST", "consumers/checker/ack", { through: sequences[4], gap_acknowledged: true }, { "X-Tendril-Lease": lease.lease_token })).status).toBe(200);
  const remaining = await readLease(100);
  expect(remaining.events).toEqual([]); expect(remaining.cursor).toBe(sequences[4]);
  expect(remaining.history.missing_through).toBe(sequences[6]);
});

it("holds custom stream fanout through an outer transaction and drops it on rollback", async () => {
  const h = await create({ listener: false });
  await apiJson(h, "POST", "streams", { name: "training", durability: "durable" });
  const page = await PageClient.connect(h.page_url);
  try {
    await page.request({ t: "stream_subscribe", stream: "training", after: 0 });
    await inDO(h.id, t => {
      expect(() => t.transaction(() => {
        appendRecords(t, "training", { records: [{ id: "rolled-back", type: "sample", data: 1 }] }, "test");
        throw Error("rollback outer write");
      })).toThrow("rollback outer write");
      expect(t.db.all("SELECT * FROM stream_records")).toEqual([]);
      expect(t.db.one("SELECT latest_seq FROM streams WHERE name='training'")).toEqual({ latest_seq: 0 });
    });
    await sleep(30); expect(page.drain().some(m => m.t === "stream_record")).toBe(false);
    await inDO(h.id, t => t.transaction(() => {
      appendRecords(t, "training", { records: [{ id: "first", type: "sample", data: 1 }] }, "test");
      appendRecords(t, "training", { records: [{ id: "second", type: "sample", data: 2 }] }, "test");
    }));
    const first = (await page.next("stream_record")).record, second = (await page.next("stream_record")).record;
    expect([first.id, second.id]).toEqual(["first", "second"]);
    expect([first.seq, second.seq]).toEqual([1, 2]);
  } finally { page.close(); }
});

it("delivers accepted payloads even when callers mutate inputs or receipts before commit", async () => {
  const h = await create({ listener: false });
  await apiJson(h, "POST", "streams", { name: "training", durability: "durable" });
  const page = await PageClient.connect(h.page_url);
  try {
    await page.request({ t: "stream_subscribe", stream: "training", after: 0 });
    await inDO(h.id, t => t.transaction(() => {
      const data = { loss: 1 };
      const receipt = appendRecords(t, "training", { records: [{ id: "sample", type: "metric", data }] }, "test");
      data.loss = 2;
      receipt.records[0].data = { loss: 3 };
    }));
    const live = (await page.next("stream_record")).record;
    const history = await apiJson(h, "GET", "streams/training/records?after=0");
    expect(live).toEqual(history.records[0]); expect(live.data).toEqual({ loss: 1 });
  } finally { page.close(); }
});

it("rolls back an admission callback with its records while preserving the charged request budget", async () => {
  const h = await create({ listener: false });
  await apiJson(h, "POST", "streams", { name: "training", durability: "durable" });
  await inDO(h.id, t => {
    let sent = false;
    expect(() => appendToStore(t, "training", { records: [{ id: "sample", type: "metric", data: 1 }] }, "test", "test", () => {
      t.db.set("last_producer_seen", 123);
      t.afterCommit(() => { sent = true; });
      throw Error("producer activity write failed");
    })).toThrow("producer activity write failed");
    expect(t.db.all("SELECT * FROM stream_records")).toEqual([]);
    expect(t.db.get("last_producer_seen", null)).toBeNull();
    expect(t.db.one("SELECT latest_seq FROM streams WHERE name='training'")).toEqual({ latest_seq: 0 });
    expect(t.db.one("SELECT requests FROM stream_rate WHERE principal='test'")).toEqual({ requests: 1 });
    expect(sent).toBe(false);
  });
});
