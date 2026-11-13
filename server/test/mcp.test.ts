import { afterEach, describe, expect, it, vi } from "vitest";
import { advance, api, apiJson, create, inDO, PageClient, req, runAlarm } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;

async function rpc(h: { api: string; token: string }, method: string, params: unknown = {}, path = "mcp") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (path === "mcp") headers.Authorization = `Bearer ${h.token}`;
  const res = await req(`${h.api}/${path}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await res.json()) as any;
}

/** Fake receiver: echoes verification challenges, records deliveries, answers with `statuses`. */
function receiver(statuses: number[] = []) {
  const deliveries: { headers: Record<string, string>; body: any }[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://hook.example/")) return real(input, init);
    const body = JSON.parse(init.body);
    if (body.type === "verification") return Response.json({ challenge: body.challenge });
    deliveries.push({ headers: init.headers, body });
    return new Response("ok", { status: statuses.length ? statuses.shift()! : 200 });
  });
  return deliveries;
}

async function subscribe(h: { api: string; token: string }, url = "https://hook.example/cb") {
  return rpc(h, "events/subscribe", {
    name: "tendril.events_waiting",
    arguments: {},
    delivery: { mode: "webhook", url, secret: SECRET },
  });
}

describe("MCP connector", () => {
  it("initializes with tools and events, by header or capability URL", async () => {
    const h = await create();
    const init = await rpc(h, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {}, events: {} } });
    expect((await rpc(h, "tools/list", {}, `mcp/${h.token}`)).result.tools.map((t: any) => t.name)).toContain("read_events");
    expect((await rpc(h, "events/list")).result.events[0].name).toBe("tendril.events_waiting");
    const denied = await req(`${h.api}/mcp`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    expect((await api(h, "GET", "mcp")).status).toBe(405);
  });

  it("tools call the agent API", async () => {
    const h = await create({ name: "Kitchen" });
    const page = await PageClient.connect(h.page_url);
    await page.request({ t: "send", data: { timer: "done" } });
    const info = await rpc(h, "tools/call", { name: "tendril_info", arguments: {} });
    expect(info.result.structuredContent.name).toBe("Kitchen");
    const events = await rpc(h, "tools/call", { name: "read_events", arguments: {} });
    expect(events.result.structuredContent.events.some((e: any) => e.data?.timer === "done")).toBe(true);
    const again = await rpc(h, "tools/call", { name: "read_events", arguments: {} });
    expect(again.result.structuredContent.events).toEqual([]); // continues after the last read
    const bad = await rpc(h, "tools/call", { name: "rollback", arguments: { version: 99 } });
    expect(bad.result.isError).toBe(true);
    page.close();
  });

  it("subscribes after verifying the callback and pushes a signed count on a wake", async () => {
    const deliveries = receiver();
    const h = await create({ name: "Trip" });
    const page = await PageClient.connect(h.page_url);
    await apiJson(h, "GET", "events");
    const sub = await subscribe(h);
    expect(sub.result).toMatchObject({ id: expect.stringMatching(/^sub_/), cursor: null, truncated: false });
    expect((await subscribe(h)).result.id).toBe(sub.result.id); // idempotent

    await page.request({ t: "send", data: { hungry: true } });
    await advance(h.id, 2500);
    await runAlarm(h.id);
    expect(deliveries).toHaveLength(1);
    const d = deliveries[0];
    expect(d.body).toMatchObject({ name: "tendril.events_waiting", data: { tendril_id: h.id, name: "Trip", waiting: 1 } });
    expect(JSON.stringify(d.body)).not.toContain("hungry"); // a count, never content
    expect(d.headers["X-MCP-Subscription-Id"]).toBe(sub.result.id);
    expect(d.headers["webhook-id"]).toBe(d.body.eventId);
    expect(d.headers["webhook-signature"]).toMatch(/^v1,/);
    page.close();
  });

  it("rejects bad callbacks and secrets, and a failed challenge", async () => {
    const h = await create();
    for (const url of ["http://hook.example/cb", "https://10.0.0.5/cb", "https://192.168.1.4/cb"]) {
      const r = await rpc(h, "events/subscribe", { name: "tendril.events_waiting", arguments: {}, delivery: { mode: "webhook", url, secret: SECRET } });
      expect(r.error.code).toBe(-32602);
    }
    const weak = await rpc(h, "events/subscribe", { name: "tendril.events_waiting", arguments: {}, delivery: { mode: "webhook", url: "https://hook.example/cb", secret: "whsec_YQ==" } });
    expect(weak.error.code).toBe(-32602);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ challenge: "wrong" }));
    const failed = await subscribe(h);
    expect(failed.error).toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
  });

  it("drops a subscription the receiver answers 410 to, and unsubscribes", async () => {
    receiver([410]);
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    await apiJson(h, "GET", "events");
    await subscribe(h);
    await page.request({ t: "send", data: {} });
    await advance(h.id, 2500);
    await runAlarm(h.id);
    expect(await inDO(h.id, (t) => t.db.get("mcp_subs", null))).toBeNull();
    await subscribe(h);
    expect((await rpc(h, "events/unsubscribe", { name: "tendril.events_waiting", arguments: {}, delivery: { mode: "webhook", url: "https://hook.example/cb" } })).result).toEqual({});
    expect(await inDO(h.id, (t) => t.db.get("mcp_subs", null))).toBeNull();
    page.close();
  });
});
