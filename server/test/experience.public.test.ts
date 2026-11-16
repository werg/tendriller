import { beforeAll, expect, inject, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { sha256Hex } from "../src/ids";
import { deleteTimer, nextDaily, runTimers, saveTimer } from "../src/timers";
import { addEvent } from "../src/events";
import { exportBundle } from "../src/portability";
import { fileKey } from "../src/files";
import { KEEP_VERSIONS } from "../src/limits";
import { api, apiJson, advance, inDO, PageClient, publishedFile, publishFilesJson, req, uploadBlobJson, type Handle } from "./helpers";

beforeAll(async () => {
  await applyD1Migrations(env.ACCOUNTS, inject("d1Migrations"));
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run();
});
let index = 0;
async function setup() {
  const account = crypto.randomUUID(), email = `${account}@example.com`, raw = crypto.randomUUID();
  const response = await req("/api/tendrils", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${++index}` }, body: JSON.stringify({ owner: email }) });
  expect(response.status).toBe(201);
  const handle = await response.json<Handle>();
  await env.ACCOUNTS.prepare("INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)").bind(account, email, Date.now() - 30 * 86400000).run();
  await env.ACCOUNTS.prepare("UPDATE tendrils SET owner_account=?, claimed_at=? WHERE id=?").bind(account, Date.now(), handle.id).run();
  const hash = await sha256Hex(raw);
  await inDO(handle.id, t => {
    t.db.set("owner_account", account); t.db.set("claimed_at", t.now());
    t.db.run("INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,'owner',?)", hash, account, t.now() + 86400000);
  });
  const cookie = `__Host-tendril=${raw}`, origin = new URL(handle.page_url).origin;
  const page = (path: string, method = "GET", body?: unknown, url = handle.page_url, useCookie = cookie) => req(url + "_tendril/" + path, {
    method, headers: { Cookie: useCookie, Origin: new URL(url).origin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { handle, account, cookie, origin, page };
}
async function listener(h: Handle) {
  const response = await api(h, "GET", "events/socket", undefined, { Upgrade: "websocket", "Sec-WebSocket-Protocol": `tendriller.agent.v2, ${h.token}` });
  expect(response.status).toBe(101); response.webSocket!.accept(); return response.webSocket!;
}

it("device purpose does not grant privileges; focused speech uses only one socket", async () => {
  const { handle: h, page, cookie, origin } = await setup();
  const first = await PageClient.connect(h.page_url, { headers: { Cookie: cookie, Origin: origin }, name: "Phone" });
  const second = await PageClient.connect(h.page_url, { headers: { Cookie: cookie, Origin: origin }, name: "Tablet" });
  expect((await api(h, "PATCH", `devices/${first.deviceId}`, { role: "owner" })).status).toBe(403);
  expect((await page("devices", "PATCH", { id: second.deviceId, purpose: "speaker" })).status).toBe(200);
  await apiJson(h, "POST", "say", { text: "A single voice" });
  expect((await first.next("say")).speak).toBe(false);
  expect((await second.next("say")).speak).toBe(true);
  expect((await page("focus", "POST", { device: first.deviceId, ttl_seconds: 60 })).status).toBe(200);
  await apiJson(h, "POST", "say", { text: "Continue on the phone" });
  expect((await first.next("say")).speak).toBe(true);
  expect((await second.next("say")).speak).toBe(false);
  const config = await (await page("devices")).json<any>();
  expect(config.focus.device).toBe(first.deviceId);
  expect(config.devices.find((d: any) => d.id === second.deviceId)).toMatchObject({ purpose: "speaker", role: "owner" });
  first.close(); second.close();
});

it("runs a durable timer once without a page, coalesces missed intervals, and records cancellation", async () => {
  const { handle: h } = await setup();
  const now = await inDO(h.id, t => t.now());
  const timer = await apiJson(h, "POST", "timers", { title: "Read the sensor", due_at: now + 10000, repeat: { every_minutes: 5 }, missed: "fire_once" }, 201);
  await advance(h.id, 31 * 60000);
  await inDO(h.id, t => runTimers(t)); await inDO(h.id, t => runTimers(t));
  const events = await apiJson(h, "GET", "events?after=0");
  expect(events.events.filter((e: any) => e.data?.type === "timer")).toHaveLength(1);
  expect(events.events.find((e: any) => e.data?.type === "timer").role).toBe(null);
  const history = await apiJson(h, "GET", "timers/history"); expect(history.runs).toHaveLength(1);
  const current = (await apiJson(h, "GET", "timers")).timers[0]; expect(current.due_at).toBeGreaterThan(now + 31 * 60000);
  await apiJson(h, "PATCH", `timers/${timer.id}`, { state: "cancelled" });
  await advance(h.id, 3600000); await inDO(h.id, t => runTimers(t));
  expect((await apiJson(h, "GET", "timers/history")).runs).toHaveLength(1);
});

it("supports skip-late policy and rejects invalid timer input", async () => {
  const { handle: h } = await setup();
  const now = await inDO(h.id, t => t.now());
  expect((await api(h, "POST", "timers", { title: "bad", due_at: now, timezone: "Not/A_Zone" })).status).toBe(400);
  expect((await api(h, "POST", "timers", { title: "bad", due_at: now, repeat: { every_minutes: 0 } })).status).toBe(400);
  await apiJson(h, "POST", "timers", { title: "Do not catch up", due_at: now - 180000, missed: "skip" }, 201);
  await inDO(h.id, t => runTimers(t));
  expect((await apiJson(h, "GET", "timers/history")).runs[0].status).toBe("skipped");
  expect((await apiJson(h, "GET", "events?after=0")).events.some((e: any) => e.data?.type === "timer")).toBe(false);
});

it("pauses timer execution during service read-only and bounds it to the page lifetime", async () => {
  const { handle: h } = await setup();
  const now = await inDO(h.id, t => t.now());
  expect((await api(h, "POST", "timers", { title: "Too far away", due_at: now + 365 * 86400000 })).status).toBe(409);
  const timer = await apiJson(h, "POST", "timers", { title: "Wait for service", due_at: now + 1000 }, 201);
  await advance(h.id, 2000);
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
  try {
    await inDO(h.id, t => runTimers(t));
    expect(await inDO(h.id, t => t.db.all("SELECT id FROM timer_runs"))).toHaveLength(0);
  } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
  await advance(h.id, 61000);
  await inDO(h.id, t => runTimers(t));
  expect((await apiJson(h, "GET", "timers/history")).runs).toHaveLength(1);
  expect((await api(h, "PATCH", `timers/${timer.id}`, { state: "scheduled" })).status).toBe(409);
});

it("does not fire scheduled work for a suspended owner", async () => {
  const { handle: h, account } = await setup();
  const now = await inDO(h.id, t => t.now());
  await apiJson(h, "POST", "timers", { title: "Paused account", due_at: now + 1000 }, 201);
  await env.ACCOUNTS.prepare("UPDATE accounts SET suspended_at=? WHERE id=?").bind(now, account).run();
  await advance(h.id, 2000); await inDO(h.id, t => runTimers(t));
  expect(await inDO(h.id, t => t.db.all("SELECT id FROM timer_runs"))).toHaveLength(0);
  expect(await inDO(h.id, t => t.db.get("disabled", false))).toBe(true);
});

it("daily recurrence respects IANA time zones, DST gaps and repeated times", () => {
  expect(new Date(nextDaily(Date.parse("2026-03-28T12:00:00Z"), { at: "02:30" }, "Europe/Berlin")).toISOString()).toBe("2026-03-30T00:30:00.000Z");
  expect(new Date(nextDaily(Date.parse("2026-10-25T00:45:00Z"), { at: "02:30" }, "Europe/Berlin")).toISOString()).toBe("2026-10-26T01:30:00.000Z");
  expect(new Date(nextDaily(Date.parse("2026-11-15T12:00:00Z"), { at: "09:00", days: [1] }, "Europe/Berlin")).toISOString()).toBe("2026-11-16T08:00:00.000Z");
});

it("preserves context, restores bundles with rewritten media, and refuses stale publication", async () => {
  const { handle: h, page } = await setup(); const socket = await listener(h);
  const blob = await uploadBlobJson(h, "asset", { type: "text/plain" });
  await publishFilesJson(h, { "index.html": `<h1>Notebook</h1><a href="_tendril/blobs/${blob.id}">Asset</a>` });
  await apiJson(h, "PUT", "state", { cid: crypto.randomUUID(), expected_generations: {}, state: { notebook: { asset: blob.id }, _device: { old: { secret: "do not copy" } } } });
  await apiJson(h, "PUT", "session", { purpose: "Observe the garden", current_task: "Compare leaves", open_questions: ["What changed?"], completed: [], decisions: [], last_handled_seq: 0 });
  expect((await api(h, "PUT", "session", { purpose: "Stale context", expected_revision: 0 })).status).toBe(409);
  const bundle = await (await page("bundle?include_data=true")).json<any>();
  expect(bundle.state._device).toEqual({ old: { secret: "do not copy" } }); expect(bundle.session.current_task).toBe("Compare leaves");
  const destination = await setup(); const targetSocket = await listener(destination.handle);
  expect((await api(destination.handle, "PUT", "bundle", bundle)).status).toBe(202);
  expect((await api(destination.handle, "PUT", "bundle", bundle)).status).toBe(409);
  expect((await api(destination.handle, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: 9 })).status).toBe(409);
  expect((await api(destination.handle, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: 0 })).status).toBe(200);
  const restored = await apiJson(destination.handle, "GET", "state");
  expect(restored.state.notebook.asset).not.toBe(blob.id);
  expect((await apiJson(destination.handle, "GET", "session")).session.purpose).toBe("Observe the garden");
  socket.close(); targetSocket.close();
});

it("remix creates an independent unpublished copy and preserves the listener gate", async () => {
  const { handle: h } = await setup(); const socket = await listener(h);
  await publishFilesJson(h, { "index.html": "<h1>A reusable tool</h1>" });
  const copy = await apiJson(h, "POST", "remix", { owner: "new-owner@example.com", name: "My new copy" }, 201);
  expect(copy.id).not.toBe(h.id); expect(copy.token).not.toBe(h.token); expect(copy.remix.staged).toBe(true);
  expect((await api(copy, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: 0 })).status).toBe(428);
  const nextSocket = await listener(copy);
  expect((await api(copy, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: 0 })).status).toBe(200);
  expect((await apiJson(h, "GET", "")).version.current).toBe(1);
  socket.close(); nextSocket.close();
});

it("validates bundle paths before writing and blocks publishing without review", async () => {
  const { handle: h } = await setup();
  const bundle = { format: "tendriller-bundle", version: 3, entry: "index.html", name: "Bad", files: [{ path: "../index.html", type: "text/html", base64: btoa("bad") }], media: [] };
  expect((await api(h, "PUT", "bundle", bundle)).status).toBe(400);
  expect(await inDO(h.id, t => t.storageUsed())).toBe(0);
});

it("stages an unchanged bundle at the page storage limit", async () => {
  const { handle: h } = await setup(); const socket = await listener(h);
  await publishFilesJson(h, { "index.html": "<h1>Keep this page</h1>" });
  const bundle = await apiJson(h, "GET", "bundle");
  await inDO(h.id, t => {
    const used = t.storageUsed();
    t.db.run("INSERT INTO stored_files(hash,size,created_at,risk_score,status) VALUES(?,?,?,0,'ready')", "f".repeat(64), 25 * 1024 * 1024 - used, t.now());
  });
  expect(await inDO(h.id, t => t.storageUsed())).toBe(25 * 1024 * 1024);
  expect((await api(h, "PUT", "bundle", bundle)).status).toBe(202);
  expect((await api(h, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: 1 })).status).toBe(200);
  socket.close();
});

it("accepts a portable bundle with more than 200 media entries", async () => {
  const { handle: h } = await setup(); const socket = await listener(h);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const media = Array.from({ length: 201 }, (_, i) => ({ id: "b_" + "a".repeat(18) + alphabet[Math.floor(i / 32)] + alphabet[i % 32],
    type: "application/octet-stream", name: null, base64: "AA==" }));
  const bundle = { format: "tendriller-bundle", version: 3, entry: "index.html", name: "Capture archive", files: [
    { path: "index.html", type: "text/html", base64: btoa("<h1>Archive</h1>") },
  ], media };
  expect((await api(h, "PUT", "bundle", bundle)).status).toBe(202);
  expect(await inDO(h.id, t => t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")?.n)).toBe(201);
  expect((await api(h, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: 0 })).status).toBe(200);
  const exported = await apiJson(h, "GET", "bundle?include_data=true");
  expect(exported.media).toHaveLength(201);
  const copy = await setup(); const copySocket = await listener(copy.handle);
  expect((await api(copy.handle, "PUT", "bundle", exported)).status).toBe(202);
  expect((await api(copy.handle, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: 0 })).status).toBe(200);
  expect(await inDO(copy.handle.id, t => t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM blobs WHERE id NOT IN (SELECT blob_id FROM publication_blobs)")?.n)).toBe(201);
  socket.close(); copySocket.close();
}, 60_000);

it.each(["cancel", "reschedule", "delete"])("honors a %s while an earlier timer notification is in flight", async (change) => {
  const { handle: h } = await setup();
  const now = await inDO(h.id, t => t.now());
  const first = await apiJson(h, "POST", "timers", { title: "First reminder", due_at: now + 1000, notify: true }, 201);
  const later = await apiJson(h, "POST", "timers", { title: "Changed reminder", due_at: now + 2000 }, 201);
  await advance(h.id, 3000);
  await inDO(h.id, async t => {
    const notify = t.notify;
    t.notify = async () => {
      // Represents another request served while delivery awaits an external push service.
      if (change === "delete") deleteTimer(t, later.id, "owner");
      else saveTimer(t, change === "cancel" ? { state: "cancelled" } : { due_at: t.now() + 60000 }, "owner", later.id);
      return { sent: 1, failed: 0, deliveries: [{ device: "phone", ok: true, status: 201, gone: false }] };
    };
    try { await runTimers(t); } finally { t.notify = notify; }
  });
  const runs = (await apiJson(h, "GET", "timers/history")).runs;
  expect(runs).toHaveLength(1); expect(runs[0].timer_id).toBe(first.id);
  const events = (await apiJson(h, "GET", "events?after=0")).events.filter((event: any) => event.data?.type === "timer");
  expect(events.map((event: any) => event.data.timer_id)).toEqual([first.id]);
});

it("keeps prepared files through orphan cleanup and later publishes them", async () => {
  const { handle: h } = await setup(); const socket = await listener(h);
  const bundle = { format: "tendriller-bundle", version: 3, entry: "index.html", name: "n".repeat(200), files: [
    { path: "index.html", type: "text/html", base64: btoa("<h1>Prepared yesterday</h1>") },
  ], media: [] };
  expect((await api(h, "PUT", "bundle", bundle)).status).toBe(202);
  await advance(h.id, 2 * 3600000);
  await inDO(h.id, t => t.pruneOrphanFiles(t.now()));
  expect((await api(h, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: 0 })).status).toBe(200);
  expect(await (await publishedFile(h, "index.html")).text()).toContain("Prepared yesterday");
  socket.close();
});

it("protects a prepared hash when its old published version is pruned", async () => {
  const { handle: h } = await setup(); const socket = await listener(h);
  await publishFilesJson(h, { "index.html": "<h1>Restore this older page</h1>" });
  const bundle = await apiJson(h, "GET", "bundle");
  expect((await api(h, "PUT", "bundle", bundle)).status).toBe(202);
  const next = await uploadBlobJson(h, "<h1>A newer publication</h1>", { type: "text/html" });
  let head = (await apiJson(h, "GET", "publications")).head_revision;
  for (let n = 0; n < KEEP_VERSIONS; n++) {
    const published = await apiJson(h, "POST", "publications", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: head,
      entry: "index.html", files: [{ path: "index.html", blob_id: next.id, type: next.type }] });
    head = published.head_revision;
  }
  await inDO(h.id, t => t.pruneVersions());
  expect(await inDO(h.id, t => t.db.one("SELECT version FROM versions WHERE version=1"))).toBeNull();
  expect((await api(h, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: KEEP_VERSIONS + 1 })).status).toBe(200);
  expect(await (await publishedFile(h, "index.html")).text()).toContain("Restore this older page");
  socket.close();
});

it.each(["file", "media"])("refuses publication if prepared %s bytes are missing", async (missing) => {
  const { handle: h } = await setup(); const socket = await listener(h);
  const bundle = { format: "tendriller-bundle", version: 3, entry: "index.html", name: "Prepared asset", files: [
    { path: "index.html", type: "text/html", base64: btoa("<h1>A prepared page</h1>") },
  ], media: [{ id: "b_" + "a".repeat(20), type: "text/plain", name: "sample.txt", base64: btoa("sample") }] };
  expect((await api(h, "PUT", "bundle", bundle)).status).toBe(202);
  await inDO(h.id, async t => {
    const staged = t.db.get<any>("staged_bundle", null);
    await t.env.FILES.delete(missing === "file" ? fileKey(t, staged.files[0].hash) : t.blobKey(staged.media[0]));
  });
  const rejected = await api(h, "POST", "bundle/publish", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: 0 });
  expect(rejected.status).toBe(409); expect((await rejected.json<any>()).error.code).toBe("incomplete_bundle");
  expect(await inDO(h.id, t => t.db.get("current", 0))).toBe(0);
  expect((await apiJson(h, "GET", "session")).staged_remix).toBe(true);
  socket.close();
});

it("exports one logical data snapshot while new captures arrive during media reads", async () => {
  const { handle: h } = await setup(); const socket = await listener(h);
  await publishFilesJson(h, { "index.html": "<h1>Notebook</h1>" });
  const original = await uploadBlobJson(h, "old media", { type: "text/plain" });
  await apiJson(h, "PUT", "state", { cid: crypto.randomUUID(), expected_generations: {}, state: { asset: original.id } });
  await apiJson(h, "PUT", "session", { purpose: "Original context" });
  const bundle = await inDO(h.id, async t => {
    let changed = false;
    const files = new Proxy(t.env.FILES, { get(target, name) {
      if (name === "get") return async (key: string) => {
        if (!changed && key === fileKey(t, original.sha256)) {
          changed = true;
          // Fault injection inside the storage read: a new capture arrives after
          // the exporter captured its logical state and media list.
          const next = await t.storeBlob(new TextEncoder().encode("new media").buffer as ArrayBuffer, "text/plain", "new.txt", null, "agent");
          t.db.set("state", { asset: next.id });
          t.db.set("session_brief", { purpose: "New context", current_task: "", completed: [], decisions: [], open_questions: [], last_handled_seq: 0 });
        }
        return target.get(key);
      };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const exporting = new Proxy(t, { get(target, name) {
      if (name === "env") return { ...target.env, FILES: files };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await exportBundle(exporting, true);
    expect(changed).toBe(true);
    return result;
  });
  expect(bundle.state).toEqual({ asset: original.id });
  expect(bundle.media.map(item => item.id)).toEqual([original.id]);
  expect(bundle.session?.purpose).toBe("Original context");
  expect((await apiJson(h, "GET", "state")).state.asset).not.toBe(original.id);
  socket.close();
});

it("keeps handled cursors valid and reports gaps after retained history disappears", async () => {
  const { handle: h } = await setup();
  const sequences = await inDO(h.id, t => [
    addEvent(t, { type: "event", data: { note: "first" }, wake: false }).seq,
    addEvent(t, { type: "event", data: { note: "second" }, wake: false }).seq,
  ]);
  await apiJson(h, "PUT", "session", { purpose: "Handled the first input", last_handled_seq: sequences[0] });
  await inDO(h.id, t => t.db.run("DELETE FROM events"));
  expect((await apiJson(h, "GET", "session")).pending_inputs).toMatchObject({ earliest_available_seq: null, history_gap: true });
  expect((await api(h, "PUT", "session", { purpose: "Still a valid checkpoint", last_handled_seq: sequences[0] })).status).toBe(200);
  expect((await api(h, "PUT", "session", { last_handled_seq: sequences[1] + 1 })).status).toBe(400);
  await apiJson(h, "PUT", "session", { purpose: "All handled", last_handled_seq: sequences[1] });
  expect((await apiJson(h, "GET", "session")).pending_inputs.history_gap).toBe(false);
  await apiJson(h, "PUT", "session", { purpose: "No checkpoint yet", last_handled_seq: 0 });
  await inDO(h.id, t => addEvent(t, { type: "event", data: { note: "newer" }, wake: false }));
  expect((await apiJson(h, "GET", "session")).pending_inputs.history_gap).toBe(true);
});

it("routes a visible reply and its audio independently, speaking on only one tab", async () => {
  const { handle: h, cookie, origin } = await setup();
  const headers = { Cookie: cookie, Origin: origin };
  const screen = await PageClient.connect(h.page_url, { headers, name: "Screen" });
  const speaker = await PageClient.connect(h.page_url, { headers, name: "Speaker" });
  const speakerTab = await PageClient.connect(h.page_url, { headers, deviceId: speaker.deviceId, secret: speaker.secret, name: "Speaker" });
  await apiJson(h, "POST", "say", { text: "Look at the screen", device: screen.deviceId, speak_on: speaker.deviceId });
  expect(await screen.next("say")).toMatchObject({ present: true, speak: false });
  expect(await speakerTab.next("say")).toMatchObject({ present: false, speak: true });
  expect(speaker.messages.filter(message => message.t === "say")).toHaveLength(0);
  screen.close(); speaker.close(); speakerTab.close();
});

it("sends guests only their own purpose and uses the current session role for focus", async () => {
  const { handle: h, page, cookie, origin } = await setup();
  const owner = await PageClient.connect(h.page_url, { headers: { Cookie: cookie, Origin: origin }, name: "Private owner phone" });
  await page("focus", "POST", { device: owner.deviceId });
  const link = await apiJson(h, "POST", "links", { role: "guest" });
  const guest = crypto.randomUUID(), raw = crypto.randomUUID(), hash = await sha256Hex(raw);
  await env.ACCOUNTS.prepare("INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)").bind(guest, `${guest}@example.com`, Date.now()).run();
  await inDO(h.id, t => {
    t.db.run("INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)", guest, link.id, t.now());
    t.db.run("INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,'guest',?)", hash, guest, t.now() + 86400000);
  });
  const participant = await PageClient.connect(link.url, { headers: { Cookie: `__Host-tendril=${raw}`, Origin: new URL(link.url).origin } });
  expect(participant.welcome.focus).toBeNull();
  expect((await page("devices", "PATCH", { id: participant.deviceId, purpose: "camera" })).status).toBe(200);
  expect(await participant.next("device_config")).toEqual({ t: "device_config", devices: [{ id: participant.deviceId, purpose: "camera" }], focus: null });
  const roster = await owner.next(message => message.t === "device_config" && message.devices.some((device: any) => device.id === participant.deviceId));
  expect(roster.devices.find((device: any) => device.id === owner.deviceId).name).toBe("Private owner phone");
  // A browser identity can first join through a guest link, then sign in as the
  // owner. The authenticated live session takes precedence over its old row.
  await inDO(h.id, t => t.db.run("UPDATE devices SET role='guest' WHERE id=?", owner.deviceId));
  expect((await page("focus", "POST", { device: owner.deviceId })).status).toBe(200);
  expect((await (await page("devices")).json<any>()).devices.find((device: any) => device.id === owner.deviceId).role).toBe("owner");
  expect((await page("focus", "POST", { device: participant.deviceId })).status).toBe(400);
  owner.close(); participant.close();
});
