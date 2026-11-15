import { afterEach, expect, it } from "vitest";
import { STREAM_RECORD_BYTES, STREAM_SNAPSHOT_RECORD_BYTES } from "../../contract/index.mjs";
import { api, apiJson, create, inDO, PageClient, req } from "./helpers";

const pages: PageClient[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.close(); });
function sized(id: string, bytes: number) {
  const input = { id, type: "snapshot", data: { rows: [{ pid: 42, label: "" }] } };
  input.data.rows[0].label = "x".repeat(bytes - new TextEncoder().encode(JSON.stringify(input)).byteLength);
  return input;
}

it("publishes and replays a complete 192 KiB snapshot through the existing producer and page APIs", async () => {
  const h = await create({ listener: false });
  await apiJson(h, "POST", "streams", { name: "processes", durability: "durable", max_records: 1 }, 201);
  const producer = await apiJson(h, "POST", "producers", { name: "host", streams: ["processes"] }, 201);
  const first = sized("first", STREAM_SNAPSHOT_RECORD_BYTES);
  const response = await api(h, "POST", "streams/processes/records", { records: [first] }, {}, producer.token);
  expect(response.status).toBe(200);
  const receipt = await response.json<any>();
  expect(receipt.records[0]).toMatchObject({ ...first, producer: "producer:host", seq: 1 });
  const latest = await apiJson(h, "GET", "streams/processes/latest");
  expect(latest.record).toEqual(receipt.records[0]);
  expect(await (await req(h.page_url + "_tendril/streams/processes/latest")).json()).toEqual(latest);
  const page = await PageClient.connect(h.page_url); pages.push(page);
  const replay = await page.request({ t: "stream_subscribe", stream: "processes", after: 0 });
  expect(replay.batch.records).toEqual([latest.record]);

  const second = sized("second", STREAM_SNAPSHOT_RECORD_BYTES);
  const replacement = await page.request({ t: "stream_publish", stream: "processes", records: [second] });
  expect(replacement.cursor).toBe(2);
  expect((await page.next("stream_record")).record).toMatchObject({ ...second, seq: 2 });
  expect((await apiJson(h, "GET", "streams/processes/latest")).record).toMatchObject(second);
  const retained = await apiJson(h, "GET", "streams/processes/records?after=0");
  expect(retained.records).toHaveLength(1);
  expect(retained.records[0]).toMatchObject(second);
  expect(retained.history.gap).toBe(true);
});

it("limits the larger record allowance to one-record durable streams and preserves failed snapshots", async () => {
  const h = await create({ listener: false });
  for (const definition of [
    { name: "snapshot", durability: "durable", max_records: 1 },
    { name: "history", durability: "durable", max_records: 2 },
    { name: "live", durability: "ephemeral" },
  ]) await apiJson(h, "POST", "streams", definition, 201);
  for (const name of ["history", "live"]) {
    await apiJson(h, "POST", `streams/${name}/records`, { records: [sized("boundary", STREAM_RECORD_BYTES)] });
    const response = await api(h, "POST", `streams/${name}/records`, { records: [sized("over", STREAM_RECORD_BYTES + 1)] });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "too_large", message: "Stream record exceeds 64 KiB" } });
  }
  await apiJson(h, "POST", "streams/snapshot/records", { records: [sized("good", STREAM_SNAPSHOT_RECORD_BYTES)] });
  const before = await apiJson(h, "GET", "streams/snapshot/latest");
  // This string has the same character count as the accepted input, but more UTF-8 bytes.
  const over = sized("wide", STREAM_SNAPSHOT_RECORD_BYTES);
  over.data.rows[0].label = "é" + over.data.rows[0].label.slice(1);
  const rejected = await api(h, "POST", "streams/snapshot/records", { records: [over] });
  expect(rejected.status).toBe(413);
  expect(await rejected.json()).toMatchObject({ error: { code: "too_large", message: "Stream record exceeds 192 KiB" } });
  const batch = await api(h, "POST", "streams/snapshot/records", {
    records: [sized("batch-a", 150 * 1024), sized("batch-b", 150 * 1024)],
  });
  expect(batch.status).toBe(413);
  expect(await apiJson(h, "GET", "streams/snapshot/latest")).toEqual(before);
});

it("keeps the aggregate unclaimed retention budget when storing larger snapshots", async () => {
  const h = await create({ listener: false, claim: false });
  for (let n = 0; n < 6; n++) {
    await apiJson(h, "POST", "streams", { name: `table-${n}`, durability: "durable", max_records: 1 }, 201);
    const response = await api(h, "POST", `streams/table-${n}/records`, { records: [sized(`table-${n}`, STREAM_SNAPSHOT_RECORD_BYTES)] });
    expect(response.status).toBe(n < 5 ? 200 : 413);
    if (n === 5) expect(await response.json()).toMatchObject({ error: { code: "quota" } });
  }
  expect(await apiJson(h, "GET", "streams/table-5/latest")).toMatchObject({ record: null, cursor: 0 });
  expect(await inDO(h.id, t => t.db.one<{ bytes: number }>("SELECT SUM(bytes) AS bytes FROM stream_records")!.bytes)).toBeLessThan(1024 * 1024);
});
