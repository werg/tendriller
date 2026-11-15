import { afterEach, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { assertValid } from "../../contract/index.mjs";
import { addEvent } from "../src/events";
import { sha256Hex } from "../src/ids";
import { appendRecords, MAX_STREAM_BYTES } from "../src/streams";
import { api, apiJson, advance, create, inDO, PageClient, req, sleep, type Handle } from "./helpers";

const pages: PageClient[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.close(); });
async function connect(h: Handle, url = h.page_url, headers?: Record<string, string>) {
  const page = await PageClient.connect(url, headers ? { headers } : {}); pages.push(page); return page;
}
async function stream(h: Handle, name = "training", extra: Record<string, unknown> = {}) {
  return apiJson(h, "POST", "streams", { name, durability: "durable", ...extra }, 201);
}
const record = (id: string, data: unknown = { loss: 0.4 }) => ({ id, type: "metric", data });
async function producer(h: Handle, name = "machine", streams = ["training"]) {
  return apiJson(h, "POST", "producers", { name, streams }, 201);
}
async function publish(h: Handle, token: string, records: unknown[], name = "training", expected = 200) {
  const response = await api(h, "POST", `streams/${name}/records`, { records }, {}, token);
  const value = await response.json<any>(); expect(response.status, JSON.stringify(value)).toBe(expected); return value;
}
async function display(h: Handle) {
  const link = await inDO(h.id, t => t.createLink("display", "dashboard", null));
  const url = new URL(h.page_url); url.pathname = `/s/${link.key}/`;
  return { link, url: url.toString(), headers: { Origin: url.origin, Cookie: "" } };
}

it("creates immutable stream definitions and validates durable/ephemeral limits", async () => {
  const h = await create({ listener: false });
  const defined = await stream(h); assertValid("streamInfo", defined);
  expect(defined).toMatchObject({ name: "training", readers: "owner", max_records: 10_000, max_age_seconds: 86400, builtin: false });
  expect((await api(h, "POST", "streams", { name: "training", durability: "ephemeral" })).status).toBe(409);
  expect((await api(h, "POST", "streams", { name: "system.custom", durability: "durable" })).status).toBe(400);
  expect((await api(h, "POST", "streams", { name: "live", durability: "ephemeral", max_records: 5 })).status).toBe(400);
  const ephemeral = await stream(h, "live", { durability: "ephemeral" });
  expect(ephemeral.max_records).toBeNull(); expect(ephemeral.max_age_seconds).toBeNull();
  const listed = await apiJson(h, "GET", "streams"); assertValid("streamList", listed); expect(listed.streams).toHaveLength(7);
  expect((await api(h, "DELETE", "streams/training")).status).toBe(405);
  expect((await api(h, "GET", "streams/training/records")).status).toBe(400);
  expect((await api(h, "POST", "streams/system.events/records", { records: [record("forbidden")] })).status).toBe(403);
});

it("durably appends once under concurrent retry and rolls back an entire conflicting batch", async () => {
  const h = await create({ listener: false }); await stream(h);
  const credential = await producer(h);
  const values = await Promise.all([publish(h, credential.token, [record("same")]), publish(h, credential.token, [record("same")])]);
  expect(values[0]).toEqual(values[1]); assertValid("streamAppendResult", values[0]);
  await advance(h.id, 1000);
  expect(await publish(h, credential.token, [record("same")])).toEqual(values[0]);
  await publish(h, credential.token, [record("new-before-conflict"), record("same", { loss: 4 })], "training", 409);
  const batch = await apiJson(h, "GET", "streams/training/records?after=0"); assertValid("streamBatch", batch);
  expect(batch.records).toHaveLength(1); expect(batch.cursor).toBe(1);
  expect(batch.records[0].producer).toBe("producer:machine");
  expect(await inDO(h.id, t => t.db.one("SELECT latest_seq FROM streams WHERE name='training'"))).toEqual({ latest_seq: 1 });
  const next = await publish(h, credential.token, [record("next")]); expect(next.cursor).toBe(2);
  expect((await api(h, "GET", "streams/training/records?after=99")).status).toBe(400);
});

it("publishing is scoped, revocable, independent of agent presence, and never wakes a conversation", async () => {
  const h = await create({ listener: false }); await stream(h); await stream(h, "other");
  const credential = await producer(h);
  expect((await api(h, "GET", "streams", undefined, {}, credential.token)).status).toBe(403);
  expect((await api(h, "POST", "say", { text: "bad" }, {}, credential.token)).status).toBe(403);
  await publish(h, credential.token, [record("scope")], "other", 403);
  await inDO(h.id, t => { t.db.set("last_checkin", 123); t.db.set("wake_pending_since", 456); });
  const before = await inDO(h.id, t => ({ cursor: t.db.get("agent_cursor", 0), events: t.db.all("SELECT * FROM events"), presence: t.presence() }));
  await publish(h, credential.token, [record("accepted")]);
  const after = await inDO(h.id, t => ({ cursor: t.db.get("agent_cursor", 0), events: t.db.all("SELECT * FROM events"), presence: t.presence(),
    checkin: t.db.get("last_checkin", 0), pending: t.db.get("wake_pending_since", 0) }));
  expect(after).toMatchObject({ ...before, checkin: 123, pending: 456 });
  const listed = await apiJson(h, "GET", "producers"); assertValid("producerList", listed);
  expect(listed.producers[0].last_seen).toBeTypeOf("number"); expect(JSON.stringify(listed)).not.toContain(credential.token);
  expect((await api(h, "DELETE", "producers/machine")).status).toBe(200);
  await publish(h, credential.token, [record("revoked")], "training", 401);
  const replacement = await producer(h);
  const replaced = await publish(h, replacement.token, [record("accepted", { loss: 0.9 })]);
  expect(replaced.cursor).toBe(2); // A recreated display name gets a fresh identity.
});

it("keeps ephemeral payloads out of every SQLite payload store while delivering live", async () => {
  const h = await create({ listener: false }); await stream(h, "live", { durability: "ephemeral" });
  const page = await connect(h), credential = await producer(h, "sampler", ["live"]);
  expect(await page.request({ t: "stream_subscribe", stream: "live" })).toMatchObject({ durability: "ephemeral", cursor: 0 });
  const secretPayload = `ephemeral-${crypto.randomUUID()}`;
  const first = await publish(h, credential.token, [record("sample", { marker: secretPayload })], "live");
  expect((await page.next("stream_record")).record).toEqual(first.records[0]);
  const second = await publish(h, credential.token, [record("sample", { marker: secretPayload })], "live");
  expect(second.cursor).toBe(2); // Explicitly no ephemeral dedupe guarantee.
  expect((await page.next("stream_record")).record.seq).toBe(2);
  const stores = await inDO(h.id, t => ["stream_records", "events", "logs", "transcript", "activity", "dedupe", "meta"]
    .map(table => t.db.all(`SELECT * FROM ${table}`)));
  expect(JSON.stringify(stores)).not.toContain(secretPayload);
  expect((await api(h, "GET", "streams/live/records?after=0")).status).toBe(409);
  expect(await page.request({ t: "stream_subscribe", stream: "live", after: 0 })).toMatchObject({ error: "not_replayable" });
  await inDO(h.id, t => t.db.clearCache());
  expect((await publish(h, credential.token, [record("three")], "live")).cursor).toBe(3);
});

it("reports count and age retention gaps with stable high-water marks", async () => {
  const h = await create({ listener: false }); await stream(h, "training", { max_records: 2, max_age_seconds: 1 });
  await apiJson(h, "POST", "streams/training/records", { records: [record("one"), record("two"), record("three")] });
  let batch = await apiJson(h, "GET", "streams/training/records?after=0&limit=1");
  expect(batch.records.map((r: any) => r.seq)).toEqual([2]);
  expect(batch.history).toEqual({ earliest_available_seq: 2, latest_seq: 3, gap: true, missing_through: 1 });
  batch = await apiJson(h, "GET", "streams/training/records?after=2"); expect(batch.records[0].seq).toBe(3); expect(batch.history.gap).toBe(false);
  await advance(h.id, 2000);
  batch = await apiJson(h, "GET", "streams/training/records?after=1");
  expect(batch.records).toEqual([]); expect(batch.cursor).toBe(1);
  expect(batch.history).toEqual({ earliest_available_seq: null, latest_seq: 3, gap: true, missing_through: 3 });
  expect((await apiJson(h, "POST", "streams/training/records", { records: [record("four")] })).cursor).toBe(4);
});

it("offers a gap-free subscribe/history handoff when backlog exceeds one replay batch", async () => {
  const h = await create({ listener: false }); await stream(h);
  await inDO(h.id, t => { for (let n = 0; n < 6; n++) appendRecords(t, "training", { records: Array.from({ length: 100 }, (_, i) => record(`${n * 100 + i}`)) }, "test"); });
  const page = await connect(h);
  const initial = await page.request({ t: "stream_subscribe", stream: "training", after: 0 });
  expect(initial.batch.records).toHaveLength(500); expect(initial.batch.cursor).toBe(500); expect(initial.cursor).toBe(600);
  expect(initial.batch.history.latest_seq).toBe(600);
  await apiJson(h, "POST", "streams/training/records", { records: [record("live")] });
  expect((await page.next("stream_record")).record.seq).toBe(601);
  const rest = await (await req(h.page_url + "_tendril/streams/training/records?after=500&limit=500")).json<any>();
  expect(rest.records.map((r: any) => r.seq)).toEqual(Array.from({ length: 101 }, (_, i) => i + 501));
  const attached = await inDO(h.id, t => t.connectedSockets().find(s => s.att.deviceId === page.deviceId)?.att.streams);
  expect(attached?.training).toBe(601);
  await page.request({ t: "stream_unsubscribe", stream: "training" });
  await apiJson(h, "POST", "streams/training/records", { records: [record("after-unsubscribe")] });
  await sleep(30); expect(page.drain().some(m => m.t === "stream_record")).toBe(false);
});

it("restricts page readers and publication, and reauthorizes live revoked links", async () => {
  const h = await create({ listener: false }); await stream(h); await stream(h, "shared", { readers: "page" });
  const d = await display(h), page = await connect(h, d.url, d.headers), owner = await connect(h);
  const response = await req(d.url + "_tendril/streams", { headers: d.headers });
  const listing = await response.json<any>(); expect(listing.streams.some((s: any) => s.name === "training")).toBe(false);
  expect((await req(d.url + "_tendril/streams/training/records?after=0", { headers: d.headers })).status).toBe(403);
  expect(await page.request({ t: "stream_subscribe", stream: "system.events" })).toMatchObject({ error: "forbidden" });
  expect(await page.request({ t: "stream_subscribe", stream: "training" })).toMatchObject({ error: "forbidden" });
  expect(await page.request({ t: "stream_publish", stream: "shared", records: [record("bad")] })).toMatchObject({ code: "forbidden" });
  await page.request({ t: "stream_subscribe", stream: "shared" });
  await owner.request({ t: "stream_publish", stream: "shared", records: [record("good")] });
  expect((await page.next("stream_record")).record.producer).toBe(`device:${owner.deviceId}`);
  await inDO(h.id, t => { t.db.run("DELETE FROM links WHERE id=?", d.link.id); });
  await owner.request({ t: "stream_publish", stream: "shared", records: [record("revoked")] });
  await sleep(40); expect(page.drain().some(m => m.t === "stream_record")).toBe(false); expect(page.closed?.code).toBe(4003);
});

it("paginates large replay batches by bytes without manufacturing a history gap", async () => {
  const h = await create({ listener: false }); await stream(h);
  await inDO(h.id, t => {
    for (let n = 0; n < 4; n++) appendRecords(t, "training", { records: Array.from({ length: 4 }, (_, i) => record(`${n * 4 + i}`, "x".repeat(49_000))) }, "test");
  });
  const page = await connect(h), initial = await page.request({ t: "stream_subscribe", stream: "training", after: 0 });
  expect(initial.batch.records.length).toBeGreaterThan(0); expect(initial.batch.records.length).toBeLessThan(16);
  expect(initial.cursor).toBe(16); expect(initial.batch.history.gap).toBe(false);
  const remainder = await apiJson(h, "GET", `streams/training/records?after=${initial.batch.cursor}&limit=500`);
  expect(remainder.history.gap).toBe(false); expect(remainder.cursor).toBe(16);
  expect([...initial.batch.records, ...remainder.records].map((r: any) => r.seq)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
});

it("stops live delivery after page-session revocation or account suspension", async () => {
  const h = await create({ listener: false }); await stream(h);
  const page = await connect(h); await page.request({ t: "stream_subscribe", stream: "training" });
  await inDO(h.id, t => { t.db.run("DELETE FROM page_sessions"); });
  await apiJson(h, "POST", "streams/training/records", { records: [record("not-visible")] });
  await sleep(30); expect(page.drain().some(m => m.t === "stream_record")).toBe(false); expect(page.closed?.code).toBe(4003);

  const second = await create({ listener: false }); await stream(second); const active = await connect(second);
  await active.request({ t: "stream_subscribe", stream: "training" });
  const account = await inDO(second.id, t => t.db.get<string>("owner_account", ""));
  await env.ACCOUNTS.prepare("UPDATE accounts SET suspended_at=? WHERE id=?").bind(Date.now(), account).run();
  // Exercise delivery itself, independent of the HTTP gate that also rejects.
  await inDO(second.id, t => appendRecords(t, "training", { records: [record("blocked")] }, "test"));
  await sleep(30); expect(active.drain().some(m => m.t === "stream_record")).toBe(false);
});

it("denies display replay immediately when owner account deletion begins", async () => {
  const h = await create({ listener: false }); await stream(h, "shared", { readers: "page" });
  await apiJson(h, "POST", "streams/shared/records", { records: [record("private-history")] });
  const d = await display(h), page = await connect(h, d.url, d.headers);
  // Populate the normal one-second WS authorization cache, then revoke before
  // it expires: stream replay must still perform a fresh owner-account check.
  expect((await page.request({ t: "stream_subscribe", stream: "shared", after: 0 })).batch.records).toHaveLength(1);
  const account = await inDO(h.id, t => t.db.get<string>("owner_account", ""));
  await env.ACCOUNTS.prepare("UPDATE accounts SET deleting_at=? WHERE id=?").bind(Date.now(), account).run();
  page.drain(); page.send({ t: "stream_subscribe", stream: "shared", after: 0, cid: "revoked-replay" });
  await sleep(40);
  expect(page.closed?.code).toBe(4003);
  expect(page.drain().some(message => message.cid === "revoked-replay" || message.t === "stream_record")).toBe(false);
});

it("preserves existing event/log/transcript histories and makes state/presence signals ephemeral", async () => {
  const h = await create({ listener: false }), page = await connect(h);
  await page.request({ t: "stream_subscribe", stream: "system.transcript", after: 0 });
  await page.request({ t: "stream_subscribe", stream: "system.state" });
  await page.request({ t: "stream_subscribe", stream: "system.presence" });
  await apiJson(h, "POST", "say", { text: "Training started", speak: false });
  expect((await page.next(m => m.t === "stream_record" && m.record.stream === "system.transcript")).record.data.text).toBe("Training started");
  await apiJson(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: {}, ops: [{ op: "set", path: ["run"], value: "one" }] });
  expect((await page.next(m => m.t === "stream_record" && m.record.stream === "system.state")).record.data.rev).toBe(1);
  await apiJson(h, "POST", "status", { state: "working", text: "Checking" });
  expect((await page.next(m => m.t === "stream_record" && m.record.stream === "system.presence")).record.type).toBe("presence");
  page.send({ t: "log", entries: [{ level: "info", message: "browser diagnostic", ts: -100.5 }] });
  await page.request({ t: "send", expected_generations: {}, kind: "event", data: { reading: 2 }, wake: false });
  const legacy = await apiJson(h, "GET", "events?after=0"), adapter = await apiJson(h, "GET", "streams/system.events/records?after=0");
  expect(adapter.records.map((r: any) => r.data)).toEqual(legacy.events);
  const logs = await apiJson(h, "GET", "logs?after=0"), logAdapter = await apiJson(h, "GET", "streams/system.logs/records?after=0");
  assertValid("streamBatch", logAdapter);
  expect(logAdapter.records.map((r: any) => r.data)).toEqual(logs.logs);
  const beforeCursor = await inDO(h.id, t => t.db.get("agent_cursor", 0));
  await inDO(h.id, t => addEvent(t, { type: "event", data: { extra: true }, wake: false }));
  await apiJson(h, "GET", "streams/system.events/records?after=0");
  expect(await inDO(h.id, t => t.db.get("agent_cursor", 0))).toBe(beforeCursor); // Adapter reads never acknowledge work.
  expect(await inDO(h.id, t => t.db.all("SELECT * FROM stream_records"))).toEqual([]);
  expect((await api(h, "GET", "streams/system.state/records?after=0")).status).toBe(409);
});

it("never delivers a built-in record from a rolled-back transaction", async () => {
  const h = await create({ listener: false }), page = await connect(h);
  await page.request({ t: "stream_subscribe", stream: "system.transcript" });
  await inDO(h.id, t => {
    try { t.transaction(() => { t.addTranscript("agent", "rolled back"); throw Error("rollback"); }); } catch {}
  });
  await sleep(40); expect(page.drain().some(m => m.t === "stream_record")).toBe(false);
  const read = await apiJson(h, "GET", "streams/system.transcript/records?after=0"); expect(read.records).toEqual([]);
});

it("suppresses rolled-back state signals and closes on transient authorization lookup failure", async () => {
  const h = await create({ listener: false }); await stream(h); const page = await connect(h);
  await page.request({ t: "stream_subscribe", stream: "system.state" });
  await page.request({ t: "stream_subscribe", stream: "training", after: 0 });
  await inDO(h.id, t => {
    try { t.transaction(() => { t.applyState([{ op: "set", path: ["phantom"], value: true }], "test"); throw Error("rollback"); }); }
    catch { t.db.clearCache(); }
  });
  await sleep(30); expect(page.drain().some(m => m.t === "stream_record")).toBe(false);
  await inDO(h.id, async t => {
    const prepare = t.env.ACCOUNTS.prepare;
    t.env.ACCOUNTS.prepare = function(query: string) {
      if (query.includes("FROM tendrils t") && query.includes("a.suspended_at")) throw Error("simulated transient authorization outage");
      return prepare.call(this, query);
    };
    try {
      appendRecords(t, "training", { records: [record("persisted-before-outage")] }, "test");
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally { t.env.ACCOUNTS.prepare = prepare; }
  });
  await sleep(30); expect(page.closed?.code).toBe(1013); expect(page.drain().some(m => m.t === "stream_record")).toBe(false);
  const resumed = await connect(h), replay = await resumed.request({ t: "stream_subscribe", stream: "training", after: 0 });
  expect(replay.batch.records.map((r: any) => r.id)).toEqual(["persisted-before-outage"]);
});

it("treats object-property names as ordinary streams without implicit subscriptions", async () => {
  const h = await create({ listener: false }); await stream(h, "constructor");
  const page = await connect(h);
  await apiJson(h, "POST", "streams/constructor/records", { records: [record("first")] });
  await sleep(20); expect(page.drain().some(m => m.t === "stream_record")).toBe(false);
  const replay = await page.request({ t: "stream_subscribe", stream: "constructor", after: 0 });
  expect(replay.batch.records[0].seq).toBe(1);
  await apiJson(h, "POST", "streams/constructor/records", { records: [record("second")] });
  expect((await page.next("stream_record")).record.seq).toBe(2);
});

it("enforces UTF-8, aggregate storage, and ingestion-rate budgets atomically", async () => {
  const h = await create({ listener: false }); await stream(h);
  expect((await api(h, "POST", "streams/training/records", { records: [record("unicode", "😀".repeat(17_000))] })).status).toBe(413);
  expect((await api(h, "POST", "streams/training/records", { records: Array.from({ length: 6 }, (_, i) => record(`large-${i}`, "x".repeat(50_000))) })).status).toBe(413);
  await inDO(h.id, t => {
    // Fill retained storage without conflating the separate per-minute budget.
    for (let i = 0; i < 170; i++) {
      if (i % 50 === 0) t.skew += 60_000;
      try { appendRecords(t, "training", { records: [record(`${i}`, "x".repeat(49_000))] }, "test"); }
      catch (error) { expect((error as any).code).toBe("quota"); break; }
    }
    const before = t.db.one<{ count: number; bytes: number }>("SELECT COUNT(*) AS count,SUM(bytes) AS bytes FROM stream_records")!;
    const latest = t.db.one<{ latest_seq: number }>("SELECT latest_seq FROM streams WHERE name='training'")!.latest_seq;
    expect(before.bytes).toBeLessThanOrEqual(MAX_STREAM_BYTES);
    expect(() => appendRecords(t, "training", { records: Array.from({ length: 4 }, (_, i) => record(`overflow-${i}`, "y".repeat(49_000))) }, "test")).toThrow();
    expect(t.db.one("SELECT COUNT(*) AS count,SUM(bytes) AS bytes FROM stream_records")).toEqual(before);
    expect(t.db.one("SELECT latest_seq FROM streams WHERE name='training'")).toEqual({ latest_seq: latest });
    expect(t.db.one("SELECT seq FROM stream_records WHERE id='overflow-0'")).toBeNull();
  });
  const rate = await create({ listener: false }); await stream(rate, "live", { durability: "ephemeral" });
  await inDO(rate.id, t => {
    for (let i = 0; i < 120; i++) appendRecords(t, "live", { records: [record(`${i}`)] }, "fast");
    expect(() => appendRecords(t, "live", { records: [record("limited")] }, "fast")).toThrow("Stream ingestion budget");
    expect(t.db.one("SELECT latest_seq FROM streams WHERE name='live'")).toEqual({ latest_seq: 120 });
  });
});

it("keeps existing service gates for producers and page publication", async () => {
  const h = await create({ listener: false }); await stream(h); const p = await producer(h), page = await connect(h);
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
  try {
    await publish(h, p.token, [record("read-only")], "training", 503);
    expect(await page.request({ t: "stream_publish", stream: "training", records: [record("page-read-only")] })).toMatchObject({ error: "read_only" });
  } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
  const account = await inDO(h.id, t => t.db.get<string>("owner_account", ""));
  await env.ACCOUNTS.prepare("UPDATE accounts SET suspended_at=? WHERE id=?").bind(Date.now(), account).run();
  await publish(h, p.token, [record("suspended")], "training", 403);
});

it("allows explicit dashboard publication without an agent listener and keeps interactive gating", async () => {
  const dashboard = await create({ mode: "dashboard", listener: false });
  expect((dashboard as any).mode).toBe("dashboard");
  expect((await api(dashboard, "PUT", "files/index.html", "<!doctype html><title>Dashboard</title>")).status).toBe(200);
  expect((await apiJson(dashboard, "GET", "")).agent_delivery.mode).toBe("none");
  const normal = await create({ listener: false });
  expect((await api(normal, "PUT", "files/index.html", "<!doctype html><title>Interactive</title>")).status).toBe(428);
  await stream(dashboard); const p = await producer(dashboard);
  await advance(dashboard.id, 86_000_000);
  await publish(dashboard, p.token, [record("keep-dashboard-alive")]);
  expect(await inDO(dashboard.id, t => t.expiresAt()! - t.now())).toBeGreaterThan(86_000_000);
});
