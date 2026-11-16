import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, ApiError } from "../client.mjs";
import { ContractError } from "../index.mjs";

const timer = { id: "timer-id", revision: 1, title: "Review", due_at: 1000, timezone: "UTC",
  missed: "fire_once", notify: false, state: "scheduled", created_at: 1, updated_at: 1 };

test("timer SDK preserves stable commands, reviewed revisions, and typed deletion receipts", async () => {
  const calls = [];
  const client = createClient({ api: "https://example.test/api/t/page", token: "private" }, { fetch: async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    const result = init.method === "DELETE" ? { id: timer.id, revision: 3, deleted: true }
      : init.method === "PATCH" ? { ...timer, revision: 2, state: "cancelled" } : timer;
    return new Response(JSON.stringify(result));
  } });
  const create = { cid: "create-once", expected_generations: { task: "generation" }, scope: "task", title: timer.title, due_at: timer.due_at };
  assert.deepEqual(await client.createTimer(create), timer);
  assert.deepEqual(await client.createTimer(create), timer);
  const edit = { cid: "cancel-once", expected_generations: { task: "generation" }, scope: "task", expected_revision: 1, state: "cancelled" };
  assert.equal((await client.updateTimer(timer.id, edit)).revision, 2);
  const remove = { cid: "delete-once", expected_generations: {}, expected_revision: 2 };
  assert.deepEqual(await client.deleteTimer(timer.id, remove), { id: timer.id, revision: 3, deleted: true });
  assert.deepEqual(calls, [
    { url: "https://example.test/api/t/page/timers", method: "POST", body: create },
    { url: "https://example.test/api/t/page/timers", method: "POST", body: create },
    { url: "https://example.test/api/t/page/timers/timer-id", method: "PATCH", body: edit },
    { url: "https://example.test/api/t/page/timers/timer-id", method: "DELETE", body: remove },
  ]);
  assert.throws(() => client.createTimer({ title: "No identity", due_at: 1 }), ContractError);
  assert.throws(() => client.updateTimer(timer.id, { cid: "missing-review", expected_generations: {}, state: "cancelled" }), ContractError);
  assert.throws(() => client.deleteTimer(timer.id), ContractError);
  assert.equal(calls.length, 4);
});

test("timer SDK exposes revision conflicts and refuses a missing deletion receipt", async () => {
  const command = { cid: "delete-once", expected_generations: {}, expected_revision: 1 };
  const stale = createClient({ api: "https://example.test", token: "private" }, { fetch: async () =>
    new Response(JSON.stringify({ error: { code: "timer_conflict", message: "Review the new revision", current: 2 } }), { status: 409 }) });
  await assert.rejects(stale.deleteTimer(timer.id, command), error => error instanceof ApiError && error.code === "timer_conflict" && error.error.current === 2);
  const missing = createClient({ api: "https://example.test", token: "private" }, { fetch: async () => new Response(null, { status: 204 }) });
  await assert.rejects(missing.deleteTimer(timer.id, command), error => error instanceof ApiError && error.code === "invalid_response");
});
