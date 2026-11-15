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
  const response = await req("/api/tendrils", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.93" }, body: JSON.stringify({ owner: email }) });
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
  expect(tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(["configure_device", "stage_bundle", "publish_bundle", "remix_tendril", "request_decision", "read_responses"]));
  const created = await call("create_timer", { title: "Check from MCP", due_at: Date.now() + 60000 });
  expect(created.result.isError).toBeUndefined(); const timer = created.result.structuredContent;
  expect((await apiJson(handle, "GET", "timers")).timers[0].id).toBe(timer.id);
  await call("update_timer", { id: timer.id, changes: { state: "cancelled" } });
  expect((await apiJson(handle, "GET", "timers")).timers[0].state).toBe("cancelled");
  const saved = await call("save_session", { purpose: "Preserve the experiment", expected_revision: 0 });
  expect(saved.result.structuredContent.revision).toBe(1);
  expect((await call("save_session", { purpose: "Stale edit", expected_revision: 0 })).result.isError).toBe(true);
  expect((await call("get_session")).result.structuredContent.session.purpose).toBe("Preserve the experiment");
});

it("MCP validates versioned decisions and cannot manufacture owner approval", async () => {
  const { call } = await fixture();
  const proposal = (await call("request_decision", { title: "Review this change", summary: "A concrete change" })).result.structuredContent;
  expect(proposal.status).toBe("pending");
  const denied = await call("update_decision", { id: proposal.id, changes: { expected_version: 1, status: "approved" } });
  expect(denied.error.code).toBe(-32602);
  const outcome = await call("update_decision", { id: proposal.id, changes: { expected_version: 1, status: "completed" } });
  expect(outcome.result.isError).toBe(true);
  expect((await call("publish_bundle", {})).error.code).toBe(-32602);
  expect((await call("configure_device", { id: "d_missing", role: "owner" })).error.code).toBe(-32602);
  expect((await call("read_responses")).result.structuredContent.responses).toEqual([]);
});
