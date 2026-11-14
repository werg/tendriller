import { test, expect, type Page } from "@playwright/test";
import { MockServer, type MockTendril } from "./mock-server";

let mock: MockServer;
test.beforeAll(async () => { mock = new MockServer(); await mock.start(); });
test.afterAll(async () => { await mock.stop(); });

async function open(page: Page, t: MockTendril) {
  await page.goto(mock.url(t));
  await page.waitForFunction(() => (window as any).tendril && (window as any).tendril.connected);
}

test("agent replies auto-speak only for approved owners and respect speak:false", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  await page.evaluate(() => {
    const w = window as any;
    w.autoSpeech = [];
    w.tendril.tts.speak = (text: string) => w.autoSpeech.push(text);
  });
  mock.broadcast(t, { t: "say", text: "owner reply", speak: true });
  mock.broadcast(t, { t: "say", text: "text only", speak: false });
  mock.broadcast(t, { t: "role", role: "guest", pending: false });
  mock.broadcast(t, { t: "say", text: "guest reply", speak: true });
  mock.broadcast(t, { t: "role", role: "owner", pending: true });
  mock.broadcast(t, { t: "say", text: "pending reply", speak: true });
  mock.broadcast(t, { t: "role", role: "owner", pending: false });
  mock.broadcast(t, { t: "say", text: "default speech" });
  await expect.poll(() => page.evaluate(() => (window as any).autoSpeech)).toEqual(["owner reply", "default speech"]);
  expect(await page.evaluate(() => (window as any).tendril._core.transcript.map((e: any) => e.text))).toEqual(["owner reply", "text only", "guest reply", "pending reply", "default speech"]);
});

test("window.tendril exists synchronously; hello and welcome", async ({ page }) => {
  const t = mock.create({
    html: `<script>
      window.__sync = typeof tendril === "object" && typeof tendril.send === "function" && typeof tendril.state.get === "function" && typeof tendril.ready.manual === "function";
      window.__connectedAtStart = tendril.connected;
      tendril.send({ early: 1 });
    </script>`,
  });
  await open(page, t);
  expect(await page.evaluate(() => (window as any).__sync)).toBe(true);
  expect(await page.evaluate(() => (window as any).__connectedAtStart)).toBe(false);
  const hello = mock.messages(t, "hello")[0];
  expect(hello.device_id).toMatch(/^d_[a-z2-7]{16}$/);
  expect(hello.device_secret).toMatch(/^[a-z2-7]{32}$/);
  expect(hello.version).toBe(1);
  expect(hello.rev).toBe(0);
  expect(typeof hello.name).toBe("string");
  expect(typeof hello.caps).toBe("object");
  expect(t.msgs[0].t).toBe("hello");
  // early send queued before the socket opened is delivered after hello
  const early = await mock.waitFor(() => mock.messages(t, "send").find((m) => m.data && m.data.early === 1));
  expect(early.wake).toBe(true);
  const info = await page.evaluate(() => ({ device: { ...(window as any).tendril.device }, version: (window as any).tendril.version, core: typeof (window as any).tendril._core, keys: Object.keys((window as any).tendril) }));
  expect(info.device.id).toBe(hello.device_id);
  expect(info.device.role).toBe("owner");
  expect(info.version).toBe(1);
  expect(info.core).toBe("object");
  expect(info.keys).not.toContain("_core");
  // device identity is stable across reloads
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.connected);
  expect(mock.messages(t, "hello")[1].device_id).toBe(hello.device_id);
});

test("double inclusion is ignored", async ({ page }) => {
  const t = mock.create();
  t.html = `<script src="${mock.base(t)}_tendril/tendril.js"></script>`;
  await open(page, t);
  await page.waitForTimeout(300);
  expect(mock.messages(t, "hello").length).toBe(1);
});

test("send returns seq after ack; wake option", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  const r1 = await page.evaluate(() => (window as any).tendril.send({ a: 1 }));
  expect(r1.queued).toBe(false);
  expect(typeof r1.seq).toBe("number");
  await page.evaluate(() => (window as any).tendril.send("x", { wake: false }));
  const sends = mock.messages(t, "send");
  expect(sends[0].data).toEqual({ a: 1 });
  expect(sends[0].wake).toBe(true);
  expect(sends[0].cid).toBeTruthy();
  expect(sends[1].wake).toBe(false);
});

test("role message updates tendril.device live; connected reflects socket", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  mock.broadcast(t, { t: "role", role: "guest", pending: true });
  await page.waitForFunction(() => (window as any).tendril.device.role === "guest" && (window as any).tendril.device.pending === true);
  mock.goOffline(t);
  await page.waitForFunction(() => (window as any).tendril.connected === false);
  mock.goOnline(t);
  await page.waitForFunction(() => (window as any).tendril.connected === true, null, { timeout: 15000 });
});

test("offline queue persists across reload and replays in order", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  await page.evaluate(() => {
    (window as any).__events = [];
    (window as any).tendril.on("disconnect", () => (window as any).__events.push("disconnect"));
  });
  mock.goOffline(t);
  await page.waitForFunction(() => !(window as any).tendril.connected);
  expect(await page.evaluate(() => (window as any).__events)).toEqual(["disconnect"]);
  const r = await page.evaluate(async () => {
    const tl = (window as any).tendril;
    const a = await tl.send({ n: 1 });
    tl.state.set("list.a", { text: "milk" });
    const b = await tl.send({ n: 2 });
    return [a, b];
  });
  expect(r[0].queued).toBe(true);
  expect(r[1].queued).toBe(true);
  expect(mock.messages(t, "send").length).toBe(0);
  // reload with no socket: queue and local state come back from storage
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.state.get("list.a.text") === "milk");
  await page.evaluate(() => (window as any).tendril.send({ n: 3 }));
  await page.waitForTimeout(200);
  expect(mock.messages(t, "send").length).toBe(0);
  mock.goOnline(t);
  await mock.waitFor(() => mock.messages(t, "send").length >= 3, 20000);
  const order = t.msgs.filter((m) => m.t === "send" || m.t === "state").map((m) => (m.t === "send" ? m.data.n : "state"));
  expect(order).toEqual([1, "state", 2, 3]);
  expect(t.state).toEqual({ list: { a: { text: "milk" } } });
  // acked items leave the queue: another reconnect does not resend them
  await page.waitForFunction(() => (window as any).tendril.connected);
  await page.waitForTimeout(300);
  mock.goOffline(t);
  mock.goOnline(t);
  await mock.waitFor(() => mock.messages(t, "hello").length >= 3, 20000);
  await page.waitForTimeout(500);
  expect(mock.messages(t, "send").length).toBe(3);
});

test("state: local ops, merge patch, remote ops, reset, listeners", async ({ page }) => {
  const t = mock.create({ state: { _prefs: { audio: false }, count: 1 }, rev: 5 });
  await open(page, t);
  expect(await page.evaluate(() => (window as any).tendril.state.get("count"))).toBe(1);
  await page.evaluate(() => {
    const tl = (window as any).tendril;
    (window as any).__changes = [];
    tl.state.on((s: any, ops: any[], by: string) => (window as any).__changes.push({ ops, by }));
    tl.state.set("list.a1.done", true);
    tl.state.set(["weird.key", "x"], 2);
    tl.state.patch({ obj: { y: 1, z: null }, arr: [1, 2], count: null, gone: null });
    tl.state.patch({ obj: { w: 2, y: null } });
    tl.state.delete("list.a1");
  });
  const ops = await mock.waitFor(() => { const s = mock.messages(t, "state"); return s.length >= 5 && s.map((m) => m.ops); });
  expect(ops[0]).toEqual([{ op: "set", path: ["list", "a1", "done"], value: true }]);
  expect(ops[1]).toEqual([{ op: "set", path: ["weird.key", "x"], value: 2 }]);
  expect(ops[2]).toEqual([
    { op: "set", path: ["obj"], value: { y: 1 } }, // target not an object: one set, nulls stripped
    { op: "set", path: ["arr"], value: [1, 2] },
    { op: "delete", path: ["count"] }, // "gone" absent: no op
  ]);
  expect(ops[3]).toEqual([{ op: "set", path: ["obj", "w"], value: 2 }, { op: "delete", path: ["obj", "y"] }]);
  expect(ops[4]).toEqual([{ op: "delete", path: ["list", "a1"] }]);
  const local = await page.evaluate(() => (window as any).tendril.state.get());
  expect(local).toEqual({ _prefs: { audio: false }, list: {}, "weird.key": { x: 2 }, obj: { w: 2 }, arr: [1, 2] });
  // get() returns a copy
  expect(await page.evaluate(() => { const tl = (window as any).tendril; tl.state.get("obj").w = 99; return tl.state.get("obj.w"); })).toBe(2);
  // remote ops
  mock.pushState(t, [{ op: "set", path: ["remote"], value: { v: 1 } }, { op: "set", path: ["_device", "PLACEHOLDER"], value: 0 }]);
  await page.waitForFunction(() => (window as any).tendril.state.get("remote.v") === 1);
  const last = await page.evaluate(() => (window as any).__changes.at(-1));
  expect(last.by).toBe("agent:main");
  // mine()
  const id = await page.evaluate(() => (window as any).tendril.device.id);
  mock.pushState(t, [{ op: "set", path: ["_device", id], value: { zoom: 3 } }]);
  await page.waitForFunction(() => (window as any).tendril.state.mine()?.zoom === 3);
  // reset
  mock.broadcast(t, { t: "state_reset", state: { fresh: true }, rev: 100 });
  await page.waitForFunction(() => (window as any).tendril.state.get("fresh") === true);
  expect(await page.evaluate(() => (window as any).tendril.state.get("remote"))).toBeUndefined();
  expect(await page.evaluate(() => (window as any).tendril._core.rev)).toBe(100);
});

test("pending local op survives a conflicting remote op (server order wins)", async ({ page }) => {
  const t = mock.create();
  let held: any = null;
  t.onMessage = (m) => { if (m.t === "state") { held = m; return true; } };
  await open(page, t);
  await page.evaluate(() => (window as any).tendril.state.set("k", "mine"));
  await mock.waitFor(() => held);
  mock.pushState(t, [{ op: "set", path: ["k"], value: "theirs" }]);
  await page.waitForTimeout(200);
  // our op is still pending → stays visible on top of the remote one
  expect(await page.evaluate(() => (window as any).tendril.state.get("k"))).toBe("mine");
  t.onMessage = undefined;
  mock.broadcast(t, { t: "ack", cid: held.cid, rev: 2 });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).tendril.state.get("k"))).toBe("mine");
});

test("eval: values, errors, DOM serialization", async ({ page }) => {
  const t = mock.create({ html: `<div id="big">${"x".repeat(5000)}</div><p id="p">hi</p>` });
  await open(page, t);
  expect(await mock.eval(t, "return document.title")).toMatchObject({ ok: true, value: `Test ${t.id} v1` });
  expect(await mock.eval(t, "await new Promise(r => setTimeout(r, 50)); return 1 + 1")).toMatchObject({ ok: true, value: 2 });
  const undef = await mock.eval(t, "return undefined");
  expect(undef.ok).toBe(true);
  expect(undef.value).toBeNull();
  const err = await mock.eval(t, "throw new TypeError('boom')");
  expect(err).toMatchObject({ ok: false, error: "TypeError: boom" });
  const syntax = await mock.eval(t, "return (");
  expect(syntax.ok).toBe(false);
  expect(syntax.error).toMatch(/SyntaxError/);
  expect((await mock.eval(t, "return document.getElementById('p')")).value).toBe('<p id="p">hi</p>');
  const big = (await mock.eval(t, "return document.getElementById('big')")).value;
  expect(big.length).toBe(2000);
  const circ = (await mock.eval(t, "const a = {x: 1, e: new Error('inner'), u: undefined, f(){}}; a.self = a; return a")).value;
  expect(circ).toEqual({ x: 1, e: "Error: inner", u: null, f: expect.stringContaining("f()"), self: "[object Object]" });
  expect((await mock.eval(t, "return [document.querySelectorAll('p'), new Map([['a', 1]]), new Set([1]), 10n, NaN]")).value)
    .toEqual([['<p id="p">hi</p>'], { a: 1 }, [1], "10", "NaN"]);
  expect((await mock.eval(t, "return window")).value).toBe("[object Window]");
});

test("console forwarding and window errors as batched logs", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  const consoleSeen: string[] = [];
  page.on("console", (m) => consoleSeen.push(m.text()));
  await page.evaluate(() => {
    console.log("hello", { a: 1 }, 2);
    console.info("info!");
    console.warn("warn!");
    console.error(new Error("bad thing"));
    console.log("y".repeat(10000));
    setTimeout(() => { throw new Error("async fail"); });
    Promise.reject(new Error("rejected!"));
  });
  const entries = await mock.waitFor(() => {
    const all = mock.messages(t, "log").flatMap((m) => m.entries);
    return all.length >= 7 && all;
  });
  expect(mock.messages(t, "log").length).toBeLessThanOrEqual(2);
  const msg = (s: string) => entries.find((e: any) => e.message.includes(s));
  expect(msg("hello")).toMatchObject({ level: "log", message: 'hello {"a":1} 2' });
  expect(msg("info!").level).toBe("info");
  expect(msg("warn!").level).toBe("warn");
  expect(msg("bad thing").level).toBe("error");
  expect(msg("bad thing").stack).toContain("bad thing");
  expect(msg("yyyy").message.length).toBeLessThanOrEqual(4000);
  expect(msg("async fail").level).toBe("error");
  expect(msg("rejected!").message).toContain("Unhandled rejection");
  expect(typeof entries[0].ts).toBe("number");
  // originals still work
  expect(consoleSeen.some((s) => s.startsWith("hello"))).toBe(true);
});

test("health ok", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h).toMatchObject({ t: "health", version: 1, ok: true, errors: [] });
});

test("health failure on uncaught error after load", async ({ page }) => {
  const t = mock.create({ version: 7, html: `<script>addEventListener("load", () => setTimeout(() => { throw new Error("broken page") }, 200))</script>` });
  await open(page, t);
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h.ok).toBe(false);
  expect(h.version).toBe(7);
  expect(h.errors.join(" ")).toContain("broken page");
});

test("health failure on error thrown while parsing", async ({ page }) => {
  const t = mock.create({ html: `<script>undefinedFunction()</script>` });
  await open(page, t);
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h.ok).toBe(false);
  expect(h.errors[0]).toContain("undefinedFunction");
});

test("health manual mode waits for ready()", async ({ page }) => {
  const t = mock.create({ html: `<script>tendril.ready.manual(); setTimeout(() => tendril.ready(), 3000)</script>` });
  const start = Date.now();
  await open(page, t);
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h.ok).toBe(true);
  expect(Date.now() - start).toBeGreaterThan(2800);
});

test("reload on reload message only when the version differs", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  mock.broadcast(t, { t: "reload", version: 1 });
  await page.waitForTimeout(500);
  expect(t.pageLoads).toBe(1);
  t.version = 2;
  mock.broadcast(t, { t: "reload", version: 2 });
  await mock.waitFor(() => t.pageLoads === 2);
  await page.waitForFunction(() => (window as any).tendril && (window as any).tendril.version === 2);
});

test("welcome with a newer current version reloads once", async ({ page }) => {
  const t = mock.create();
  t.welcomeExtra = { version: { current: 5, latest: 5, healthy: 5 } };
  await page.goto(mock.url(t));
  await mock.waitFor(() => t.pageLoads >= 2);
  await page.waitForTimeout(1000);
  expect(t.pageLoads).toBe(2); // guarded: no reload loop
});

test("say, instruction and transcript; presence; request correlation", async ({ page }) => {
  const t = mock.create({ state: { _prefs: { audio: false } } });
  t.onMessage = (m, ws) => {
    if (m.t === "devices") { ws.send(JSON.stringify({ t: "devices", cid: m.cid, devices: [{ id: "d_x" }] })); return true; }
    if (m.t === "adopt_code") { ws.send(JSON.stringify({ t: "error", cid: m.cid, code: "forbidden", message: "no" })); return true; }
  };
  await open(page, t);
  await page.evaluate(() => {
    const tl = (window as any).tendril;
    (window as any).__said = [];
    tl.on("say", (m: any) => (window as any).__said.push(m.text));
    tl.on("presence", (p: any) => ((window as any).__presence = p));
  });
  mock.broadcast(t, { t: "say", text: "On it", speak: true, ts: 1 });
  await page.waitForFunction(() => (window as any).__said.length === 1);
  mock.broadcast(t, { t: "presence", state: "working", text: "Working", last_seen: 1, schedule_minutes: null, withheld: 0, wake: "long_poll" });
  await page.waitForFunction(() => (window as any).__presence?.state === "working");
  expect(await page.evaluate(() => (window as any).tendril.presence.state)).toBe("working");
  await page.evaluate(() => (window as any).tendril._core.instruction("make it blue", "text"));
  const ins = mock.messages(t, "send").find((m) => m.kind === "instruction");
  expect(ins).toMatchObject({ kind: "instruction", text: "make it blue", via: "text", wake: true });
  const id = await page.evaluate(() => (window as any).tendril.device.id);
  mock.broadcast(t, { t: "instruction_echo", text: "make it blue", via: "text", device: id, ts: 2 });
  await page.waitForTimeout(100);
  const tr = await page.evaluate(() => (window as any).tendril._core.transcript.map((e: any) => `${e.from}:${e.text}`));
  expect(tr).toEqual(["agent:On it", "user:make it blue"]);
  const devices = await page.evaluate(() => (window as any).tendril._core.request({ t: "devices" }));
  expect(devices.devices[0].id).toBe("d_x");
  const err = await page.evaluate(() => (window as any).tendril._core.request({ t: "adopt_code" }).then(() => "resolved", (e: any) => e.code));
  expect(err).toBe("forbidden");
});

test("upload posts the blob", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  const r = await page.evaluate(() => (window as any).tendril.upload(new Blob(["abc"], { type: "text/plain" }), { name: "a.txt" }));
  expect(r.id).toMatch(/^b_/);
  expect(r.url).toBe("_tendril/blob/" + r.id);
  const b = t.blobs.get(r.id)!;
  expect(b.body.toString()).toBe("abc");
  expect(b.type).toBe("text/plain");
  expect(b.name).toBe("a.txt");
});

test("check runs axe and replies with violations (needs network to jsdelivr)", async ({ page }) => {
  const t = mock.create({ html: `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">` });
  await open(page, t);
  mock.broadcast(t, { t: "check", call_id: "c1" });
  const r = await mock.waitFor(() => t.msgs.find((m) => m.t === "eval_result" && m.call_id === "c1"), 20000);
  test.skip(!r.ok && /could not load/.test(r.error), "axe-core CDN not reachable");
  expect(r.ok).toBe(true);
  const ids = r.value.violations.map((v: any) => v.id);
  expect(ids).toContain("image-alt");
  expect(typeof r.value.violations[0].nodes).toBe("number");
});

test("service worker caches the version; offline reload shows the page with its state", async ({ page, context }) => {
  const t = mock.create({ noSw: false, html: `<h1 id="h">Cached page</h1><script src="app.js"></script>` });
  t.files["app.js"] = { type: "text/javascript", body: "window.__app = 'v1';" };
  await open(page, t);
  await page.evaluate(() => (window as any).tendril.state.set("note", "kept"));
  await mock.waitFor(() => mock.messages(t, "state").length === 1);
  await page.waitForFunction(async () => {
    const keys = await caches.keys();
    const name = keys.find((k) => k.startsWith("tendril-") && k !== "tendril-meta");
    if (!name) return false;
    const c = await caches.open(name);
    return (await c.keys()).length >= 3;
  }, null, { timeout: 15000 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const name = (await caches.keys()).find((k) => k.startsWith("tendril-t"))!;
    return { name, keys: (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname) };
  });
  expect(cached.name).toBe(`tendril-${t.id}-v1`);
  expect(cached.keys).toEqual(expect.arrayContaining([mock.base(t), mock.base(t) + "app.js", mock.base(t) + "_tendril/tendril.js"]));
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#h")).toHaveText("Cached page");
  expect(await page.evaluate(() => (window as any).__app)).toBe("v1");
  expect(await page.evaluate(() => (window as any).tendril.state.get("note"))).toBe("kept");
  expect(await page.evaluate(() => (window as any).tendril.connected)).toBe(false);
  await context.setOffline(false);
});
