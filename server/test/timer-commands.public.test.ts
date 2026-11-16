import { expect, it } from "vitest";
import { assertValid, RESOURCE_LIMITS } from "../../contract/index.mjs";
import { registerScope, rotateScope } from "../src/scopes";
import { deleteTimer, listTimers, runTimers, saveTimer } from "../src/timers";
import { api, apiJson, advance, create, inDO, req } from "./helpers";

const command = (extra: Record<string, unknown> = {}) => ({ cid: crypto.randomUUID(), expected_generations: {}, ...extra });

it("recovers a lost creation reply without another timer, including after deletion and receipt quota", async () => {
  const h = await create();
  const body = command({ title: "Review once", due_at: Date.now() + 60000 });
  // The caller loses the response body after the server accepts the command.
  expect((await api(h, "POST", "timers", body)).status).toBe(201);
  await inDO(h.id, t => t.db.clearCache());
  const accepted = await apiJson(h, "POST", "timers", body, 201);
  assertValid("timer", accepted); expect(accepted.revision).toBe(1);
  expect((await apiJson(h, "GET", "timers")).timers).toEqual([accepted]);
  expect(await inDO(h.id, t => t.db.all("SELECT seq FROM activity WHERE kind='timer'"))).toHaveLength(1);
  expect(await inDO(h.id, t => t.db.all("SELECT cid FROM commands WHERE cid=?", body.cid))).toHaveLength(1);

  const remove = command({ expected_revision: accepted.revision });
  const deleted = await apiJson(h, "DELETE", `timers/${accepted.id}`, remove);
  expect(deleted).toEqual({ id: accepted.id, revision: 2, deleted: true });
  assertValid("timerDeleted", deleted);
  await inDO(h.id, t => t.db.run("UPDATE command_usage SET count=? WHERE id=1", RESOURCE_LIMITS.command_receipts));
  expect(await apiJson(h, "POST", "timers", body, 201)).toEqual(accepted);
  expect(await apiJson(h, "DELETE", `timers/${accepted.id}`, remove)).toEqual(deleted);
  expect((await apiJson(h, "GET", "timers")).timers).toEqual([]);
  expect(await inDO(h.id, t => t.db.all("SELECT seq FROM activity WHERE kind='timer'"))).toHaveLength(2);
  expect((await apiJson(h, "DELETE", `timers/${accepted.id}`, command({ expected_revision: 1 }), 429)).error.code).toBe("resource_quota");
});

it("rejects reuse of a command identity for a changed payload, operation, or timer", async () => {
  const h = await create(), now = Date.now();
  const first = command({ title: "First", due_at: now + 60000 });
  const timer = await apiJson(h, "POST", "timers", first, 201);
  const other = await apiJson(h, "POST", "timers", command({ title: "Other", due_at: now + 60000 }), 201);
  expect((await apiJson(h, "POST", "timers", { ...first, title: "Different" }, 409)).error.code).toBe("command_conflict");
  const edit = command({ expected_revision: 1, title: "Reviewed" });
  await apiJson(h, "PATCH", `timers/${timer.id}`, edit);
  expect((await apiJson(h, "PATCH", `timers/${other.id}`, edit, 409)).error.code).toBe("command_conflict");
  expect((await apiJson(h, "DELETE", `timers/${timer.id}`, { cid: edit.cid, expected_generations: {}, expected_revision: 2 }, 409)).error.code).toBe("command_conflict");
  expect((await apiJson(h, "GET", "timers")).timers.find((item: any) => item.id === other.id)).toEqual(other);
});

it("admits one competing edit and rejects stale deletion without changing the winner", async () => {
  const h = await create();
  const timer = await apiJson(h, "POST", "timers", command({ title: "Review", due_at: Date.now() + 60000 }), 201);
  const edits = ["First decision", "Second decision"].map(title => command({ expected_revision: timer.revision, title }));
  const responses = await Promise.all(edits.map(body => api(h, "PATCH", `timers/${timer.id}`, body)));
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = await responses.find(response => response.status === 200)!.json<any>();
  expect(winner.revision).toBe(2);
  const failed = await responses.find(response => response.status === 409)!.json<any>();
  expect(failed.error).toMatchObject({ code: "timer_conflict", current: 2 });
  expect((await apiJson(h, "DELETE", `timers/${timer.id}`, command({ expected_revision: 1 }), 409)).error.code).toBe("timer_conflict");
  expect((await apiJson(h, "GET", "timers")).timers).toEqual([winner]);
  expect(await inDO(h.id, t => t.db.all("SELECT seq FROM activity WHERE kind='timer'"))).toHaveLength(2);
  expect(await apiJson(h, "DELETE", `timers/${timer.id}`, command({ expected_revision: winner.revision }))).toEqual({ id: timer.id, revision: 3, deleted: true });
});

it.each([undefined, { every_minutes: 5 }])("advances the revision on an alarm transition for repeat %j", async repeat => {
  const h = await create(), now = await inDO(h.id, t => t.now());
  const original = command({ title: "Alarm transition", due_at: now + 1000, ...(repeat ? { repeat } : {}) });
  const timer = await apiJson(h, "POST", "timers", original, 201);
  await advance(h.id, 2000); await inDO(h.id, t => runTimers(t));
  const current = (await apiJson(h, "GET", "timers")).timers[0];
  expect(current.revision).toBe(2);
  expect(current.state).toBe(repeat ? "scheduled" : "completed");
  if (repeat) expect(current.due_at).toBeGreaterThan(timer.due_at);
  expect((await apiJson(h, "PATCH", `timers/${timer.id}`, command({ expected_revision: 1, state: "cancelled" }), 409)).error.code).toBe("timer_conflict");
  expect((await apiJson(h, "DELETE", `timers/${timer.id}`, command({ expected_revision: 1 }), 409)).error.code).toBe("timer_conflict");
  expect(await apiJson(h, "POST", "timers", original, 201)).toEqual(timer);
  expect((await apiJson(h, "PATCH", `timers/${timer.id}`, command({ expected_revision: current.revision, state: "cancelled" }))).revision).toBe(3);
});

it("requires bound generations while replaying previously accepted timer commands after rotation", async () => {
  const h = await create();
  const scope = await apiJson(h, "PUT", "scopes/schedule", command({ paths: [], operations: ["timer.write"] }));
  const settings = { title: "Guarded reminder", due_at: Date.now() + 60000 };
  expect((await apiJson(h, "POST", "timers", command(settings), 428)).error.code).toBe("generation_required");
  const original = command({ ...settings, scope: "schedule", expected_generations: { schedule: scope.generation } });
  const timer = await apiJson(h, "POST", "timers", original, 201);
  expect((await apiJson(h, "PATCH", `timers/${timer.id}`, command({ expected_revision: 1, title: "Missing guard" }), 428)).error.code).toBe("generation_required");
  expect((await apiJson(h, "DELETE", `timers/${timer.id}`, command({ expected_revision: 1 }), 428)).error.code).toBe("generation_required");
  const rotated = await inDO(h.id, t => rotateScope(t, "schedule"));
  expect(await apiJson(h, "POST", "timers", original, 201)).toEqual(timer);
  expect((await apiJson(h, "POST", "timers", { ...original, cid: crypto.randomUUID() }, 409)).error.code).toBe("stale_generation");
  const removed = await apiJson(h, "DELETE", `timers/${timer.id}`, command({ expected_revision: 1, expected_generations: { schedule: rotated.generation } }));
  expect(removed.deleted).toBe(true);
});

it("accepts timer guards for the complete active-scope allowance", async () => {
  const h = await create();
  const expected_generations = await inDO(h.id, t => Object.fromEntries(Array.from({ length: RESOURCE_LIMITS.active_scopes }, (_, i) => {
    const scope = registerScope(t, `timer-${i}-${"x".repeat(120)}`, { paths: [], operations: ["timer.write"] });
    return [scope.id, scope.generation];
  })));
  const body = command({ title: "Many active guards", due_at: Date.now() + 60000, expected_generations });
  expect(JSON.stringify(body).length).toBeGreaterThan(8192);
  expect((await apiJson(h, "POST", "timers", body, 201)).revision).toBe(1);
});

it("rolls back timer changes, notification cancellation, activity, and alarm effects when a receipt cannot commit", async () => {
  const h = await create();
  const original = command({ title: "Keep the reminder", due_at: Date.now() + 1000, notify: true });
  const timer = await apiJson(h, "POST", "timers", original, 201);
  await advance(h.id, 2000);
  await inDO(h.id, async t => {
    const notify = t.notify; t.notify = async () => { throw Error("temporary delivery failure"); };
    try { await runTimers(t); } finally { t.notify = notify; }
    const before = { timers: listTimers(t), notifications: t.db.all("SELECT * FROM timer_notifications"),
      activity: t.db.all("SELECT * FROM activity WHERE kind='timer'"), receipts: t.db.all("SELECT * FROM commands") };
    expect(before.notifications[0].state).toBe("pending");
    t.db.run("UPDATE command_usage SET count=? WHERE id=1", RESOURCE_LIMITS.command_receipts);
    const schedule = t.scheduleAlarm; let effects = 0;
    t.scheduleAlarm = () => t.afterCommit(() => { effects++; });
    try {
      expect(() => saveTimer(t, command({ title: "Rejected creation", due_at: t.now() + 60000 }), "agent:test")).toThrow("durable command receipt allowance");
      expect(() => saveTimer(t, command({ expected_revision: 2, state: "cancelled" }), "agent:test", timer.id)).toThrow("durable command receipt allowance");
      expect(() => deleteTimer(t, timer.id, command({ expected_revision: 2 }), "agent:test")).toThrow("durable command receipt allowance");
    } finally { t.scheduleAlarm = schedule; }
    expect({ timers: listTimers(t), notifications: t.db.all("SELECT * FROM timer_notifications"),
      activity: t.db.all("SELECT * FROM activity WHERE kind='timer'"), receipts: t.db.all("SELECT * FROM commands") }).toEqual(before);
    expect(effects).toBe(0);
  });
});

it("uses authenticated page and agent namespaces even when their names and command IDs match", async () => {
  const h = await create();
  const owner = await inDO(h.id, t => {
    const owner = t.db.get<string>("owner_account", "");
    t.db.run("UPDATE tokens SET name=?", owner); return owner;
  });
  const body = command({ title: "Same intent, different actor", due_at: Date.now() + 60000 });
  const agentTimer = await apiJson(h, "POST", "timers", body, 201);
  const pageCreate = () => req(h.page_url + "_tendril/timers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const response = await pageCreate(); expect(response.status).toBe(201);
  const pageTimer = await response.json<any>(); expect(pageTimer.id).not.toBe(agentTimer.id);
  expect(await (await pageCreate()).json()).toEqual(pageTimer);
  expect(await inDO(h.id, t => t.db.all("SELECT actor FROM commands WHERE cid=? ORDER BY actor", body.cid))).toEqual([{ actor: `agent:${owner}` }, { actor: `page:${owner}` }]);
});

it("rejects missing mutation identities and reviewed revisions at the public boundary", async () => {
  const h = await create(), settings = { title: "Explicit commands", due_at: Date.now() + 60000 };
  expect((await api(h, "POST", "timers", settings)).status).toBe(400);
  const timer = await apiJson(h, "POST", "timers", command(settings), 201);
  expect((await api(h, "PATCH", `timers/${timer.id}`, command({ title: "Unreviewed" }))).status).toBe(400);
  expect((await api(h, "DELETE", `timers/${timer.id}`, command())).status).toBe(400);
});
