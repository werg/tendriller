import { expect, it } from "vitest";
import { assertValid } from "../../contract/index.mjs";
import { createClient } from "../../contract/client.mjs";
import { addEvent } from "../src/events";
import { api, apiJson, advance, create, inDO, req } from "./helpers";

it("reads a whole latest snapshot, retaining the high-water cursor across empty and expired data", async () => {
  const h = await create({ listener: false });
  const client = createClient(h, { fetch: (input, init) => req(String(input), init) });
  await client.streams.create({ name: "processes", durability: "durable", max_records: 1, max_age_seconds: 60 });
  expect(await client.streams.latest("processes")).toEqual({ stream: "processes", durability: "durable", record: null, cursor: 0 });
  const body = { records: [{ id: "a", type: "snapshot", data: { rows: [{ pid: 1 }, { pid: 2 }] } },
    { id: "b", type: "snapshot", data: { rows: [{ pid: 2 }] } }] };
  const appended = await client.streams.append("processes", body);
  const latest = await client.streams.latest("processes");
  assertValid("streamLatest", latest);
  expect(latest.record).toEqual(appended.records[1]);
  expect(latest.cursor).toBe(2);
  expect((await client.streams.read("processes", { after: 0 })).records).toHaveLength(1);
  const pageRead = await (await req(h.page_url + "_tendril/streams/processes/latest")).json();
  expect(pageRead).toEqual(latest);
  const mcp = await apiJson(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "latest_stream", arguments: { stream: "processes" } } });
  expect(mcp.result.structuredContent).toEqual(latest);
  await advance(h.id, 61000);
  expect(await client.streams.latest("processes")).toEqual({ stream: "processes", durability: "durable", record: null, cursor: 2 });
  await client.streams.append("processes", { records: [{ id: "c", type: "snapshot", data: { rows: [] } }] });
  expect((await client.streams.read("processes", { after: latest.cursor })).records[0].seq).toBe(3);
});

it("keeps latest reads authorized, non-acknowledging, and explicit about ephemeral streams", async () => {
  const h = await create({ listener: false });
  await apiJson(h, "POST", "streams", { name: "private", durability: "durable" }, 201);
  await apiJson(h, "POST", "streams", { name: "shared", durability: "durable", readers: "page" }, 201);
  await apiJson(h, "POST", "streams", { name: "live", durability: "ephemeral" }, 201);
  const producer = await apiJson(h, "POST", "producers", { name: "host", streams: ["private"] }, 201);
  expect((await api(h, "GET", "streams/private/latest", undefined, {}, producer.token)).status).toBe(403);
  const link = await inDO(h.id, t => t.createLink("display", "Display", null));
  const url = new URL(h.page_url); url.pathname = `/s/${link.key}/`;
  const headers = { Origin: url.origin, Cookie: "" };
  expect((await req(url + "_tendril/streams/private/latest", { headers })).status).toBe(403);
  expect((await req(url + "_tendril/streams/system.events/latest", { headers })).status).toBe(403);
  expect((await req(url + "_tendril/streams/shared/latest", { headers })).status).toBe(200);
  expect(await (await api(h, "GET", "streams/live/latest")).json()).toMatchObject({ error: { code: "not_replayable" } });
  expect((await api(h, "GET", "streams/missing/latest")).status).toBe(404);
  expect((await api(h, "POST", "streams/private/latest", {})).status).toBe(405);
  const before = await inDO(h.id, t => {
    addEvent(t, { type: "event", data: { input: "unhandled" }, wake: false });
    return t.db.get("agent_cursor", 0);
  });
  const latest = await apiJson(h, "GET", "streams/system.events/latest");
  expect(latest.record.data.data).toEqual({ input: "unhandled" });
  expect(await inDO(h.id, t => t.db.get("agent_cursor", 0))).toBe(before);
});
