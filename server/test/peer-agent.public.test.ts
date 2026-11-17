import { expect, it } from "vitest";
import { api, apiJson, create, inDO, publishFilesJson, req, type Handle } from "./helpers";

it.each(["interactive", "dashboard"])("directs the initial %s peer agent to its selected backend", async mode => {
  const h = await create({ application: { kind: "peer", id: "peer-history" }, listener: false, mode }) as Handle & {
    agent_setup: { event_delivery: string; backend: string; next_step: string };
  };
  expect(h.agent_setup).toMatchObject({ event_delivery: "peer", backend: "peer-history" });
  expect(h.agent_setup.next_step).toContain("Chronolog client");
  expect(h.agent_setup.next_step).toContain("client.signals");
  for (const hosted of ["events/socket", "wake/probe", "MCP Events", "stream subscriptions", "scoped producers"])
    expect(h.agent_setup.next_step).not.toContain(hosted);
});

it("rejects hosted agent wake sockets and tickets for peer pages while retaining explicit host operations", async () => {
  const h = await create({ application: { kind: "peer", id: "peer-history" }, listener: false, mode: "dashboard" });
  const socket = await api(h, "GET", "events/socket?after=0", undefined, {
    Upgrade: "websocket", "Sec-WebSocket-Protocol": `tendriller.agent.v2, ${h.token}`,
  });
  expect(socket.status).toBe(409);
  expect(await socket.json()).toMatchObject({ error: { code: "application_backend" } });
  const ticket = await api(h, "POST", "events/socket/ticket?after=0");
  expect(ticket.status).toBe(409);
  expect(await ticket.json()).toMatchObject({ error: { code: "application_backend" } });
  expect(await inDO(h.id, t => ({ sockets: t.ctx.getWebSockets().length,
    tickets: t.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM socket_tickets")!.count })))
    .toEqual({ sockets: 0, tickets: 0 });
  for (const path of ["publications", "members", "logs", "peers/bootstrap"])
    expect((await api(h, "GET", path)).status, path).toBe(200);
});

it("publishes an interactive peer page without hosted agent delivery", async () => {
  const h = await create({ application: { kind: "peer", id: "peer-history" }, listener: false, mode: "interactive" });
  const receipt = await publishFilesJson(h, { "index.html": "<h1>Peer application</h1>" });
  expect(receipt).toEqual({ version: 1, head_revision: 1 });
  expect(await (await req(h.page_url)).text()).toContain("<h1>Peer application</h1>");
  expect(await inDO(h.id, t => ({ sockets: t.ctx.getWebSockets().length, webhook: t.presenceFacts().webhook,
    tickets: t.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM socket_tickets")!.count })))
    .toEqual({ sockets: 0, webhook: false, tickets: 0 });
});

it("guides peer agents to their selected backend and exposes only host tools", async () => {
  const h = await create({ application: { kind: "peer", id: "peer-history" }, listener: false, mode: "dashboard" });
  const rpc = (method: string, params: unknown = {}) => apiJson(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method, params });
  const initial = (await rpc("initialize")).result;
  expect(initial.capabilities).toEqual({ tools: {} });
  expect(initial.instructions).toContain("client.signals");
  expect(initial.instructions).toMatch(/Chronolog.*local and final views/);
  expect(initial.instructions).toMatch(/local\(\).*final\(\).*accepted or rejected outcomes/);
  expect(initial.instructions).toContain("select local previews explicitly");
  expect(initial.instructions).toMatch(/application\.changes.*coherent readView.*release/);
  expect(initial.instructions).toContain("agent's own application session");
  expect(initial.instructions).toContain("this host has no application event queue or wake subscription");
  expect(initial.instructions).not.toContain("Read stored events immediately with read_events");
  const names = (await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name);
  expect(names).toContain("publish_publication"); expect(names).toContain("tendril_info");
  expect(names).toContain("discover_peers"); expect(names).toContain("peer_application");
  expect(names).toContain("peer_definition");
  expect(names).toContain("select_peer_generation");
  expect(names).toContain("administer_peer_generation");
  for (const name of ["read_events", "say", "get_state", "create_timer", "append_stream", "claim_event_consumer", "probe_delivery", "write_shared_file", "delete_shared_file"])
    expect(names).not.toContain(name);
  expect((await rpc("tools/call", { name: "read_events" })).error.code).toBe(-32602);
  expect((await rpc("events/list")).result.events).toEqual([]);
  expect((await rpc("events/subscribe", { name: "tendril.events_waiting" })).error.code).toBe(-32601);
  expect((await apiJson(h, "GET", "")).agent_delivery).toMatchObject({ mode: "peer", backend: "peer-history", live_listener: false });
  expect((await api(h, "GET", "file-refs/snapshot")).status).toBe(409);
  expect((await api(h, "PUT", "file-refs", {})).status).toBe(409);
});
