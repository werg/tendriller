import { describe, expect, it } from "vitest";
import { api, apiJson, create, inDO, PageClient, req, sleep } from "./helpers";

describe("eval relay", () => {
  it("relays code to the primary device and returns the value", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    page.onEval = (code) => (code === "return document.title" ? "My page" : null);
    const r = await apiJson(h, "POST", "eval", { code: "return document.title" });
    expect(r).toEqual({ ok: true, value: "My page", device: page.deviceId });
    page.close();
  });

  it("returns page errors as ok:false", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    page.onEval = () => {
      throw new Error("x is not defined");
    };
    const r = await apiJson(h, "POST", "eval", { code: "return x" });
    expect(r).toEqual({ ok: false, error: "x is not defined", device: page.deviceId });
    page.close();
  });

  it("all fills results and mirrors the first; specific device targeting", async () => {
    const h = await create();
    const a = await PageClient.connect(h.page_url);
    const b = await PageClient.connect(h.page_url);
    a.onEval = () => "A";
    b.onEval = () => "B";
    const r = await apiJson(h, "POST", "eval", { code: "1", device: "all" });
    expect(r.results).toHaveLength(2);
    expect(r.results.map((x: any) => x.value).sort()).toEqual(["A", "B"]);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(r.results[0].value);
    const rb = await apiJson(h, "POST", "eval", { code: "1", device: b.deviceId });
    expect(rb).toEqual({ ok: true, value: "B", device: b.deviceId });
    a.close();
    b.close();
  });


  it("times out with 504 and reports offline with 409", async () => {
    const h = await create();
    const off = await api(h, "POST", "eval", { code: "1" });
    expect(off.status).toBe(409);
    const body = await off.json<any>();
    expect(body.error).toMatchObject({ code: "offline", last_seen: null });
    expect(body.error.message).toBe("No device has opened the page yet");

    const page = await PageClient.connect(h.page_url); // never answers
    const r = await api(h, "POST", "eval", { code: "1", timeout_ms: 300 });
    expect(r.status).toBe(504);
    expect(await r.json()).toMatchObject({ error: { code: "timeout" } });
    page.close();
    await sleep(100);
    const after = await api(h, "POST", "eval", { code: "1" });
    expect(after.status).toBe(409);
    const ab = await after.json<any>();
    expect(ab.error.last_seen).toEqual(expect.any(Number));

    const unknown = await api(h, "POST", "eval", { code: "1", device: "d_aaaaaaaaaaaaaaaa" });
    expect(unknown.status).toBe(404);
    await unknown.text();
  });

  it("all with one silent device marks it as timed out", async () => {
    const h = await create();
    const a = await PageClient.connect(h.page_url);
    const b = await PageClient.connect(h.page_url);
    a.onEval = () => 1;
    const r = await apiJson(h, "POST", "eval", { code: "1", device: "all", timeout_ms: 300 });
    const byDev = Object.fromEntries(r.results.map((x: any) => [x.device, x]));
    expect(byDev[a.deviceId]).toMatchObject({ ok: true, value: 1 });
    expect(byDev[b.deviceId]).toMatchObject({ ok: false, error: "timeout" });
    a.close();
    b.close();
  });

  it("rejects oversized code", async () => {
    const h = await create();
    const r = await api(h, "POST", "eval", { code: "x".repeat(300 * 1024) });
    expect(r.status).toBe(413);
    await r.text();
  });

  it("check runs an accessibility audit through the page", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    const pending = apiJson(h, "POST", "check", {});
    const msg = await page.next("check");
    page.send({ t: "eval_result", call_id: msg.call_id, ok: true, value: { violations: [{ id: "image-alt", impact: "critical", help: "Images must have alternate text", nodes: [{}, {}] }] } });
    expect(await pending).toEqual({ ok: true, device: page.deviceId, violations: [{ id: "image-alt", impact: "critical", help: "Images must have alternate text", nodes: 2 }] });
    page.close();
  });
});

describe("state", () => {
  it("merge patch becomes leaf ops, is broadcast and survives in GET", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    expect(page.welcome).toMatchObject({ state: {}, rev: 0 });
    expect(await apiJson(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: {}, ops: [{ op: "set", path: ["list"], value: { a1: { text: "milk", done: false } } }, { op: "set", path: ["title"], value: "Shop" }] })).toEqual({ scopes: [], rev: 1 });
    const m1 = await page.next("state");
    expect(m1).toEqual({
      t: "state", scopes: [],
      rev: 1,
      by: "agent:main",
      ops: [
        { op: "set", path: ["list"], value: { a1: { text: "milk", done: false } } },
        { op: "set", path: ["title"], value: "Shop" },
      ],
    });
    expect(await apiJson(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: {}, ops: [{ op: "set", path: ["list", "a1", "done"], value: true }, { op: "set", path: ["list", "a2"], value: { text: "eggs" } }, { op: "delete", path: ["title"] }] })).toEqual({ scopes: [], rev: 2 });
    const m2 = await page.next("state");
    expect(m2.ops).toEqual([
      { op: "set", path: ["list", "a1", "done"], value: true },
      { op: "set", path: ["list", "a2"], value: { text: "eggs" } },
      { op: "delete", path: ["title"] },
    ]);
    expect(await apiJson(h, "GET", "state")).toEqual({ scopes: [], rev: 2, state: { list: { a1: { text: "milk", done: true }, a2: { text: "eggs" } } } });
    page.close();
  });

  it("explicit ops and PUT replace", async () => {
    const h = await create();
    await apiJson(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: {},  ops: [{ op: "set", path: ["a", "b"], value: 1 }, { op: "set", path: ["c"], value: [1, 2] }] });
    await apiJson(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: {},  ops: [{ op: "delete", path: ["a", "b"] }] });
    expect(await apiJson(h, "GET", "state")).toEqual({ scopes: [], rev: 2, state: { a: {}, c: [1, 2] } });
    expect(await apiJson(h, "PUT", "state", { cid: crypto.randomUUID(), expected_generations: {}, state: { x: 1 } })).toEqual({ scopes: [], rev: 3 });
    expect(await apiJson(h, "GET", "state")).toEqual({ scopes: [], rev: 3, state: { x: 1 } });
    const bad = await api(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: {},  ops: [{ op: "frob", path: ["a"] }] });
    expect(bad.status).toBe(400);
    await bad.text();
    const big = await api(h, "PUT", "state", { cid: crypto.randomUUID(), expected_generations: {}, state: { blob: "x".repeat(1_100_000) } });
    expect(big.status).toBe(413);
    await big.text();
  });

  it("page ops are acked, applied LWW and broadcast to other pages with device attribution", async () => {
    const h = await create();
    const a = await PageClient.connect(h.page_url);
    const b = await PageClient.connect(h.page_url);
    const ack = await a.request({ t: "state", expected_generations: {}, ops: [{ op: "set", path: ["n"], value: 1 }] });
    expect(ack).toMatchObject({ t: "ack", rev: 1 });
    const seen = await b.next("state");
    expect(seen).toEqual({ t: "state", scopes: [], ops: [{ op: "set", path: ["n"], value: 1 }], rev: 1, by: `device:${a.deviceId}` });
    await b.request({ t: "state", expected_generations: {}, ops: [{ op: "set", path: ["n"], value: 2 }] });
    expect((await a.next("state")).rev).toBe(2);
    expect(a.messages.filter((m) => m.t === "state")).toHaveLength(0); // a did not get its own op back
    expect((await apiJson(h, "GET", "state")).state).toEqual({ n: 2 });
    a.close();
    b.close();
  });

  it("invalid page ops get an error ack and a state_reset", async () => {
    const h = await create();
    const a = await PageClient.connect(h.page_url);
    const ack = await a.request({ t: "state", expected_generations: {}, ops: [{ op: "set", path: ["__proto__"], value: 1 }] });
    expect(ack.error).toBe("bad_ops");
    expect(await a.next("state_reset")).toEqual({ t: "state_reset", scopes: [], state: {}, rev: 0 });
    a.close();
  });

  it("a page claiming an unknown rev gets state_reset after welcome", async () => {
    const h = await create();
    await apiJson(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: {}, ops: [{ op: "set", path: ["a"], value: 1 }] });
    const page = await PageClient.connect(h.page_url, { rev: 99 });
    expect(page.welcome).toMatchObject({ state: { a: 1 }, rev: 1 });
    expect(await page.next("state_reset")).toEqual({ t: "state_reset", scopes: [], state: { a: 1 }, rev: 1 });
    page.close();
  });
});

describe("dedupe", () => {
  it("resending a cid does not store the event twice and replays the ack", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    page.send({ t: "send", expected_generations: {}, cid: "same-1", data: { v: 1 }, wake: false });
    const a1 = await page.next("ack");
    page.send({ t: "send", expected_generations: {}, cid: "same-1", data: { v: 1 }, wake: false });
    const a2 = await page.next("ack");
    expect(a2).toEqual(a1);
    page.send({ t: "state", expected_generations: {}, cid: "st-1", ops: [{ op: "set", path: ["k"], value: 1 }] });
    const s1 = await page.next("ack");
    page.send({ t: "state", expected_generations: {}, cid: "st-1", ops: [{ op: "set", path: ["k"], value: 1 }] });
    expect(await page.next("ack")).toEqual(s1);
    const r = await apiJson(h, "GET", "events");
    expect(r.events.filter((e: any) => e.type === "event")).toHaveLength(1);
    expect((await apiJson(h, "GET", "state")).rev).toBe(1);
    // the same cid from a different device is a different message
    const other = await PageClient.connect(h.page_url);
    other.send({ t: "send", expected_generations: {}, cid: "same-1", data: { v: 2 }, wake: false });
    await other.next("ack");
    expect((await apiJson(h, "GET", "events")).events.filter((e: any) => e.type === "event")).toHaveLength(2);
    page.close();
    other.close();
  });
});

describe("roles, pairing and devices", () => {
  it("open pairing: every device via the owner link is owner", async () => {
    const h = await create();
    const a = await PageClient.connect(h.page_url);
    const b = await PageClient.connect(h.page_url);
    expect(a.welcome).toMatchObject({ role: "owner", pending: false, primary: true, tendril: { id: h.id, name: "Tendril" } });
    expect(b.welcome.role).toBe("owner");
    expect(a.welcome).toHaveProperty("features");
    expect(a.welcome.budget).toEqual({ page_streak: 6 });
    a.close();
    b.close();
  });




  it("devices list, delete disconnects and forgets", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url, { name: "Phone" });
    const { devices } = await apiJson(h, "GET", "devices");
    expect(devices).toEqual([
      { id: page.deviceId, name: "Phone", role: "owner", pending: false, connected: true, primary: true, last_seen: expect.any(Number), ua: "vitest", link: "l_main", purpose: "general" },
    ]);
    const del = await api(h, "DELETE", `devices/${page.deviceId}`);
    expect(del.status).toBe(204);
    await sleep(50);
    expect(page.closed?.code).toBe(4003);
    expect((await apiJson(h, "GET", "devices")).devices).toEqual([]);
  });

  it("joined/left device events do not wake", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    page.close();
    await sleep(100);
    const evs = (await apiJson(h, "GET", "events")).events.filter((e: any) => e.type === "device");
    expect(evs.map((e: any) => [e.data.action, e.wake])).toEqual([
      ["joined", false],
      ["left", false],
    ]);
  });
});

describe("links", () => {

  it("owner pages can list and create links", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    const r = await page.request({ t: "links", create: { role: "guest", label: "qr" } });
    expect(r.created).toMatchObject({ role: "guest", label: "qr" });
    expect(r.links).toHaveLength(2);
    page.close();
  });
});

describe("say, notify, rules, logs, voice and rule events", () => {
  it("say reaches all devices and the transcript", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    await apiJson(h, "POST", "say", { text: "On it", speak: false });
    expect(await page.next("say")).toMatchObject({ text: "On it", speak: false, ts: expect.any(Number) });
    await page.request({ t: "send", expected_generations: {}, kind: "instruction", text: "thanks", via: "text" });
    const again = await PageClient.connect(h.page_url);
    expect(again.welcome.transcript.map((x: any) => [x.from, x.text])).toEqual([
      ["agent", "On it"],
      ["user", "thanks"],
    ]);
    page.close();
    again.close();
  });

  it("rejects invalid browser subscriptions and sends local fallback to open owner pages", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    const sub = await page.request({ t: "push_subscribe", subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "x", auth: "y" } } });
    expect(sub.error).toBe("push_unavailable");
    const r = await apiJson(h, "POST", "notify", { title: "Decision needed", body: "Approve?" });
    expect(r).toEqual({ sent: 0, failed: 0, deliveries: [] });
    expect(await page.next("notify_local")).toMatchObject({ title: "Decision needed", body: "Approve?" });
    expect(await page.request({ t: "push_unsubscribe" })).toMatchObject({ subscribed: false });
    expect(await apiJson(h, "POST", "notify", { title: "x" })).toEqual({ sent: 0, failed: 0, deliveries: [] });
    page.close();
  });

  it("rules are stored, broadcast and in welcome; rule_fired becomes a waking event", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    const rules = [{ id: "shop", when: { type: "interval", minutes: 5 }, do: [{ type: "event" }] }];
    await apiJson(h, "PUT", "rules", { rules });
    expect(await page.next("rules")).toEqual({ t: "rules", rules });
    expect(await apiJson(h, "GET", "rules")).toEqual({ rules });
    const again = await PageClient.connect(h.page_url);
    expect(again.welcome.rules).toEqual(rules);
    const ack = await page.request({ t: "rule_fired", rule_id: "shop", detail: { at: 1 } });
    expect(ack.seq).toEqual(expect.any(Number));
    const ev = (await apiJson(h, "GET", "events")).events.find((e: any) => e.type === "rule");
    expect(ev).toMatchObject({ data: { rule_id: "shop", detail: { at: 1 } }, wake: true });
    const bad = await api(h, "PUT", "rules", { rules: [{}] });
    expect(bad.status).toBe(400);
    await bad.text();
    page.close();
    again.close();
  });


  it("logs are stored with device and version, newest 2000 kept", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url, { version: 0 });
    page.send({ t: "log", entries: [{ level: "error", message: "boom", stack: "at x", ts: 5 }, { level: "weird", message: "hi", ts: 6 }] });
    await page.request({ t: "versions" });
    const r = await apiJson(h, "GET", "logs");
    expect(r.logs).toEqual([
      { seq: 1, ts: 5, device: page.deviceId, version: null, level: "error", message: "boom", stack: "at x" },
      { seq: 2, ts: 6, device: page.deviceId, version: null, level: "log", message: "hi" },
    ]);
    expect(r.cursor).toBe(2);
    expect((await apiJson(h, "GET", "logs?after=2")).logs).toEqual([]);
    await inDO(h.id, (t) => {
      for (let i = 0; i < 2100; i++) t.db.run("INSERT INTO logs (ts, level, message) VALUES (?, 'log', 'x')", i);
    });
    page.send({ t: "log", entries: [{ level: "log", message: "last" }] });
    await page.request({ t: "versions" });
    expect(await inDO(h.id, (t) => t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM logs")!.n)).toBe(2000);
    page.close();
  });

  it("before hello, other messages are refused; ping gets pong", async () => {
    const h = await create();
    const page = new PageClient(h.page_url);
    await page.open();
    page.send({ t: "ping" });
    expect(await page.next("pong")).toEqual({ t: "pong" });
    page.send({ t: "send", expected_generations: {}, cid: "x", data: {} });
    expect(await page.next("error")).toMatchObject({ code: "not_ready" });
    page.close();
  });
});

describe("message ordering", () => {
  it("a request sent right after hello is answered, not refused as not_ready", async () => {
    const h = await create();
    for (let i = 0; i < 5; i++) {
      const c = new PageClient(h.page_url);
      await c.open();
      // hello and an owner request back to back, without waiting for welcome
      c.send({ t: "hello", device_id: c.deviceId, device_secret: c.secret, ua: "vitest", version: 0, rev: 0, caps: {} });
      c.send({ t: "adopt_code", cid: `a${i}` });
      const m = await c.next((x) => x.cid === `a${i}`);
      expect(m.t).toBe("adopt_code");
      c.close();
    }
  });
});
