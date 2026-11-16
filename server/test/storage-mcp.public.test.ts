import { describe, expect, it } from "vitest";
import { assertValid } from "../../contract/index.mjs";
import { api, apiJson, create, req, type Handle } from "./helpers";

async function rpc(page: Handle, method: string, params: unknown = {}) {
  const response = await api(page, "POST", "mcp", { jsonrpc: "2.0", id: 1, method, params });
  expect(response.status).toBe(200);
  return await response.json() as any;
}
async function call(page: Handle, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(page, "tools/call", { name, arguments: args });
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true);
  return response.result.structuredContent;
}
async function upload(page: Handle, cid: string, text: string, type = "text/plain") {
  return assertValid("uploadCompletion", await call(page, "upload_text", { cid, text, type }));
}

describe("MCP immutable storage through the real Worker", () => {
  it("advertises one target protocol and requires caller command identities", async () => {
    const page = await create({ mode: "dashboard", listener: false });
    const listed = (await rpc(page, "tools/list")).result.tools;
    const names = listed.map((tool: any) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["upload_text", "get_blob", "list_blobs", "pin_blob",
      "get_shared_file", "write_shared_file", "delete_shared_file", "shared_file_changes",
      "publish_publication", "list_publications", "get_publication", "rollback_publication"]));
    for (const old of ["write_files", "list_versions", "rollback"]) {
      expect(names).not.toContain(old);
      expect((await rpc(page, "tools/call", { name: old, arguments: {} })).error.code).toBe(-32602);
    }
    expect(listed.find((tool: any) => tool.name === "upload_text").inputSchema.required).toContain("cid");
    expect(listed.find((tool: any) => tool.name === "publish_publication").inputSchema.required)
      .toEqual(expect.arrayContaining(["cid", "expected_generations", "expected_head_revision"]));
    expect((await rpc(page, "tools/call", { name: "upload_text", arguments: { text: "missing identity" } })).error.code).toBe(-32602);
    expect((await rpc(page, "tools/call", { name: "upload_text", arguments: { cid: "no-base64", base64: "eA==" } })).error.code).toBe(-32602);
    expect((await call(page, "list_blobs")).blobs).toEqual([]);
  });

  it("uploads exact UTF-8 once across a lost reply and rejects a changed upload intent", async () => {
    const page = await create({ mode: "dashboard", listener: false });
    const text = "<!doctype html><h1>測定 α 🧪</h1>";
    const intent = { cid: "authored-entry", text, type: "text/html", name: "report.html" };
    const first = await call(page, "upload_text", intent);
    const replay = await call(page, "upload_text", intent);
    expect(replay).toEqual(first);
    expect(first.blob.size).toBe(new TextEncoder().encode(text).length);
    expect(await (await api(page, "GET", `blobs/${first.blob.id}`)).text()).toBe(text);
    expect(assertValid("blobMetadata", await call(page, "get_blob", { id: first.blob.id }))).toEqual(first.blob);
    expect((await call(page, "list_blobs")).blobs).toHaveLength(1);
    const conflict = await rpc(page, "tools/call", { name: "upload_text", arguments: { ...intent, text: text + "changed" } });
    expect(conflict.result.isError).toBe(true);
    expect(conflict.result.content[0].text).toContain("command_conflict");
    expect((await call(page, "list_blobs")).blobs).toHaveLength(1);

    const other = await create({ mode: "dashboard", listener: false });
    const unavailable = await rpc(other, "tools/call", { name: "get_blob", arguments: { id: first.blob.id } });
    expect(unavailable.result.isError).toBe(true);
    const denied = await api(page, "POST", "mcp", { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "upload_text", arguments: { cid: "wrong-agent", text: "private" } } }, {}, other.token);
    expect(denied.status).toBe(401);
  });

  it("applies the real byte limit to text instead of treating character count as byte size", async () => {
    const page = await create({ mode: "dashboard", listener: false });
    const tooLarge = await rpc(page, "tools/call", { name: "upload_text", arguments: {
      cid: "too-many-utf8-bytes", text: "🧪".repeat((5 * 1024 * 1024) / 4 + 1), type: "text/plain",
    } });
    expect(tooLarge.result.isError).toBe(true);
    expect(tooLarge.result.content[0].text).toContain("too_large");
    expect((await call(page, "list_blobs")).blobs).toEqual([]);
  });

  it("publishes an explicit authored entry and preserves original guards and head on replay", async () => {
    const page = await create({ mode: "dashboard", listener: false });
    const html = "<!doctype html><h1>MCP authored report</h1>";
    const entry = await upload(page, "report-bytes", html, "text/html");
    const registered = await apiJson(page, "PUT", "scopes/publication-owner", {
      cid: "bind-publication", expected_generations: {}, paths: [["publications", "removed.html"]], operations: [],
    });
    const firstGeneration = registered.generation;
    const command = { cid: "publish-report", expected_generations: { "publication-owner": firstGeneration },
      expected_head_revision: 0, entry: "reports/report.html",
      files: [{ path: "reports/report.html", blob_id: entry.blob.id, type: "text/html" }] };
    const unguarded = await rpc(page, "tools/call", { name: "publish_publication", arguments: { ...command, expected_generations: {} } });
    expect(unguarded.result.isError).toBe(true);
    expect(unguarded.result.content[0].text).toContain("generation_required");
    const first = await call(page, "publish_publication", command);
    expect(first).toEqual({ version: 1, head_revision: 1 });
    const manifest = await call(page, "get_publication", { version: 1 });
    expect(manifest).toMatchObject({ version: 1, entry: command.entry, files: [{
      ...command.files[0], sha256: entry.blob.sha256, size: entry.blob.size,
    }] });
    expect(await (await req(page.page_url)).text()).toContain("MCP authored report");
    const rotated = await apiJson(page, "POST", "scopes/publication-owner/rotate", {
      cid: "rotate-publication", expected_generations: command.expected_generations,
    });
    expect(await call(page, "publish_publication", command)).toEqual(first);
    const generations = { "publication-owner": rotated.generation };
    const second = await call(page, "publish_publication", { ...command, cid: "publish-report-2",
      expected_generations: generations, expected_head_revision: 1 });
    const rollback = { cid: "select-report-1", expected_generations: generations, expected_head_revision: second.head_revision, version: 1 };
    expect(await call(page, "rollback_publication", rollback)).toEqual({ version: 1, head_revision: 3 });
    expect(await call(page, "rollback_publication", rollback)).toEqual({ version: 1, head_revision: 3 });
    expect((await call(page, "list_publications")).head_revision).toBe(3);
  });

  it("round-trips canonical shared-file paths, revisions, history and bounded changes", async () => {
    const page = await create({ mode: "dashboard", listener: false });
    const receipt = await upload(page, "shared-note", "immutable note");
    const path = "notes/測定 #?.txt";
    const write = { cid: "note-reference", expected_generations: {}, path,
      expected_revision: 0, blob_id: receipt.blob.id, type: "text/plain" };
    const first = await call(page, "write_shared_file", write);
    expect(first.file.revision).toBe(1);
    expect(await call(page, "get_shared_file", { path })).toEqual(first.file);
    const conflict = await rpc(page, "tools/call", { name: "write_shared_file", arguments: { ...write, cid: "stale-reference" } });
    expect(conflict.result.isError).toBe(true);
    expect(conflict.result.content[0].text).toContain("file_conflict");
    const deleted = await call(page, "delete_shared_file", { cid: "delete-note", expected_generations: {}, path, expected_revision: 1 });
    expect(deleted.file).toMatchObject({ revision: 2, blob_id: null });
    expect(await call(page, "get_shared_file", { path })).toEqual(deleted.file);
    expect(await call(page, "write_shared_file", write)).toEqual(first);
    expect((await call(page, "list_shared_files")).files).toEqual([]);
    expect((await call(page, "shared_file_history", { path })).versions).toHaveLength(2);
    const changes = await call(page, "shared_file_changes", { after: 0, limit: 1 });
    expect(changes.changes).toHaveLength(1);
    const next = await call(page, "shared_file_changes", { after: changes.cursor, limit: 1 });
    expect(next.changes).toHaveLength(1);
    expect(next.changes[0].file.blob_id).toBeNull();
  });
});
