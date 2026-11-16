import { afterEach, describe, expect, it, vi } from "vitest";
import { advance, api, apiJson, publishFilesJson, create, inDO, PageClient, req, runAlarm, sleep } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(body: Record<string, unknown> = {}) {
  const h = await create(body);
  const page = await PageClient.connect(h.page_url);
  return { h, page };
}

describe("events and long-poll", () => {
  it("agent socket listens without a held poll and receives only wake-eligible events", async () => {
    const h = await create();
    const denied = await req(h.api + "/events/socket", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "tendriller.agent.v2" } });
    expect(denied.status).toBe(401);
    const res = await req(h.api + "/events/socket", { headers: {
      Upgrade: "websocket", "Sec-WebSocket-Protocol": `tendriller.agent.v2, ${h.token}`,
    } });
    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("tendriller.agent.v2");
    const ws = res.webSocket!;
    ws.accept();
    const notices: any[] = [];
    ws.addEventListener("message", (e) => notices.push(JSON.parse(String(e.data))));
    expect((await apiJson(h, "GET", "")).agent_delivery.mode).toBe("live_socket");
    const page = await PageClient.connect(h.page_url);
    await page.request({ t: "send", expected_generations: {}, data: { passive: true }, wake: false });
    await sleep(100);
    expect(notices).toEqual([]);
    await page.request({ t: "send", expected_generations: {}, data: { tapped: true } });
    for (let i = 0; i < 40 && !notices.length; i++) await sleep(25);
    expect(notices).toMatchObject([{ t: "wake", seq: expect.any(Number) }]);
    const events = await apiJson(h, "GET", "events");
    expect(events.events.some((e: any) => e.data?.passive && !e.wake)).toBe(true);
    expect(events.events.some((e: any) => e.data?.tapped && e.wake)).toBe(true);
    expect((await api(h, "DELETE", "tokens/main")).status).toBe(204);
    for (let i = 0; i < 40 && ws.readyState !== WebSocket.CLOSED; i++) await sleep(25);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    page.close();
  });

  it("wait>0 returns immediately when a wake event is already queued", async () => {
    const { h, page } = await setup();
    await page.request({ t: "send", expected_generations: {}, data: { hi: 1 } });
    const t0 = Date.now();
    const r = await apiJson(h, "GET", "events?wait=10");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.events.some((e: any) => e.type === "event" && e.wake)).toBe(true);
    page.close();
  });

  it("accepts a five-minute wait and rejects longer waits", async () => {
    const { h, page } = await setup();
    await page.request({ t: "send", expected_generations: {}, data: { ready: true } });
    const accepted = await api(h, "GET", "events?wait=300");
    expect(accepted.status).toBe(200);
    expect((await accepted.json() as any).events.some((e: any) => e.data?.ready)).toBe(true);
    const rejected = await api(h, "GET", "events?wait=301");
    expect(rejected.status).toBe(400);
    page.close();
  });

  it("holds a long-poll and releases it on a wake event (after a debounce)", async () => {
    const { h, page } = await setup();
    const { cursor } = await apiJson(h, "GET", "events");
    const t0 = Date.now();
    const pending = apiJson(h, "GET", `events?after=${cursor}&wait=10`);
    await sleep(300);
    // listening while held
    const pres = await page.next((m) => m.t === "presence" && m.state === "listening" && m.wake === "long_poll");
    expect(pres.wake).toBe("long_poll");
    await page.request({ t: "send", expected_generations: {}, data: { nowake: true }, wake: false });
    await page.request({ t: "send", expected_generations: {}, data: { go: 1 } });
    const r = await pending;
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(500);
    expect(dt).toBeLessThan(5000);
    expect(r.timeout).toBeUndefined();
    expect(r.events.map((e: any) => e.data)).toEqual([{ nowake: true }, { go: 1 }]);
    page.close();
  });


  it("limit caps the batch", async () => {
    const { h, page } = await setup();
    for (let i = 0; i < 5; i++) await page.request({ t: "send", expected_generations: {}, data: { i }, wake: false });
    const r = await apiJson(h, "GET", "events?limit=2");
    expect(r.events).toHaveLength(2);
    expect(r.cursor).toBe(r.events[1].seq);
    page.close();
  });


  it("rejects oversized event data", async () => {
    const { page } = await setup();
    const a = await page.request({ t: "send", expected_generations: {}, data: "x".repeat(70_000) });
    expect(a.error).toBe("too_large");
    page.close();
  });
});

describe("page-wake cap", () => {
  it("merges bursts, caps consecutive page wakes, and keeps withheld events", async () => {
    const { h, page } = await setup();
    await apiJson(h, "PUT", "wake", { budget: { page_streak: 2 } });
    const send = (i: number) => page.request({ t: "send", expected_generations: {}, data: { i } });
    await send(1); // page wake #1
    await send(2); // within 3 s: merged, not counted
    await advance(h.id, 4000);
    await send(3); // page wake #2
    await advance(h.id, 4000);
    await send(4); // third in a row: withheld
    const pres = await page.next((m) => m.t === "presence" && m.withheld === 1);
    expect(pres.withheld).toBe(1);
    await advance(h.id, 4000);
    await send(5); // withheld
    const wake = await apiJson(h, "GET", "wake");
    expect(wake.withheld).toBe(2);
    expect(wake.page_streak).toBe(2);
    const r = await apiJson(h, "GET", "events");
    const ev = r.events.filter((e: any) => e.type === "event");
    expect(ev.map((e: any) => [e.data.i, e.wake, e.withheld])).toEqual([
      [1, true, false],
      [2, true, false],
      [3, true, false],
      [4, false, true],
      [5, false, true],
    ]);
    expect(r.withheld).toBe(2);
    expect((await apiJson(h, "GET", "wake")).withheld).toBe(0);
    // withheld events do not release a long-poll
    const lp = await apiJson(h, "GET", `events?after=${r.cursor}&wait=1`);
    expect(lp.timeout).toBe(true);
    // no clock frees the cap: a day later the page still cannot wake the agent on its own
    await advance(h.id, 86_400_000);
    await send(6);
    const r2 = await apiJson(h, "GET", `events?after=${r.cursor}`);
    expect(r2.events.find((e: any) => e.data?.i === 6)).toMatchObject({ wake: false, withheld: true });
    page.close();
  });

  it("human input resets the streak: owner instructions and gesture events", async () => {
    const { h, page } = await setup();
    await apiJson(h, "PUT", "wake", { budget: { page_streak: 1 } });
    await page.request({ t: "send", expected_generations: {}, data: { i: 1 } }); // page wake, streak 1
    await advance(h.id, 4000);
    await page.request({ t: "send", expected_generations: {}, data: { i: 2 } }); // withheld
    await advance(h.id, 4000);
    await page.request({ t: "send", expected_generations: {}, data: { i: 3 }, gesture: true }); // a real tap: wakes, resets
    await advance(h.id, 4000);
    await page.request({ t: "send", expected_generations: {}, data: { i: 4 } }); // page wake again, streak 1
    await advance(h.id, 4000);
    await page.request({ t: "send", expected_generations: {}, data: { i: 5 } }); // withheld
    await advance(h.id, 4000);
    await page.request({ t: "send", expected_generations: {}, kind: "instruction", text: "go on", via: "text" }); // owner: wakes, resets
    await advance(h.id, 4000);
    await page.request({ t: "send", expected_generations: {}, data: { i: 6 } }); // page wake
    const r = await apiJson(h, "GET", "events");
    const byI = (i: number) => r.events.find((e: any) => e.data?.i === i);
    expect([1, 2, 3, 4, 5, 6].map((i) => byI(i).withheld)).toEqual([false, true, false, false, true, false]);
    expect(r.events.find((e: any) => e.type === "instruction")).toMatchObject({ wake: true, withheld: false });
    page.close();
  });

  it("owner instructions are never withheld, even with the page cap at 0", async () => {
    const { h, page } = await setup();
    await apiJson(h, "PUT", "wake", { budget: { page_streak: 0 } });
    for (const text of ["one", "two", "three"]) {
      await page.request({ t: "send", expected_generations: {}, kind: "instruction", text, via: "text" });
      await advance(h.id, 4000);
    }
    await page.request({ t: "send", expected_generations: {}, data: {} });
    const r = await apiJson(h, "GET", "events");
    expect(r.events.filter((e: any) => e.type === "instruction").every((e: any) => e.wake && !e.withheld)).toBe(true);
    expect(r.withheld).toBe(1);
    page.close();
  });


  it("version_failed wakes regardless of the cap", async () => {
    const { h, page } = await setup();
    await apiJson(h, "PUT", "wake", { budget: { page_streak: 0 } });
    await publishFilesJson(h, { "index.html": "<p>x</p>" });
    page.send({ t: "health", version: 1, visible: true, ok: false, errors: ["e"] });
    await page.request({ t: "versions" });
    const r = await apiJson(h, "GET", "events");
    expect(r.events.find((e: any) => e.type === "version_failed")).toMatchObject({ wake: true, withheld: false });
    page.close();
  });

  it("owner can lower but not raise the cap from the page", async () => {
    const { h, page } = await setup();
    expect((await page.request({ t: "budget", page_streak: 50 })).budget).toEqual({ page_streak: 6 });
    const a = await page.request({ t: "budget", page_streak: 3 });
    expect(a.budget).toEqual({ page_streak: 3 });
    expect((await apiJson(h, "GET", "wake")).budget).toEqual({ page_streak: 3 });
    page.close();
  });
});

describe("webhook delivery", () => {
  function mockFetch(statuses: number[]) {
    const calls: { url: string; init: any; body: any }[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith("https://hook.example/")) return real(input, init);
      calls.push({ url, init, body: JSON.parse(init.body) });
      const status = statuses.length ? statuses.shift()! : 200;
      if (status === 0) throw new Error("network down");
      return new Response("ok", { status });
    });
    return calls;
  }


  it("retries failures with backoff 30 s, 2 min, 10 min, then gives up", async () => {
    const calls = mockFetch([500, 0, 503, 500]);
    const { h, page } = await setup();
    await apiJson(h, "PUT", "wake", { webhook: { url: "https://hook.example/x" } });
    await page.request({ t: "send", expected_generations: {}, data: {} });
    await advance(h.id, 2500);
    await runAlarm(h.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    await advance(h.id, 10_000);
    await runAlarm(h.id);
    expect(calls).toHaveLength(1); // not yet: 30 s backoff
    for (const step of [25_000, 120_000, 600_000]) {
      await advance(h.id, step);
      await runAlarm(h.id);
    }
    expect(calls).toHaveLength(4);
    await advance(h.id, 3600_000);
    await runAlarm(h.id);
    expect(calls).toHaveLength(4);
    const act = await apiJson(h, "GET", "activity");
    expect(act.entries.some((e: any) => e.kind === "webhook_failed")).toBe(true);
    page.close();
  });

  it("is skipped when the agent read the events before it fired", async () => {
    const calls = mockFetch([200]);
    const { h, page } = await setup();
    await apiJson(h, "PUT", "wake", { webhook: { url: "https://hook.example/x" } });
    await page.request({ t: "send", expected_generations: {}, data: {} });
    await apiJson(h, "GET", "events");
    await advance(h.id, 2500);
    await runAlarm(h.id);
    expect(calls).toHaveLength(0);
    page.close();
  });

  it("not delivered when a long-poll is held", async () => {
    const calls = mockFetch([200]);
    const { h, page } = await setup();
    await apiJson(h, "PUT", "wake", { webhook: { url: "https://hook.example/x" } });
    const { cursor } = await apiJson(h, "GET", "events");
    const lp = apiJson(h, "GET", `events?after=${cursor}&wait=5`);
    await sleep(200);
    await page.request({ t: "send", expected_generations: {}, data: { x: 1 } });
    const r = await lp;
    expect(r.events).toHaveLength(1);
    expect(await inDO(h.id, (t) => t.db.get("webhook_job", null))).toBeNull();
    expect(calls).toHaveLength(0);
    page.close();
  });
});

describe("presence", () => {



  it("status overrides the label until the next long-poll or 10 minutes", async () => {
    const { h, page } = await setup();
    const r = await apiJson(h, "POST", "status", { text: "Building the map", state: "working" });
    expect(r.presence).toMatchObject({ state: "working", text: "Building the map" });
    await advance(h.id, 5 * 60_000);
    expect((await inDO(h.id, (t) => t.presence())).text).toBe("Building the map");
    const done = await apiJson(h, "POST", "status", { text: "All set", state: "done" });
    expect(done.presence.text).toBe("All set");
    await apiJson(h, "GET", "events?wait=1");
    const after = await inDO(h.id, (t) => t.presence());
    expect(after.text).not.toBe("All set");
    page.close();
  });
});
