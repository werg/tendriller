import { beforeAll, expect, inject, it } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { api, apiJson, create, inDO, PageClient } from "./helpers";
import { stateCommand } from "../src/state-command";
import { RESOURCE_LIMITS } from "../../contract/index.mjs";
import { createClient } from "../../contract/client.mjs";

beforeAll(async () => { await applyD1Migrations(env.ACCOUNTS, inject("d1Migrations")); await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); });
const command = (extra: Record<string, unknown> = {}) => ({ cid: crypto.randomUUID(), expected_generations: {}, ...extra });

it("authenticated browser snapshots return a coherent committed state and are fresh reads without command receipts", async () => {
  const h = await create();
  const binding = await apiJson(h, "PUT", "scopes/read", command({ paths: [["source"]], operations: [] }));
  const page = await PageClient.connect(h.page_url);
  const first = await page.request({ t: "state_snapshot", cid: "read-state" });
  expect(first).toMatchObject({ state: {}, rev: 0, scopes: [binding] });
  const write = command({ t: "state", expected_revision: first.rev, ops: [{ op: "set", path: ["a"], value: 1 }, { op: "set", path: ["b"], value: 2 }] });
  page.send(write);
  const second = await page.request({ t: "state_snapshot", cid: "read-state" });
  expect(second).toMatchObject({ state: { a: 1, b: 2 }, rev: 1, scopes: [binding] });
  await inDO(h.id, t => {
    expect(t.db.one("SELECT result FROM commands WHERE cid='read-state'")).toBeNull();
    expect(t.db.all("SELECT * FROM activity WHERE kind='state'")).toHaveLength(1);
  });
  page.close();
});

it("snapshot reads recheck a revoked authenticated session before disclosing shared state", async () => {
  const h = await create();
  const page = await PageClient.connect(h.page_url);
  await inDO(h.id, t => t.db.run("DELETE FROM page_sessions"));
  page.send({ t: "state_snapshot", cid: "revoked-read" });
  await expect.poll(() => page.closed?.code).toBe(4003);
  expect(page.messages.some(message => message.t === "state_snapshot")).toBe(false);
  page.close();
});

it("serializes competing claims against one authoritative snapshot and persists both outcomes", async () => {
  const h = await create();
  const requests = ["a", "b"].map(owner => command({ conditions: [{ path: ["claims", "item"], exists: false }],
    ops: [{ op: "set", path: ["claims", "item"], value: owner }, { op: "set", path: ["acceptedBy"], value: owner }] }));
  const results = await Promise.all(requests.map(body => api(h, "PATCH", "state", body)));
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const saved = await apiJson(h, "GET", "state");
  expect(saved.rev).toBe(1);
  expect(saved.state.claims.item).toBe(saved.state.acceptedBy);
  const rejected = await results.find(result => result.status === 409)!.json() as any;
  expect(rejected.error).toMatchObject({ code: "state_conflict", rev: 1, conflict: { kind: "condition", condition: 0, path: ["claims", "item"] } });
  await inDO(h.id, t => {
    expect(t.db.all("SELECT result FROM commands")).toHaveLength(2);
    expect(t.db.all("SELECT * FROM activity WHERE kind='state'")).toHaveLength(1);
  });
});

it("allows disjoint field edits, detects ABA with revisions, and checks before every op", async () => {
  const h = await create();
  await apiJson(h, "PUT", "state", command({ state: { a: 0, b: 0, status: "open" } }));
  for (const key of ["a", "b"]) await apiJson(h, "PATCH", "state", command({ conditions: [{ path: [key], equals: 0 }], ops: [{ op: "set", path: [key], value: 1 }] }));
  await apiJson(h, "PATCH", "state", command({ ops: [{ op: "set", path: ["status"], value: "closed" }] }));
  await apiJson(h, "PATCH", "state", command({ ops: [{ op: "set", path: ["status"], value: "open" }] }));
  const rejected = await apiJson(h, "PATCH", "state", command({ expected_revision: 1, conditions: [{ path: ["status"], equals: "open" }], ops: [] }), 409);
  expect(rejected.error.conflict.kind).toBe("revision");
  const sameSnapshot = await apiJson(h, "PATCH", "state", command({ conditions: [{ path: ["status"], equals: "open" }, { path: ["a"], equals: 1 }],
    ops: [{ op: "set", path: ["status"], value: "closed" }, { op: "set", path: ["a"], value: 2 }] }));
  expect(sameSnapshot.rev).toBe(6);
  expect((await apiJson(h, "GET", "state")).state).toEqual({ a: 2, b: 1, status: "closed" });
});

it("replays a stored rejection after its condition becomes true and rejects changed predicates", async () => {
  const h = await create();
  const refused = command({ conditions: [{ path: ["ready"], equals: true }], ops: [{ op: "set", path: ["done"], value: true }] });
  const first = await apiJson(h, "PATCH", "state", refused, 409);
  await apiJson(h, "PATCH", "state", command({ ops: [{ op: "set", path: ["ready"], value: true }] }));
  expect(await apiJson(h, "PATCH", "state", refused, 409)).toEqual(first);
  expect((await apiJson(h, "GET", "state")).state).toEqual({ ready: true });
  const changed = await apiJson(h, "PATCH", "state", { ...refused, conditions: [{ path: ["ready"], exists: true }] }, 409);
  expect(changed.error.code).toBe("command_conflict");
  const acceptedCommand = { ...refused, cid: crypto.randomUUID() };
  const accepted = await apiJson(h, "PATCH", "state", acceptedCommand);
  await apiJson(h, "PATCH", "state", command({ ops: [{ op: "set", path: ["ready"], value: false }] }));
  expect(await apiJson(h, "PATCH", "state", acceptedCommand)).toEqual(accepted);
});

it("requires generation guards for condition-read paths even when writing elsewhere", async () => {
  const h = await create();
  const binding = await apiJson(h, "PUT", "scopes/source", command({ paths: [["source"]], operations: [] }));
  const edit = command({ conditions: [{ path: ["source"], exists: false }], ops: [{ op: "set", path: ["derived"], value: 1 }] });
  expect((await api(h, "PATCH", "state", edit)).status).toBe(428);
  const stale = { ...edit, expected_generations: { source: binding.generation } };
  await apiJson(h, "POST", "scopes/source/rotate", command({ expected_generations: stale.expected_generations }));
  expect((await apiJson(h, "PATCH", "state", stale, 409)).error.code).toBe("stale_generation");
  expect((await apiJson(h, "GET", "state")).rev).toBe(0);
});

it("rolls back the entire batch and side effects on an incompatible path or failed receipt admission", async () => {
  const h = await create();
  await apiJson(h, "PUT", "state", command({ state: { parent: [1], untouched: true } }));
  const page = await PageClient.connect(h.page_url);
  const failed = await apiJson(h, "PATCH", "state", command({ ops: [{ op: "set", path: ["untouched"], value: false }, { op: "set", path: ["parent", "child"], value: 2 }] }), 409);
  expect(failed.error.conflict).toEqual({ kind: "path", path: ["parent", "child"] });
  await inDO(h.id, t => {
    const before = t.getState();
    const activity = t.db.all("SELECT * FROM activity WHERE kind='state'");
    const published: unknown[] = [], original = t.broadcast;
    t.broadcast = (message, filter, except) => {
      t.afterCommit(() => { published.push(message); });
      original.call(t, message, filter, except);
    };
    try {
      t.db.run("UPDATE command_usage SET count=? WHERE id=1", RESOURCE_LIMITS.command_receipts);
      for (const extra of [{}, { expected_revision: 999 }]) {
        const input = command({ ...extra });
        expect(() => stateCommand(t, "agent:quota", input, [{ op: "set", path: ["untouched"], value: false }])).toThrow("receipt allowance");
        expect(t.db.one("SELECT * FROM commands WHERE cid=?", input.cid)).toBeNull();
      }
      expect(t.getState()).toEqual(before);
      expect(t.db.all("SELECT * FROM activity WHERE kind='state'")).toEqual(activity);
      expect(published).toEqual([]);
    } finally { t.broadcast = original; }
  });
  expect(page.messages.filter(message => message.t === "state")).toEqual([]);
  page.close();
});

it("WebSocket conflict receipts survive retry and reset the page to current authority", async () => {
  const h = await create();
  const page = await PageClient.connect(h.page_url);
  const body = command({ t: "state", conditions: [{ path: ["nullable"], equals: null }], ops: [{ op: "set", path: ["done"], value: true }] });
  const first = await page.request(body);
  expect(first).toMatchObject({ error: "state_conflict", rev: 0, conflict: { condition: 0 } });
  expect((await page.next("state_reset")).state).toEqual({});
  await apiJson(h, "PATCH", "state", command({ ops: [{ op: "set", path: ["nullable"], value: null }] }));
  expect(await page.request(body)).toEqual(first);
  expect((await page.next("state_reset")).state).toEqual({ nullable: null });
  page.close();
});

it("WebSocket writes reject unknown guards before admitting a command or changing state", async () => {
  const h = await create();
  const page = await PageClient.connect(h.page_url);
  for (const extra of [{ expected_revison: 99 }, { condition: [{ path: ["ready"], equals: true }] }]) {
    const body = command({ t: "state", ...extra, ops: [{ op: "set", path: ["done"], value: true }] });
    const rejected = await page.request(body);
    expect(rejected).toMatchObject({ error: "bad_request" });
    expect(rejected.message).toContain("Unknown field");
    expect((await page.next("state_reset")).state).toEqual({});
    await inDO(h.id, t => {
      expect(t.getState()).toMatchObject({ rev: 0, state: {} });
      expect(t.db.one("SELECT cid FROM commands WHERE cid=?", body.cid)).toBeNull();
      expect(t.db.all("SELECT * FROM activity WHERE kind='state'")).toEqual([]);
    });
  }
  page.close();
});

it("SDK and MCP carry conditions through the same authoritative state implementation", async () => {
  const h = await create();
  const client = createClient(h, { fetch: async (_url, init) => api(h, init?.method || "GET", "state", init?.body as string | undefined) });
  await client.updateState({ cid: crypto.randomUUID(), expected_generations: {}, conditions: [{ path: ["x"], exists: false }], ops: [{ op: "set", path: ["x"], value: 1 }] });
  await expect(client.updateState({ cid: crypto.randomUUID(), expected_generations: {}, expected_revision: 0, ops: [] })).rejects.toMatchObject({ status: 409, code: "state_conflict" });
  const call = (arguments_: unknown) => apiJson(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_state", arguments: arguments_ } });
  const success = await call(command({ conditions: [{ path: ["x"], equals: 1 }], ops: [{ op: "set", path: ["x"], value: 2 }] }));
  expect(success.result.structuredContent.rev).toBe(2);
  const conflict = await call(command({ expected_revision: 1, ops: [] }));
  expect(conflict.result.isError).toBe(true);
  expect(JSON.stringify(conflict.result)).toContain("state_conflict");
});
