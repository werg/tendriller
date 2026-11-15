import { expect, it } from "vitest";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { schemas } from "../../contract/index.mjs";
import { api, apiJson, create } from "./helpers";

it("MCP exposes stream policy and replay through the same validated HTTP implementation", async () => {
  const h = await create({ mode: "dashboard", listener: false });
  const rpc = (method: string, params: unknown = {}) => apiJson(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method, params });
  const call = (name: string, args: unknown = {}) => rpc("tools/call", { name, arguments: args });
  const listedTools = (await rpc("tools/list")).result;
  expect(() => ListToolsResultSchema.parse(listedTools)).not.toThrow();
  const tools = listedTools.tools;
  expect(tools.find((t: any) => t.name === "create_stream").inputSchema).toEqual({ type: "object", ...schemas.streamCreate });
  expect(tools.find((t: any) => t.name === "create_stream_producer").inputSchema).toEqual(schemas.producerCreate);
  expect(tools.find((t: any) => t.name === "append_stream").inputSchema.$defs).toEqual({ streamJson: schemas.streamJson });

  const stream = await call("create_stream", { name: "training", durability: "durable" });
  expect(stream.result.isError).toBeUndefined();
  expect((await apiJson(h, "GET", "streams/training")).durability).toBe("durable");
  const row = { id: "step-1", type: "metrics", data: { step: 1, loss: 2.4 } };
  const first = (await call("append_stream", { stream: "training", records: [row] })).result.structuredContent;
  const retry = (await call("append_stream", { stream: "training", records: [row] })).result.structuredContent;
  expect(retry.records[0].seq).toBe(first.records[0].seq);
  const replay = (await call("read_stream", { stream: "training", after: 0 })).result.structuredContent;
  expect(replay.records).toHaveLength(1);
  expect(replay.records[0].data).toEqual(row.data);
  expect(replay.history.gap).toBe(false);

  expect((await call("read_stream", { stream: "training" })).error.code).toBe(-32602);
  const invalidPolicy = await call("create_stream", { name: "live", durability: "ephemeral", max_records: 10 });
  expect(invalidPolicy.result?.isError ?? invalidPolicy.error?.code).toBeTruthy();
  await call("create_stream", { name: "live", durability: "ephemeral" });
  expect((await call("read_stream", { stream: "live", after: 0 })).result.isError).toBe(true);
  expect((await call("append_stream", { stream: "system.events", records: [row] })).result.isError).toBe(true);
});

it("MCP-issued producer tokens can publish only their granted streams and revoke independently", async () => {
  const h = await create({ mode: "dashboard", listener: false });
  const call = (name: string, args: unknown = {}) => apiJson(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  await call("create_stream", { name: "gpu", durability: "durable" });
  const issued = (await call("create_stream_producer", { name: "host", streams: ["gpu"] })).result.structuredContent;
  expect(issued.token).toMatch(/^tp_/);
  const body = { records: [{ id: "sample-1", type: "utilization", data: { percent: 91 } }] };
  expect((await api(h, "POST", "streams/gpu/records", body, {}, issued.token)).ok).toBe(true);
  expect((await api(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, issued.token)).status).toBe(401);
  const listed = (await call("list_stream_producers")).result.structuredContent;
  expect(JSON.stringify(listed)).not.toContain(issued.token);
  await call("revoke_stream_producer", { name: "host" });
  expect((await api(h, "POST", "streams/gpu/records", body, {}, issued.token)).status).toBe(401);
});
