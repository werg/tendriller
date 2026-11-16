import { beforeAll, expect, inject, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { assertValid } from "../../contract/index.mjs";
import { addEvent } from "../src/events";
import { runTimers, saveTimer, deleteTimer, timerHistory } from "../src/timers";
import { nextNotificationDeadline, pruneTimerHistory, runTimerNotifications } from "../src/timer-notifications";
import { HttpError } from "../src/http";
import { api, apiJson, advance, inDO, req, type Handle } from "./helpers";

beforeAll(async () => {
  await applyD1Migrations(env.ACCOUNTS, inject("d1Migrations"));
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run();
});
const command = (extra: Record<string, unknown> = {}) => ({ cid: crypto.randomUUID(), expected_generations: {}, ...extra });
let index = 0;
async function setup() {
  const account = crypto.randomUUID(), email = `${account}@example.com`;
  const response = await req("/api/tendrils", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${++index}` }, body: JSON.stringify({ owner: email }) });
  expect(response.status).toBe(201); const handle = await response.json<Handle>();
  await env.ACCOUNTS.prepare("INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)").bind(account, email, Date.now() - 30 * 86400000).run();
  await env.ACCOUNTS.prepare("UPDATE tendrils SET owner_account=?,claimed_at=? WHERE id=?").bind(account, Date.now(), handle.id).run();
  await inDO(handle.id, t => { t.db.set("owner_account", account); t.db.set("claimed_at", t.now()); });
  return { handle, account };
}
async function inputs(h: Handle, count = 3) {
  return inDO(h.id, t => Array.from({ length: count }, (_, n) => addEvent(t, { type: "event", data: { observation: n }, wake: false }).seq));
}
async function leased(h: Handle, token: string, method: string, path: string, body?: unknown, status = 200) {
  const response = await api(h, method, path, body, { "X-Tendril-Lease": token });
  const value = await response.json<any>(); expect(response.status, JSON.stringify(value)).toBe(status); return value;
}
async function timer(h: Handle, overrides: Record<string, unknown> = {}) {
  const now = await inDO(h.id, t => t.now());
  return apiJson(h, "POST", "timers", { ...command(), title: "Durable reminder", due_at: now + 1000, notify: true, ...overrides }, 201);
}
async function dueRetry(h: Handle) {
  await inDO(h.id, t => { const next = nextNotificationDeadline(t); if (next !== null) t.skew += Math.max(0, next - t.now()) + 1; });
}
async function fireFailing(h: Handle) {
  await advance(h.id, 2000);
  await inDO(h.id, async t => {
    const sender = t.notify; t.notify = async () => { throw Error("temporary push outage"); };
    try { await runTimers(t); } finally { t.notify = sender; }
  });
}
// Simulate process loss immediately after the run transaction commits, before
// the first attempt can start. This is the crash gap the outbox closes.
async function crashAfterRun(h: Handle) {
  await advance(h.id, 2000);
  await inDO(h.id, async t => {
    const schedule = t.scheduleAlarm;
    t.scheduleAlarm = () => {
      if (t.db.one("SELECT run_id FROM timer_notifications WHERE state='pending'")) throw Error("simulated worker termination after commit");
      schedule.call(t);
    };
    try { await expect(runTimers(t)).rejects.toThrow("simulated worker termination"); } finally { t.scheduleAlarm = schedule; }
  });
}

it("exclusively claims one named consumer while different names remain independent", async () => {
  const { handle: h } = await setup(); await inputs(h);
  const responses = await Promise.all(["worker-a", "worker-b"].map(holder => api(h, "POST", "consumers/main/claim", { holder, ttl_seconds: 30 })));
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const winner = await responses.find(r => r.status === 200)!.json<any>(); assertValid("consumerLease", winner);
  const second = await apiJson(h, "POST", "consumers/audit/claim", { holder: "audit-worker" });
  const one = await leased(h, winner.lease_token, "GET", "consumers/main/events");
  const two = await leased(h, second.lease_token, "GET", "consumers/audit/events");
  expect(one.events).toEqual(two.events); expect(one.consumer.handled_seq).toBe(0); assertValid("consumerBatch", one);
  const listing = await apiJson(h, "GET", "consumers");
  expect(listing.consumers).toHaveLength(2);
  expect(JSON.stringify(listing)).not.toContain(winner.lease_token); expect(JSON.stringify(listing)).not.toContain("lease_hash");
});

it("replays after a crashed holder expires and fences its old acknowledgements", async () => {
  const { handle: h } = await setup(), seq = await inputs(h);
  const first = await apiJson(h, "POST", "consumers/main/claim", { holder: "before-crash", ttl_seconds: 30 });
  expect((await leased(h, first.lease_token, "GET", "consumers/main/events")).events.map((e: any) => e.seq)).toEqual(seq);
  // A read is not a handled acknowledgement, including after a cache/isolate reload.
  await inDO(h.id, t => t.db.clearCache()); await advance(h.id, 31000);
  await leased(h, first.lease_token, "POST", "consumers/main/ack", { through: seq[2] }, 409);
  await leased(h, first.lease_token, "POST", "consumers/main/renew", {}, 409);
  const second = await apiJson(h, "POST", "consumers/main/claim", { holder: "replacement" });
  expect(second.consumer.generation).toBe(2);
  expect((await leased(h, second.lease_token, "GET", "consumers/main/events")).events.map((e: any) => e.seq)).toEqual(seq);
  await leased(h, first.lease_token, "POST", "consumers/main/release", undefined, 409);
  const acknowledged = await leased(h, second.lease_token, "POST", "consumers/main/ack", { through: seq[1] });
  expect(acknowledged.consumer.handled_seq).toBe(seq[1]);
  await leased(h, second.lease_token, "POST", "consumers/main/release");
  const third = await apiJson(h, "POST", "consumers/main/claim", { holder: "next-worker" });
  expect((await leased(h, third.lease_token, "GET", "consumers/main/events")).events.map((e: any) => e.seq)).toEqual([seq[2]]);
  // Legacy reads and their global transport cursor retain their old behavior.
  expect((await apiJson(h, "GET", "events?after=0")).events.map((e: any) => e.seq)).toEqual(seq);
  expect((await apiJson(h, "GET", "consumers")).consumers[0].handled_seq).toBe(seq[1]);
});

it("bounds acknowledgements to the current lease's observed range and permits partial progress", async () => {
  const { handle: h } = await setup(), seq = await inputs(h);
  const claim = await apiJson(h, "POST", "consumers/main/claim", { holder: "worker" });
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[0] }, 400);
  expect((await leased(h, claim.lease_token, "GET", "consumers/main/events?limit=2")).events).toHaveLength(2);
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[2] }, 400);
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[0] });
  expect((await leased(h, claim.lease_token, "GET", "consumers/main/events")).events.map((e: any) => e.seq)).toEqual(seq.slice(1));
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: 0 }, 409);
  // Deleting retained rows after a successful read does not make those already
  // delivered bytes unseen: a worker may acknowledge work it actually finished.
  await inDO(h.id, t => t.db.run("DELETE FROM events"));
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[2] });
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[2] });
  expect((await api(h, "GET", "consumers/main/events")).status).toBe(401);
  await leased(h, "cl_" + "a".repeat(40), "GET", "consumers/main/events", undefined, 409);
});

it("renews leases, makes release idempotent, and preserves the checkpoint on reassignment", async () => {
  const { handle: h } = await setup(); await inputs(h, 1);
  const claim = await apiJson(h, "POST", "consumers/main/claim", { holder: "worker", ttl_seconds: 30 });
  await advance(h.id, 20000);
  const renewed = await leased(h, claim.lease_token, "POST", "consumers/main/renew", { ttl_seconds: 60 });
  expect(renewed.consumer.lease.expires_at).toBeGreaterThan(claim.consumer.lease.expires_at);
  await advance(h.id, 20000);
  expect((await api(h, "POST", "consumers/main/claim", { holder: "other" })).status).toBe(409);
  await leased(h, claim.lease_token, "POST", "consumers/main/release");
  expect((await leased(h, claim.lease_token, "POST", "consumers/main/release")).consumer.lease).toBeNull();
  const replacement = await apiJson(h, "POST", "consumers/main/claim", { holder: "other" });
  expect(replacement.consumer.handled_seq).toBe(0);
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: 0 }, 409);
});

it("requires explicit acknowledgement of missing history, including when every row expired", async () => {
  const { handle: h } = await setup(), seq = await inputs(h);
  await inDO(h.id, t => t.db.run("DELETE FROM events"));
  const claim = await apiJson(h, "POST", "consumers/main/claim", { holder: "resumed" });
  const batch = await leased(h, claim.lease_token, "GET", "consumers/main/events");
  expect(batch).toMatchObject({ events: [], cursor: 0, history: { earliest_available_seq: null, latest_seq: seq[2], gap: true, missing_through: seq[2] } });
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[2] }, 409);
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[2] + 1, gap_acknowledged: true }, 400);
  expect((await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[2], gap_acknowledged: true })).consumer.handled_seq).toBe(seq[2]);
  const [next] = await inputs(h, 1);
  const resumed = await leased(h, claim.lease_token, "GET", "consumers/main/events");
  expect(resumed.history.gap).toBe(false); expect(resumed.cursor).toBe(next);
});

it("does not demand gap acknowledgement before a gap or silently acknowledge a later gap", async () => {
  const { handle: h } = await setup(), seq = await inputs(h);
  await inDO(h.id, t => t.db.run("DELETE FROM events WHERE seq=?", seq[1]));
  const claim = await apiJson(h, "POST", "consumers/main/claim", { holder: "worker" });
  const batch = await leased(h, claim.lease_token, "GET", "consumers/main/events");
  expect(batch.history).toMatchObject({ gap: true, missing_through: seq[1] });
  // Replaying a smaller batch cannot erase an already observed gap while
  // preserving the old delivered ceiling, or ack would silently skip it.
  const smaller = await leased(h, claim.lease_token, "GET", "consumers/main/events?limit=1");
  expect(smaller.cursor).toBe(seq[0]); expect(smaller.history.gap).toBe(true);
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[2] }, 409);
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[0] });
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[2] }, 409);
  await leased(h, claim.lease_token, "POST", "consumers/main/ack", { through: seq[2], gap_acknowledged: true });
});

it("validates consumer bounds, caps names, and does not let a claim overwrite a checkpoint", async () => {
  const { handle: h } = await setup(); await inputs(h, 1);
  for (const body of [{ holder: " " }, { holder: "w", ttl_seconds: 29 }, { holder: "w", ttl_seconds: 901 }, { holder: "w", after: 2 }, { holder: "w", after: -1 }])
    expect((await api(h, "POST", "consumers/main/claim", body)).status).toBe(400);
  const claim = await apiJson(h, "POST", "consumers/main/claim", { holder: "w", after: 1 });
  await leased(h, claim.lease_token, "GET", "consumers/main/events?limit=501", undefined, 400);
  await leased(h, claim.lease_token, "GET", "consumers/main/events?after=0", undefined, 400);
  await leased(h, claim.lease_token, "POST", "consumers/main/release");
  expect((await api(h, "POST", "consumers/main/claim", { holder: "w", after: 0 })).status).toBe(409);
  for (let n = 1; n < 16; n++) await apiJson(h, "POST", `consumers/reader-${n}/claim`, { holder: "w" });
  expect((await api(h, "POST", "consumers/overflow/claim", { holder: "w" })).status).toBe(429);
});

it("MCP uses the same processing lease proof, validation and handled checkpoint", async () => {
  const { handle: h } = await setup(), seq = await inputs(h, 1);
  const rpc = (name: string, args: unknown = {}) => apiJson(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const claim = (await rpc("claim_event_consumer", { name: "main", holder: "mcp-worker" })).result.structuredContent;
  const proof = { name: "main", lease_token: claim.lease_token };
  expect((await rpc("read_consumer_events", proof)).result.structuredContent.events[0].seq).toBe(seq[0]);
  expect((await rpc("renew_event_consumer", { ...proof, ttl_seconds: 901 })).error.code).toBe(-32602);
  const ack = await rpc("acknowledge_consumer_events", { ...proof, through: seq[0] });
  expect(ack.result.structuredContent.consumer.handled_seq).toBe(seq[0]);
  expect((await rpc("release_event_consumer", proof)).result.structuredContent.consumer.lease).toBeNull();
});

it("commits the timer occurrence and notification intent atomically", async () => {
  const { handle: h } = await setup(); await timer(h); await advance(h.id, 2000);
  await inDO(h.id, async t => {
    const run = t.db.run;
    t.db.run = (sql, ...args) => { if (sql.startsWith("INSERT OR IGNORE INTO timer_notifications")) throw Error("storage fault"); run.call(t.db, sql, ...args); };
    try { await expect(runTimers(t)).rejects.toThrow("storage fault"); } finally { t.db.run = run; }
    expect(t.db.all("SELECT * FROM timer_runs")).toHaveLength(0);
    expect(t.db.all("SELECT * FROM timer_notifications")).toHaveLength(0);
    expect(t.db.all("SELECT * FROM events WHERE type='event'")).toHaveLength(0);
    const sender = t.notify; t.notify = async () => ({ sent: 1, failed: 0, deliveries: [{ device: "phone", ok: true, status: 201, gone: false }] });
    try { await runTimers(t); } finally { t.notify = sender; }
    expect(timerHistory(t)).toHaveLength(1); expect(timerHistory(t)[0].delivery?.state).toBe("sent");
  });
});

it("recovers the crash gap after a run commits and before a notification attempt starts", async () => {
  const { handle: h } = await setup(), created = await timer(h); await crashAfterRun(h);
  await inDO(h.id, async t => {
    expect(timerHistory(t)[0].delivery).toMatchObject({ state: "pending", attempts: 0 });
    const calls: any[] = [], sender = t.notify;
    t.notify = async payload => { calls.push(payload); return { sent: 1, failed: 0, deliveries: [{ device: "phone", ok: true, status: 201, gone: false }] }; };
    try { await runTimerNotifications(t); await runTimers(t); await runTimerNotifications(t); } finally { t.notify = sender; }
    expect(calls).toHaveLength(1); expect(calls[0].tag).toBe(`${created.id}:${created.due_at}`);
    expect(timerHistory(t)[0].delivery).toMatchObject({ state: "sent", attempts: 1 });
    expect(t.db.all("SELECT * FROM events WHERE type='event'")).toHaveLength(1);
  });
});

it("reclaims an interrupted sending attempt after its lease expires", async () => {
  const { handle: h } = await setup(); await timer(h); await crashAfterRun(h);
  await inDO(h.id, async t => {
    const schedule = t.scheduleAlarm;
    t.scheduleAlarm = () => { if (t.db.one("SELECT run_id FROM timer_notifications WHERE state='sending'")) throw Error("crash before transport"); schedule.call(t); };
    try { await expect(runTimerNotifications(t)).rejects.toThrow("crash before transport"); } finally { t.scheduleAlarm = schedule; }
    expect(timerHistory(t)[0].delivery).toMatchObject({ state: "sending", attempts: 1 });
    const sender = t.notify; let calls = 0; t.notify = async () => { calls++; return { sent: 1, failed: 0, deliveries: [{ device: "phone", ok: true, status: 201, gone: false }] }; };
    try { await runTimerNotifications(t); expect(calls).toBe(0); t.skew += 61000; await runTimerNotifications(t); } finally { t.notify = sender; }
    expect(calls).toBe(1); expect(timerHistory(t)[0].delivery).toMatchObject({ state: "sent", attempts: 2 });
  });
});

it("retries the same run tag after acceptance is lost before receipt commit without claiming exactly-once push", async () => {
  const { handle: h } = await setup(); await timer(h); await crashAfterRun(h);
  await inDO(h.id, async t => {
    const run = t.db.run, sender = t.notify, tags: string[] = [];
    t.notify = async payload => { tags.push(payload.tag!); return { sent: 1, failed: 0, deliveries: [{ device: "phone", ok: true, status: 201, gone: false }] }; };
    t.db.run = (sql, ...args) => { if (sql.startsWith("UPDATE timer_notifications SET state=?")) throw Error("crash after provider acceptance"); run.call(t.db, sql, ...args); };
    try { await expect(runTimerNotifications(t)).rejects.toThrow("crash after provider acceptance"); } finally { t.db.run = run; }
    try { t.skew += 61000; await runTimerNotifications(t); } finally { t.notify = sender; }
    expect(tags).toHaveLength(2); expect(tags[0]).toBe(tags[1]);
    expect(t.db.all("SELECT * FROM timer_runs")).toHaveLength(1); expect(t.db.all("SELECT * FROM events WHERE type='event'")).toHaveLength(1);
    expect(timerHistory(t)[0].delivery?.attempts).toBe(2);
  });
});

it("backs off transient failures and retries only the devices not yet accepted", async () => {
  const { handle: h } = await setup(); await timer(h); await crashAfterRun(h);
  await inDO(h.id, async t => {
    const sender = t.notify; const calls: any[] = [];
    t.notify = async (payload, _by, options) => {
      calls.push({ payload, options });
      return calls.length === 1
        ? { sent: 1, failed: 1, deliveries: [{ device: "phone", ok: true, status: 201, gone: false }, { device: "tablet", ok: false, status: 503, gone: false }] }
        : { sent: 1, failed: 0, deliveries: [{ device: "tablet", ok: true, status: 201, gone: false }] };
    };
    try {
      await runTimerNotifications(t); const first = timerHistory(t)[0].delivery!;
      expect(first).toMatchObject({ state: "pending", attempts: 1, sent: 1, failed: 1 });
      expect(first.next_attempt_at! - t.now()).toBeGreaterThan(9000);
      await runTimerNotifications(t); expect(calls).toHaveLength(1);
      t.skew += 10001; await runTimerNotifications(t);
    } finally { t.notify = sender; }
    expect(calls[1].options.devices).toEqual(["tablet"]); expect(calls[1].options.broadcastLocal).toBe(false);
    expect(calls[1].payload.tag).toBe(calls[0].payload.tag);
    expect(timerHistory(t)[0].delivery).toMatchObject({ state: "sent", attempts: 2, sent: 2, failed: 0, next_attempt_at: null, last_error: null });
  });
});

it.each(["revoked", "demoted"])("does not retry a %s push subscription", async state => {
  const { handle: h } = await setup(); await timer(h); await crashAfterRun(h);
  await inDO(h.id, async t => {
    const sender = t.notify;
    t.notify = async () => ({ sent: 0, failed: 1, deliveries: [{ device: "old-device", ok: false, status: 503, gone: false }] });
    try { await runTimerNotifications(t); } finally { t.notify = sender; }
    if (state === "demoted") {
      t.db.run("INSERT INTO devices(id,secret_hash,role,pending,created_at) VALUES('old-device','unused','guest',0,?)", t.now());
      t.db.run("INSERT INTO push_subs(device,sub,created_at) VALUES('old-device','{}',?)", t.now());
    }
    t.skew += 10001; await runTimerNotifications(t);
    expect(timerHistory(t)[0].delivery).toMatchObject({ state: "unavailable", attempts: 2, sent: 0 });
    expect(nextNotificationDeadline(t)).toBeNull();
  });
});

it.each(["cancel", "delete", "reschedule"])("fences an in-flight notification after timer %s", async change => {
  const { handle: h } = await setup(), created = await timer(h); await crashAfterRun(h);
  await inDO(h.id, async t => {
    const sender = t.notify;
    t.notify = async () => {
      if (change === "delete") deleteTimer(t, created.id, command({ expected_revision: created.revision + 1 }), "page:owner");
      else saveTimer(t, command({ expected_revision: created.revision + 1, ...(change === "cancel" ? { state: "cancelled" } : { state: "scheduled", due_at: t.now() + 60000 }) }), "page:owner", created.id);
      return { sent: 1, failed: 0, deliveries: [{ device: "phone", ok: true, status: 201, gone: false }] };
    };
    try { await runTimerNotifications(t); } finally { t.notify = sender; }
    expect(timerHistory(t)[0].delivery).toMatchObject({ state: "cancelled", attempts: 1 });
    expect(nextNotificationDeadline(t)).toBeNull();
  });
});

it("caps transient retries and records notification quota backoff", async () => {
  const { handle: h } = await setup(); await timer(h); await fireFailing(h);
  await inDO(h.id, async t => {
    const sender = t.notify; t.notify = async () => { throw Error("still unavailable"); };
    try { for (let i = 0; i < 8; i++) { const due = nextNotificationDeadline(t); if (due !== null) t.skew += Math.max(0, due - t.now()) + 1; await runTimerNotifications(t); } }
    finally { t.notify = sender; }
    expect(timerHistory(t)[0].delivery).toMatchObject({ state: "failed", attempts: 6, next_attempt_at: null });
  });
  const { handle: rateLimited } = await setup(); await timer(rateLimited); await crashAfterRun(rateLimited);
  await inDO(rateLimited.id, async t => {
    const sender = t.notify; t.notify = async () => { throw new HttpError(429, "quota"); };
    try { await runTimerNotifications(t); } finally { t.notify = sender; }
    const delivery = timerHistory(t)[0].delivery!;
    expect(delivery.state).toBe("pending"); expect(delivery.next_attempt_at).toBe((Math.floor(t.now() / 3600000) + 1) * 3600000 + 1);
  });
});

it("rechecks service/account/page gates when retrying an already-fired timer", async () => {
  const { handle: h, account } = await setup(); await timer(h); await fireFailing(h); await dueRetry(h);
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
  try { await inDO(h.id, t => runTimerNotifications(t)); }
  finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
  expect(await inDO(h.id, t => timerHistory(t)[0].delivery?.attempts)).toBe(1);
  await dueRetry(h);
  await env.ACCOUNTS.prepare("UPDATE accounts SET suspended_at=? WHERE id=?").bind(Date.now(), account).run();
  await inDO(h.id, t => runTimerNotifications(t));
  expect(await inDO(h.id, t => timerHistory(t)[0].delivery)).toMatchObject({ state: "cancelled", attempts: 1 });
  const { handle: expired } = await setup(); await timer(expired); await fireFailing(expired);
  await inDO(expired.id, async t => { t.skew += t.expiresAt()! - t.now() + 1; await runTimerNotifications(t); expect(timerHistory(t)[0].delivery?.state).toBe("cancelled"); });
});

it("cancels queued notification attempts when a page is held and does not resurrect them on release", async () => {
  const { handle: h } = await setup(); await timer(h); await fireFailing(h);
  await inDO(h.id, async t => {
    const setHeld = (disabled: boolean) => t.fetch(new Request("https://internal/abuse/state", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ disabled }),
    }));
    expect((await setHeld(true)).status).toBe(200);
    expect(timerHistory(t)[0].delivery).toMatchObject({ state: "cancelled", attempts: 1 });
    expect((await setHeld(false)).status).toBe(200);
    const sender = t.notify; let calls = 0;
    t.notify = async () => { calls++; return { sent: 1, failed: 0, deliveries: [{ device: "phone", ok: true, status: 201, gone: false }] }; };
    try { t.skew += 120_000; await runTimerNotifications(t); } finally { t.notify = sender; }
    expect(calls).toBe(0);
    expect(timerHistory(t)[0].delivery?.state).toBe("cancelled");
  });
});

it("keeps pending run receipts while bounding completed timer history", async () => {
  const { handle: h } = await setup(); await timer(h); await crashAfterRun(h);
  await inDO(h.id, t => {
    const pending = timerHistory(t)[0].id;
    for (let n = 0; n < 250; n++) t.db.run("INSERT INTO timer_runs(id,timer_id,scheduled_at,fired_at,status) VALUES(?,?,?,?,?)", `old-${n}`, "old", n, t.now() + n + 1, "fired");
    pruneTimerHistory(t);
    expect(t.db.all("SELECT id FROM timer_runs")).toHaveLength(201);
    expect(t.db.one("SELECT id FROM timer_runs WHERE id=?", pending)).not.toBeNull();
    expect(t.db.one("SELECT run_id FROM timer_notifications WHERE run_id=?", pending)).not.toBeNull();
  });
});
