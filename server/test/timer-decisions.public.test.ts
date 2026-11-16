import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { RESOURCE_LIMITS } from "../../contract/index.mjs";
import { HttpError } from "../src/http";
import { registerScope, rotateScope } from "../src/scopes";
import { deleteTimer, listTimers, runTimers, saveTimer } from "../src/timers";
import { api, apiJson, advance, create, inDO, signInAsOwner } from "./helpers";

const command = (extra: Record<string, unknown> = {}) => ({ cid: crypto.randomUUID(), expected_generations: {}, ...extra });

it("replays a lost timer-quota rejection after a slot opens and requires a new identity for new work", async () => {
  const h = await create();
  const timers = await inDO(h.id, t => Array.from({ length: 32 }, (_, i) =>
    saveTimer(t, command({ title: `Existing ${i}`, due_at: t.now() + 60000 }), "agent:seed")));
  const body = command({ title: "Wait for an open slot", due_at: Date.now() + 60000 });
  // A response lost before the caller can save it still has a server receipt.
  expect((await api(h, "POST", "timers", body)).status).toBe(429);
  await apiJson(h, "DELETE", `timers/${timers[0].id}`, command({ expected_revision: 1 }));
  const before = await inDO(h.id, t => ({ activity: t.db.all("SELECT * FROM activity WHERE kind='timer'"),
    usage: t.db.one("SELECT count,bytes FROM command_usage WHERE id=1") }));
  await inDO(h.id, t => t.db.clearCache());
  const rejected = await apiJson(h, "POST", "timers", body, 429);
  expect(rejected.error.code).toBe("quota");
  expect((await apiJson(h, "GET", "timers")).timers).toHaveLength(31);
  expect(await inDO(h.id, t => ({ activity: t.db.all("SELECT * FROM activity WHERE kind='timer'"),
    usage: t.db.one("SELECT count,bytes FROM command_usage WHERE id=1") }))).toEqual(before);
  expect((await apiJson(h, "POST", "timers", { ...body, title: "Changed rejected command" }, 409)).error.code).toBe("command_conflict");
  expect((await apiJson(h, "POST", "timers", { ...body, cid: crypto.randomUUID() }, 201)).revision).toBe(1);
  expect((await apiJson(h, "GET", "timers")).timers).toHaveLength(32);
});

it("retains the original lifetime rejection after lifetime extension and scope rotation", async () => {
  const h = await create();
  const scope = await inDO(h.id, t => registerScope(t, "schedule", { paths: [], operations: ["timer.write"] }));
  const body = command({ title: "Beyond today's lifetime", due_at: Date.now() + 365 * 86400000,
    expected_generations: { schedule: scope.generation } });
  const rejected = await apiJson(h, "POST", "timers", body, 409);
  expect(rejected.error).toMatchObject({ code: "lifetime_required", expires_at: expect.any(Number) });
  await inDO(h.id, t => t.db.set("lifetime", "resident"));
  // A fresh decision under the same still-current guard is now allowed.
  const accepted = await apiJson(h, "POST", "timers", { ...body, cid: crypto.randomUUID() }, 201);
  await inDO(h.id, t => { rotateScope(t, "schedule"); t.db.clearCache(); });
  expect(await apiJson(h, "POST", "timers", body, 409)).toEqual(rejected);
  expect((await apiJson(h, "GET", "timers")).timers).toEqual([accepted]);
  expect(await inDO(h.id, t => t.db.all("SELECT seq FROM activity WHERE kind='timer'"))).toHaveLength(1);
});

it("keeps an unclaimed decision after the owner claims the page", async () => {
  const email = `timer-owner-${crypto.randomUUID()}@example.com`;
  const h = await create({ claim: false, owner: email });
  const body = command({ title: "Review after claim", due_at: Date.now() + 60000 });
  const rejected = await apiJson(h, "POST", "timers", body, 403);
  expect(rejected.error.code).toBe("unclaimed");
  const account = crypto.randomUUID();
  await env.ACCOUNTS!.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(account, Date.now(), email).run();
  await signInAsOwner(h, account, email);
  expect(await apiJson(h, "POST", "timers", body, 403)).toEqual(rejected);
  expect((await apiJson(h, "GET", "timers")).timers).toEqual([]);
  expect((await apiJson(h, "POST", "timers", { ...body, cid: crypto.randomUUID() }, 201)).revision).toBe(1);
});

it("replays the original conflict revision even after later edits and removal", async () => {
  const h = await create();
  const timer = await apiJson(h, "POST", "timers", command({ title: "Initial", due_at: Date.now() + 60000 }), 201);
  await apiJson(h, "PATCH", `timers/${timer.id}`, command({ expected_revision: 1, title: "Winner" }));
  const staleEdit = command({ expected_revision: 1, title: "Old review" });
  const staleDelete = command({ expected_revision: 1 });
  const rejectedEdit = await apiJson(h, "PATCH", `timers/${timer.id}`, staleEdit, 409);
  const rejectedDelete = await apiJson(h, "DELETE", `timers/${timer.id}`, staleDelete, 409);
  expect(rejectedEdit.error).toMatchObject({ code: "timer_conflict", current: 2 });
  expect(rejectedDelete).toEqual(rejectedEdit);
  await apiJson(h, "PATCH", `timers/${timer.id}`, command({ expected_revision: 2, title: "Later" }));
  await apiJson(h, "DELETE", `timers/${timer.id}`, command({ expected_revision: 3 }));
  expect(await apiJson(h, "PATCH", `timers/${timer.id}`, staleEdit, 409)).toEqual(rejectedEdit);
  expect(await apiJson(h, "DELETE", `timers/${timer.id}`, staleDelete, 409)).toEqual(rejectedDelete);
  const missing = command({ expected_revision: 4 });
  const rejectedMissing = await apiJson(h, "DELETE", `timers/${timer.id}`, missing, 404);
  expect(rejectedMissing.error.code).toBe("not_found");
  await inDO(h.id, t => t.db.run("UPDATE command_usage SET count=? WHERE id=1", RESOURCE_LIMITS.command_receipts));
  expect(await apiJson(h, "DELETE", `timers/${timer.id}`, missing, 404)).toEqual(rejectedMissing);
  expect(await inDO(h.id, t => t.db.all("SELECT seq FROM activity WHERE kind='timer'"))).toHaveLength(4);
});

it("retains already-fired and semantic bad-request decisions without rewriting timers", async () => {
  const h = await create();
  const invalid = command({ title: "Invalid zone", due_at: Date.now() + 60000, timezone: "Not/A_Zone" });
  const rejectedInvalid = await apiJson(h, "POST", "timers", invalid, 400);
  expect(rejectedInvalid.error.code).toBe("bad_request");
  expect(await apiJson(h, "POST", "timers", invalid, 400)).toEqual(rejectedInvalid);
  expect((await apiJson(h, "POST", "timers", { ...invalid, timezone: "UTC" }, 409)).error.code).toBe("command_conflict");
  const timer = await apiJson(h, "POST", "timers", command({ title: "One occurrence", due_at: Date.now() + 1000 }), 201);
  await advance(h.id, 2000); await inDO(h.id, t => runTimers(t));
  const restart = command({ expected_revision: 2, state: "scheduled" });
  const rejectedRestart = await apiJson(h, "PATCH", `timers/${timer.id}`, restart, 409);
  expect(rejectedRestart.error.code).toBe("already_fired");
  const revised = await apiJson(h, "PATCH", `timers/${timer.id}`, command({ expected_revision: 2, state: "scheduled", due_at: Date.now() + 60000 }));
  expect(await apiJson(h, "PATCH", `timers/${timer.id}`, restart, 409)).toEqual(rejectedRestart);
  expect((await apiJson(h, "GET", "timers")).timers).toEqual([revised]);
  expect(await inDO(h.id, t => t.db.all("SELECT cid FROM commands WHERE cid IN (?,?)", invalid.cid, restart.cid))).toHaveLength(2);
});

it("rolls back partial timer writes and effects before committing their rejection receipt", async () => {
  const h = await create();
  const timer = await apiJson(h, "POST", "timers", command({ title: "Keep pending notification", due_at: Date.now() + 1000, notify: true }), 201);
  await advance(h.id, 2000);
  await inDO(h.id, async t => {
    const notify = t.notify; t.notify = async () => { throw Error("temporary provider failure"); };
    try { await runTimers(t); } finally { t.notify = notify; }
    const snapshot = () => ({ timers: listTimers(t), notifications: t.db.all("SELECT * FROM timer_notifications"),
      activity: t.db.all("SELECT * FROM activity WHERE kind='timer'") });
    const before = snapshot(); expect(before.notifications[0].state).toBe("pending");
    const usage = t.db.one<{ count: number }>("SELECT count FROM command_usage WHERE id=1")!;
    const edit = command({ expected_revision: 2, state: "cancelled" });
    const remove = command({ expected_revision: 2 });
    const schedule = t.scheduleAlarm; let effects = 0;
    t.scheduleAlarm = () => {
      t.afterCommit(() => { effects++; });
      throw new HttpError(400, "bad_request", "Injected decision after writes", { detail: "saved" });
    };
    try {
      expect(() => saveTimer(t, edit, "agent:rollback", timer.id)).toThrow("Injected decision after writes");
      expect(() => deleteTimer(t, timer.id, remove, "agent:rollback")).toThrow("Injected decision after writes");
    } finally { t.scheduleAlarm = schedule; }
    expect(snapshot()).toEqual(before);
    expect(effects).toBe(0);
    expect(t.db.one<{ count: number }>("SELECT count FROM command_usage WHERE id=1")!.count).toBe(usage.count + 2);
    t.db.clearCache();
    expect(() => saveTimer(t, edit, "agent:rollback", timer.id)).toThrow("Injected decision after writes");
    expect(() => deleteTimer(t, timer.id, remove, "agent:rollback")).toThrow("Injected decision after writes");
    expect(snapshot()).toEqual(before);
    const receipts = t.db.all<{ result: string }>("SELECT result FROM commands WHERE actor='agent:rollback'");
    expect(receipts.map(row => JSON.parse(row.result))).toEqual(Array.from({ length: 2 }, () => ({ status: "rejected",
      error: { status: 400, code: "bad_request", message: "Injected decision after writes", extra: { detail: "saved" } } })));
  });
});

it("distinguishes receipt-capacity failure from a durable timer-domain decision", async () => {
  const h = await create();
  const body = command({ title: "Cannot yet record the decision", due_at: Date.now() + 365 * 86400000 });
  const usage = await inDO(h.id, t => {
    const usage = t.db.one<{ count: number; bytes: number }>("SELECT count,bytes FROM command_usage WHERE id=1")!;
    t.db.run("UPDATE command_usage SET count=? WHERE id=1", RESOURCE_LIMITS.command_receipts); return usage;
  });
  const rejected = await apiJson(h, "POST", "timers", body, 429);
  expect(rejected.error.code).toBe("resource_quota");
  expect(await inDO(h.id, t => t.db.all("SELECT cid FROM commands WHERE cid=?", body.cid))).toEqual([]);
  expect((await apiJson(h, "GET", "timers")).timers).toEqual([]);
  expect(await inDO(h.id, t => t.db.all("SELECT seq FROM activity WHERE kind='timer'"))).toEqual([]);
  await inDO(h.id, t => {
    t.db.run("UPDATE command_usage SET count=?,bytes=? WHERE id=1", usage.count, usage.bytes);
    t.db.set("lifetime", "resident");
  });
  // The failed receipt write did not decide this identity. Here storage is restored
  // by the test fixture; production receipt exhaustion requires a fresh page.
  expect((await apiJson(h, "POST", "timers", body, 201)).revision).toBe(1);
});

it("does not record pre-dispatch authorization, malformed envelopes, or generation failures", async () => {
  const h = await create();
  const body = command({ title: "Valid once the boundary accepts it", due_at: Date.now() + 60000 });
  const denied = await api(h, "POST", "timers", body, {}, "tk_invalid");
  expect(denied.status).toBe(401);
  expect((await api(h, "POST", "timers", { ...body, expected_generations: undefined })).status).toBe(400);
  const scope = await inDO(h.id, t => registerScope(t, "schedule", { paths: [], operations: ["timer.write"] }));
  expect((await apiJson(h, "POST", "timers", body, 428)).error.code).toBe("generation_required");
  expect(await inDO(h.id, t => t.db.all("SELECT cid FROM commands WHERE cid=?", body.cid))).toEqual([]);
  expect((await apiJson(h, "POST", "timers", { ...body, expected_generations: { schedule: scope.generation } }, 201)).revision).toBe(1);
});
