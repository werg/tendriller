import { beforeAll, expect, inject, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { schemas } from "../../contract/index.mjs";
import { apiJson, inDO, req, type Handle } from "./helpers";

beforeAll(async () => {
  await applyD1Migrations(env.ACCOUNTS, inject("d1Migrations"));
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run();
});
async function fixture() {
  const account = crypto.randomUUID(), email = `${account}@example.com`;
  const response = await req("/api/tendrils", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.93" }, body: JSON.stringify({ owner: email, application: { kind: "cloudflare", id: `cf:${crypto.randomUUID()}` } }) });
  expect(response.status).toBe(201); const handle = await response.json<Handle>();
  await env.ACCOUNTS.prepare("INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)").bind(account, email, Date.now() - 30 * 86400000).run();
  await env.ACCOUNTS.prepare("UPDATE tendrils SET owner_account=?,claimed_at=? WHERE id=?").bind(account, Date.now(), handle.id).run();
  await inDO(handle.id, t => { t.db.set("owner_account", account); t.db.set("claimed_at", t.now()); });
  const rpc = (method: string, params: unknown = {}) => apiJson(handle, "POST", "mcp", { jsonrpc: "2.0", id: 1, method, params });
  const call = (name: string, args: unknown = {}) => rpc("tools/call", { name, arguments: args });
  return { handle, rpc, call };
}

it("MCP advertises the shared feature schemas and preserves REST lifecycle behavior", async () => {
  const { handle, rpc, call } = await fixture();
  const tools = (await rpc("tools/list")).result.tools;
  expect(tools.find((tool: any) => tool.name === "create_timer").inputSchema).toEqual(schemas.timerCreate);
  expect(tools.find((tool: any) => tool.name === "save_session").inputSchema).toEqual(schemas.sessionWrite);
  expect(tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(["configure_device", "stage_bundle", "publish_bundle", "remix_tendril", "workflow_operation", "list_scopes"]));
  const createCommand = { cid: crypto.randomUUID(), expected_generations: {}, title: "Check from MCP", due_at: Date.now() + 60000 };
  const created = await call("create_timer", createCommand);
  expect(created.result.isError).toBeUndefined(); const timer = created.result.structuredContent;
  expect((await apiJson(handle, "GET", "timers")).timers[0].id).toBe(timer.id);
  expect((await call("create_timer", createCommand)).result.structuredContent).toEqual(timer);
  const changed = await call("update_timer", { id: timer.id, changes: { cid: crypto.randomUUID(), expected_generations: {}, expected_revision: timer.revision, state: "cancelled" } });
  expect((await apiJson(handle, "GET", "timers")).timers[0].state).toBe("cancelled");
  const remove = { id: timer.id, cid: crypto.randomUUID(), expected_generations: {}, expected_revision: changed.result.structuredContent.revision };
  const deleted = await call("delete_timer", remove);
  expect(deleted.result.structuredContent).toEqual({ id: timer.id, revision: 3, deleted: true });
  expect((await call("delete_timer", remove)).result.structuredContent).toEqual(deleted.result.structuredContent);
  const saved = await call("save_session", { purpose: "Preserve the experiment", expected_revision: 0 });
  expect(saved.result.structuredContent.revision).toBe(1);
  expect((await call("save_session", { purpose: "Stale edit", expected_revision: 0 })).result.isError).toBe(true);
  expect((await call("get_session")).result.structuredContent.session.purpose).toBe("Preserve the experiment");
});

it("MCP exposes explicit workflows and rejects absent module activation", async () => {
  const { call } = await fixture();
  const result = await call("workflow_operation", { module: "sessions", operation: "activate", command: { cid: crypto.randomUUID(), expected_generations: {}, data: { scope: "notebook" } } });
  expect(result.result.isError).toBe(true);
  expect((await call("publish_bundle", {})).error.code).toBe(-32602);
  expect((await call("configure_device", { id: "d_missing", role: "owner" })).error.code).toBe(-32602);
});
