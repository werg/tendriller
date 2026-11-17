import { expect, it } from "vitest";
import { api, apiJson, create } from "./helpers";

it("guides peer agents to their selected backend and exposes only host tools", async () => {
  const h = await create({ application: { kind: "peer", id: "peer-history" }, listener: false, mode: "dashboard" });
  const rpc = (method: string, params: unknown = {}) => apiJson(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method, params });
  const initial = (await rpc("initialize")).result;
  expect(initial.capabilities).toEqual({ tools: {} });
  expect(initial.instructions).toContain("client.signals");
  expect(initial.instructions).toContain("provisional outcome may change");
  expect(initial.instructions).not.toContain("Read stored events immediately with read_events");
  const names = (await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name);
  expect(names).toContain("publish_publication"); expect(names).toContain("tendril_info");
  for (const name of ["read_events", "say", "get_state", "create_timer", "append_stream", "claim_event_consumer", "probe_delivery", "write_shared_file", "delete_shared_file"])
    expect(names).not.toContain(name);
  expect((await rpc("tools/call", { name: "read_events" })).error.code).toBe(-32602);
  expect((await rpc("events/list")).result.events).toEqual([]);
  expect((await rpc("events/subscribe", { name: "tendril.events_waiting" })).error.code).toBe(-32601);
  expect((await apiJson(h, "GET", "")).agent_delivery).toMatchObject({ mode: "peer", backend: "peer-history", live_listener: false });
  expect((await api(h, "GET", "file-refs/snapshot")).status).toBe(409);
  expect((await api(h, "PUT", "file-refs", {})).status).toBe(409);
});
