import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, validate, ContractError } from "../index.mjs";
import { createClient, ApiError } from "../client.mjs";

const token = "cl_" + "a".repeat(40);
const consumer = { name: "main", handled_seq: 0, delivered_seq: 1, generation: 1,
  lease: { holder: "worker-1", expires_at: 90_000 }, created_at: 1, updated_at: 2 };
const event = { seq: 1, ts: 1, type: "event", data: { observation: "leaf" }, device: null, role: null, by: null, wake: false };
const batch = { consumer, events: [event], cursor: 1,
  history: { earliest_available_seq: 1, latest_seq: 1, gap: false, missing_through: null } };

test("leased event contracts bound ownership and validate actual nested events", () => {
  for (const name of ["main", "reply-worker.v2", "audit_1"]) assertValid("consumerName", name);
  for (const name of ["", "a/b", "a".repeat(65), " secret"]) assert.ok(validate("consumerName", name).length);
  for (const body of [{ holder: "worker", ttl_seconds: 29 }, { holder: "worker", ttl_seconds: 901 }, { holder: "worker", after: -1 }, { holder: "worker", after: Number.MAX_SAFE_INTEGER + 1 }, { holder: "worker", unrecognised: true }])
    assert.ok(validate("consumerClaim", body).length);
  assertValid("consumerLease", { consumer, lease_token: token });
  assertValid("consumerBatch", batch);
  assertValid("consumerBatch", { ...batch, events: [], cursor: 0, history: { earliest_available_seq: null, latest_seq: 1, gap: true, missing_through: 1 } });
  assert.ok(validate("consumerBatch", { ...batch, events: [{ ...event, role: "admin" }] }).length, "local event $ref must validate the nested contract");
  assert.ok(validate("consumerBatch", { ...batch, events: [{ data: {} }] }).length);
  assert.ok(validate("consumerAck", { through: 1, gap_acknowledged: "true" }).length);
  assert.ok(validate("consumer", { ...consumer, lease_token: token }).length, "listing shape must never include the private proof");
});

test("typed consumer client sends lease proof only in headers and requires explicit handled acknowledgements", async () => {
  const seen = [];
  const client = createClient({ api: "https://example.test/api/t/id/", token: "tk_private" }, {
    fetch: async (url, options) => {
      seen.push({ url, options });
      const value = url.endsWith("/claim") ? { consumer, lease_token: token }
        : url.includes("/events?") ? batch
        : url.endsWith("/consumers") ? { consumers: [consumer] } : { consumer };
      return Response.json(value);
    },
  });
  assert.deepEqual(await client.consumers(), { consumers: [consumer] });
  assert.equal((await client.claimConsumer("main", { holder: "worker-1", ttl_seconds: 90 })).lease_token, token);
  assert.equal((await client.readConsumer("main", token, { limit: 10 })).cursor, 1);
  assert.equal(seen.length, 3, "reading must not implicitly acknowledge");
  await client.renewConsumer("main", token, { ttl_seconds: 120 });
  await client.ackConsumer("main", token, { through: 1 });
  await client.releaseConsumer("main", token);
  for (const call of seen) {
    assert.equal(call.options.headers.Authorization, "Bearer tk_private");
    assert.ok(!call.url.includes(token));
    assert.ok(!String(call.options.body).includes(token));
  }
  for (const call of seen.slice(2)) assert.equal(call.options.headers["X-Tendril-Lease"], token);
  assert.match(seen[2].url, /consumers\/main\/events\?limit=10$/);
  assert.deepEqual(JSON.parse(seen[4].options.body), { through: 1 });
  assert.equal(seen[5].options.method, "POST");
  assert.equal(seen[5].options.body, undefined);
  const before = seen.length;
  assert.throws(() => client.claimConsumer("../other", { holder: "w" }), ContractError);
  assert.throws(() => client.readConsumer("main", "private but malformed"), ContractError);
  assert.throws(() => client.readConsumer("main", token, { limit: 501 }), TypeError);
  assert.throws(() => client.ackConsumer("main", token, { through: -1 }), ContractError);
  assert.equal(seen.length, before);
});

test("lease conflicts remain actionable instead of being retried with a new identity", async () => {
  let calls = 0;
  const client = createClient({ api: "https://example.test/api/t/id", token: "tk_private" }, {
    fetch: async () => { calls++; return Response.json({ error: { code: "lease_lost", message: "This lease expired" } }, { status: 409 }); },
  });
  await assert.rejects(client.ackConsumer("main", token, { through: 1 }), error => error instanceof ApiError && error.status === 409 && error.code === "lease_lost");
  assert.equal(calls, 1, "a client must stop processing and explicitly reclaim after losing its lease");
});

test("timer history exposes bounded retry receipts for runs with and without a notification", () => {
  const run = { id: "timer:1000", timer_id: "timer", scheduled_at: 1000, fired_at: 1001, status: "fired", event_seq: 1, delivery: null };
  assertValid("timerRun", run);
  assertValid("timerRun", { ...run, delivery: null });
  const delivery = { state: "pending", attempts: 1, next_attempt_at: 11001, last_attempt_at: 1001, last_error: "temporary provider failure", sent: 1, failed: 1 };
  assertValid("timerRun", { ...run, delivery });
  for (const state of ["sending", "sent", "failed", "cancelled", "unavailable"]) assertValid("timerDelivery", { ...delivery, state });
  assert.ok(validate("timerDelivery", { ...delivery, attempts: 7 }).length);
  assert.ok(validate("timerDelivery", { ...delivery, state: "delivered_to_person" }).length, "provider acceptance does not establish human delivery");
});
