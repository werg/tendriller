import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createClient } from "../../contract/client.mjs";
import { trimStream } from "../src/streams/store";
import { api, apiJson, create, inDO, req } from "./helpers";

const record = (id: string) => ({ id, type: "sample", data: { id } });

it("trims only an observed prefix, retaining newer data, policy, producer grants and high-water cursors", async () => {
  const h = await create({ listener: false });
  const client = createClient(h, { fetch: (input, init) => req(String(input), init) });
  const policy = await client.streams.create({ name: "metrics", durability: "durable", max_records: 10 });
  await client.streams.append("metrics", { records: [record("bad-1"), record("bad-2")] });
  const { cursor: through } = await client.streams.latest("metrics");
  const producer = await client.producers.create({ name: "collector", streams: ["metrics"] });
  await api(h, "POST", "streams/metrics/records", { records: [record("good")] }, {}, producer.token);
  const rates = await inDO(h.id, t => t.db.all("SELECT * FROM stream_rate ORDER BY principal"));
  expect(await client.streams.trim("metrics", { through })).toEqual({ stream: "metrics", through: 2, deleted_records: 2, cursor: 3 });
  expect(await client.streams.trim("metrics", { through })).toEqual({ stream: "metrics", through: 2, deleted_records: 0, cursor: 3 });
  expect(await inDO(h.id, t => t.db.all("SELECT * FROM stream_rate ORDER BY principal"))).toEqual(rates);
  expect(await client.streams.info("metrics")).toEqual(policy);
  expect((await client.producers.list()).producers[0].name).toBe("collector");
  const replay = await client.streams.read("metrics", { after: 0 });
  expect(replay.records.map(r => r.id)).toEqual(["good"]);
  expect(replay.history).toEqual({ earliest_available_seq: 3, latest_seq: 3, gap: true, missing_through: 2 });
  expect((await client.streams.read("metrics", { after: through })).history.gap).toBe(false);
  expect((await client.streams.latest("metrics")).record?.seq).toBe(3);
  await client.streams.trim("metrics", { through: 3 });
  expect(await client.streams.latest("metrics")).toMatchObject({ record: null, cursor: 3 });
  expect((await client.streams.read("metrics", { after: 0 })).history).toMatchObject({ gap: true, missing_through: 3, latest_seq: 3 });
  // Dedupe belongs to retained data: replaying a removed ID is a fresh append.
  const fresh = await client.streams.append("metrics", { records: [record("bad-1")] });
  expect(fresh.records[0].seq).toBe(4);
});

it("requires a valid bound, rolls back atomically, and leaves other streams intact", async () => {
  const h = await create({ listener: false });
  for (const name of ["metrics", "other"])
    await apiJson(h, "POST", "streams", { name, durability: "durable" }, 201);
  for (const name of ["metrics", "other"])
    await apiJson(h, "POST", `streams/${name}/records`, { records: [record("first")] });
  for (const query of ["", "?through=", "?through=-1", "?through=1.5", "?through=NaN", "?through=9007199254740992", "?through=2"])
    expect((await api(h, "DELETE", `streams/metrics/records${query}`)).status).toBe(400);
  expect(await apiJson(h, "DELETE", "streams/metrics/records?through=0")).toMatchObject({ deleted_records: 0, cursor: 1 });
  await inDO(h.id, t => {
    expect(() => t.transaction(() => { trimStream(t, "metrics", 1); throw Error("rollback"); })).toThrow("rollback");
  });
  expect((await apiJson(h, "GET", "streams/metrics/records?after=0")).records).toHaveLength(1);
  await apiJson(h, "DELETE", "streams/metrics/records?through=1");
  expect((await apiJson(h, "GET", "streams/other/records?after=0")).records).toHaveLength(1);
});

it("restricts trimming to agents and custom durable streams, honoring the service write gate", async () => {
  const h = await create({ listener: false });
  await apiJson(h, "POST", "streams", { name: "metrics", durability: "durable", readers: "page" }, 201);
  await apiJson(h, "POST", "streams", { name: "live", durability: "ephemeral" }, 201);
  const producer = await apiJson(h, "POST", "producers", { name: "collector", streams: ["metrics"] }, 201);
  expect((await api(h, "DELETE", "streams/metrics/records?through=0", undefined, {}, producer.token)).status).toBe(403);
  expect((await req(h.page_url + "_tendril/streams/metrics/records?through=0", { method: "DELETE" })).status).toBe(403);
  const link = await inDO(h.id, t => t.createLink("display", "Display", null));
  const display = new URL(`/s/${link.key}/_tendril/streams/metrics/records?through=0`, h.page_url);
  expect((await req(String(display), { method: "DELETE", headers: { Origin: display.origin, Cookie: "" } })).status).toBe(403);
  expect(await (await api(h, "DELETE", "streams/system.events/records?through=0")).json()).toMatchObject({ error: { code: "readonly_stream" } });
  expect(await (await api(h, "DELETE", "streams/live/records?through=0")).json()).toMatchObject({ error: { code: "not_replayable" } });
  expect((await api(h, "DELETE", "streams/missing/records?through=0")).status).toBe(404);
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
  try { expect((await api(h, "DELETE", "streams/metrics/records?through=0")).status).toBe(503); }
  finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
});

it("exposes the same bounded trim through MCP without acknowledging application events", async () => {
  const h = await create({ listener: false });
  await apiJson(h, "POST", "streams", { name: "metrics", durability: "durable" }, 201);
  await apiJson(h, "POST", "streams/metrics/records", { records: [record("first")] });
  const before = await inDO(h.id, t => t.db.get("agent_cursor", 0));
  const call = (args: unknown) => apiJson(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "trim_stream", arguments: args } });
  expect((await call({ stream: "metrics" })).error.code).toBe(-32602);
  expect((await call({ stream: "metrics", through: 1 })).result.structuredContent)
    .toEqual({ stream: "metrics", through: 1, deleted_records: 1, cursor: 1 });
  expect((await call({ stream: "system.events", through: 0 })).result.isError).toBe(true);
  expect(await inDO(h.id, t => t.db.get("agent_cursor", 0))).toBe(before);
});
