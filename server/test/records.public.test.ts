import { afterEach, expect, it } from "vitest";
import { RECORD_LOG_LIMITS, encodeRecord, verifyRecordEntry, recordGenesisRoot } from "../../contract/records.mjs";
import type { RecordLogEntry, RecordLogInfo, RecordLogPage } from "../../contract/records.mjs";
import { appendRecord, getRecordLog } from "../src/records";
import { Db } from "../src/db";
import { api, apiJson, create, inDO, PageClient, publishFiles, req, sleep, type Handle } from "./helpers";
const bytes = (value: string) => new TextEncoder().encode(value);
const pages: PageClient[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.close(); });
async function setup() {
  const h = await create();
  await apiJson(h, "PATCH", "", { lifetime: "resident" });
  const info = await apiJson<RecordLogInfo>(h, "POST", "records", {});
  return { h, info, historyId: info.descriptor.historyId };
}
function append(h: Handle, historyId: string, value: string) {
  return apiJson<RecordLogEntry>(h, "POST", "records/entries", { historyId, record: encodeRecord(bytes(value)) });
}
function read(h: Handle, historyId: string, after = 0, limit?: number) {
  return apiJson<RecordLogPage>(h, "GET", `records/entries?historyId=${historyId}&after=${after}${limit === undefined ? "" : `&limit=${limit}`}`);
}
it("provisions one history only on an owned resident Tendril and protects its lifetime", async () => {
  const h = await create({ listener: false });
  expect((await api(h, "POST", "records", {})).status).toBe(409);
  await apiJson(h, "PATCH", "", { lifetime: "resident" });
  const [one, two] = await Promise.all([apiJson<RecordLogInfo>(h, "POST", "records", {}), apiJson<RecordLogInfo>(h, "POST", "records", {})]);
  expect(one).toEqual(two);
  expect(one.head).toEqual({ historyId: one.descriptor.historyId, position: 0, bytes: 0, root: await recordGenesisRoot(one.descriptor.historyId) });
  expect((await api(h, "PATCH", "", { lifetime: "ad_hoc" })).status).toBe(409);
  expect((await api(h, "DELETE", "records")).status).toBe(405);
  const unclaimed = await create({ claim: false, listener: false });
  expect((await api(unclaimed, "POST", "records", {})).status).toBe(409);
});
it("atomically deduplicates concurrent exact bytes and resumes original positions after reopening storage", async () => {
  const { h, info, historyId } = await setup();
  const [one, retry] = await Promise.all([append(h, historyId, "same"), append(h, historyId, "same")]);
  expect(one).toEqual(retry); expect(one.position).toBe(1);
  expect(await verifyRecordEntry(one, info.head)).toEqual(bytes("same"));
  await inDO(h.id, t => { t.db = new Db(t.ctx.storage); t.db.init(); });
  expect(await append(h, historyId, "same")).toEqual(one);
  const other = await append(h, historyId, "other");
  expect(other.position).toBe(2); expect(other.previousRoot).toBe(one.root);
  const page = await read(h, historyId);
  expect(page.entries).toEqual([one, other]); expect(page.head.bytes).toBe(9);
});
it("commits entry, deduplication, and head together or rolls every write back", async () => {
  const { h, historyId, info } = await setup();
  await inDO(h.id, async t => {
    t.db.run("CREATE TRIGGER fail_record_head BEFORE UPDATE ON record_log BEGIN SELECT RAISE(ABORT, 'injected head failure'); END");
    try { await expect(appendRecord(t, historyId, bytes("not durable"))).rejects.toThrow("injected head failure"); }
    finally { t.db.run("DROP TRIGGER fail_record_head"); }
    expect(getRecordLog(t)).toEqual(info);
    expect(t.db.all("SELECT * FROM record_log_entries")).toEqual([]);
  });
  expect((await append(h, historyId, "not durable")).position).toBe(1);
});
it("retains old records across publication and elapsed time and catches up through bounded pages", async () => {
  const { h, historyId, info } = await setup();
  const saved = [];
  for (let i = 0; i < 5; i++) saved.push(await append(h, historyId, `record-${i}`));
  await publishFiles(h, { "index.html": "<!doctype html><title>New page version</title>" });
  await inDO(h.id, t => { t.skew += 365 * 86400_000; });
  let cursor = 0;
  const received = [];
  while (cursor < 5) { const page = await read(h, historyId, cursor, 2); received.push(...page.entries); cursor = page.cursor; }
  expect(received).toEqual(saved);
  expect((await apiJson<RecordLogInfo>(h, "GET", "records")).descriptor).toEqual(info.descriptor);
  expect(await append(h, historyId, "record-0")).toEqual(saved[0]);
});
it("refuses quota exhaustion without pruning, while duplicate retries still work", async () => {
  const { h, historyId } = await setup();
  const accepted = await append(h, historyId, "existing");
  await inDO(h.id, t => { t.db.run("UPDATE record_log SET bytes=?", RECORD_LOG_LIMITS.totalBytes); });
  const rejected = await api(h, "POST", "records/entries", { historyId, record: encodeRecord(bytes("new")) });
  expect(rejected.status).toBe(413); expect(await rejected.json()).toMatchObject({ error: { code: "record_log_full" } });
  expect(await append(h, historyId, "existing")).toEqual(accepted);
  expect((await read(h, historyId)).entries).toEqual([accepted]);
});
it("rejects wrong history, missing ranges, ahead cursors, invalid bounds and oversized bytes", async () => {
  const { h, historyId } = await setup();
  await append(h, historyId, "one"); await append(h, historyId, "two");
  const wrong = "h_" + "0".repeat(32);
  for (const path of [`records?historyId=${wrong}`, `records/entries?historyId=${wrong}&after=0`, `records/entries?historyId=${historyId}&after=3`])
    expect((await api(h, "GET", path)).status).toBe(409);
  for (const suffix of ["", "&after=-1", "&after=0.5", "&after=0&limit=0", "&after=0&limit=129", "&after=0&limit=1.5"])
    expect((await api(h, "GET", `records/entries?historyId=${historyId}${suffix}`)).status).toBe(400);
  expect((await api(h, "POST", "records/entries", { historyId, record: "a".repeat(400_000) })).status).toBe(413);
  expect((await api(h, "POST", "records/entries", { historyId, record: "YQ==", ignored: true })).status).toBe(400);
  await inDO(h.id, t => { t.db.run("DELETE FROM record_log_entries WHERE position=1"); });
  const gap = await api(h, "GET", `records/entries?historyId=${historyId}&after=0`);
  expect(gap.status).toBe(409); expect(await gap.json()).toMatchObject({ error: { code: "history_gap" } });
});
it("requires owner/agent access for history and uses existing authorized sockets only as hints", async () => {
  const { h, historyId } = await setup();
  const owner = await PageClient.connect(h.page_url); pages.push(owner);
  const link = await inDO(h.id, t => t.createLink("display", "public display", null));
  const display = new URL(h.page_url); display.pathname = `/s/${link.key}/`;
  const observer = await PageClient.connect(display.href, { headers: { Cookie: "", Origin: display.origin } }); pages.push(observer);
  expect((await req(display.href + "_tendril/records", { headers: { Cookie: "" } })).status).toBe(403);
  expect((await api(h, "GET", "records", undefined, {}, "invalid")).status).toBe(401);
  const saved = await append(h, historyId, "secret bytes");
  expect((await owner.next("record_log_head")).head).toMatchObject({ historyId, position: saved.position, root: saved.root });
  await sleep(20); expect(observer.drain().some(message => message.t === "record_log_head")).toBe(false);
  const response = await req(h.page_url + "_tendril/records/entries", { method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(h.page_url).origin }, body: JSON.stringify({ historyId, record: encodeRecord(bytes("owner")) }) });
  expect(response.status).toBe(200);
});
