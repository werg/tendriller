import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RECORD_LOG_FORMAT, RECORD_LOG_LIMITS, createRecordLogClient, recordId, recordGenesisRoot, recordEntryRoot, encodeRecord, decodeRecord, verifyRecordEntry } from "../records.mjs";
import { createClient } from "../client.mjs";
const historyId = "h_00112233445566778899aabbccddeeff";
const hash = input => createHash("sha256").update(input).digest("hex");
test("canonical integrity encoding binds bytes, history, sequence and predecessor", async () => {
  const bytes = new Uint8Array([0, 255, 1, 2, 3]);
  const root = await recordGenesisRoot(historyId);
  assert.equal(root, hash(JSON.stringify([RECORD_LOG_FORMAT, "genesis", historyId])));
  const id = await recordId(bytes);
  assert.equal(id, hash(bytes));
  const next = await recordEntryRoot(historyId, 1, root, id);
  assert.equal(next, hash(JSON.stringify([RECORD_LOG_FORMAT, "entry", historyId, 1, root, id])));
  const entry = { historyId, position: 1, previousRoot: root, root: next, recordId: id, record: encodeRecord(bytes) };
  const previous = { historyId, position: 0, root, bytes: 0 };
  assert.deepEqual(await verifyRecordEntry(entry, previous), bytes);
  for (const changed of [{ ...entry, position: 2 }, { ...entry, record: "AAAA" }, { ...entry, historyId: "h_" + "1".repeat(32) }, { ...entry, previousRoot: "0".repeat(64) }])
    await assert.rejects(verifyRecordEntry(changed, previous));
});
test("record bounds and base64 reject alternate or ambiguous representations", () => {
  const bytes = new Uint8Array(RECORD_LOG_LIMITS.recordBytes).fill(255);
  assert.deepEqual(decodeRecord(encodeRecord(bytes)), bytes);
  for (const value of ["", "YQ", "YR==", "YQ==\n", "YQ===", "-w==", null]) assert.throws(() => decodeRecord(value));
  assert.throws(() => encodeRecord(new Uint8Array(RECORD_LOG_LIMITS.recordBytes + 1)));
});
async function fixture() {
  const empty = { historyId, position: 0, root: await recordGenesisRoot(historyId), bytes: 0 };
  const bytes = new TextEncoder().encode("durable bytes");
  const id = await recordId(bytes), root = await recordEntryRoot(historyId, 1, empty.root, id);
  const entry = { historyId, position: 1, recordId: id, previousRoot: empty.root, root, record: encodeRecord(bytes) };
  const head = { historyId, position: 1, root, bytes: bytes.length };
  const descriptor = { historyId, format: RECORD_LOG_FORMAT, limits: RECORD_LOG_LIMITS };
  return { empty, bytes, entry, head, descriptor, page: { historyId, after: 0, cursor: 1, entries: [entry], head } };
}
test("native client keeps credentials in headers and verifies exact bytes before accepting a receipt", async () => {
  const f = await fixture(), seen = [];
  let response = f.entry;
  const client = createClient({ api: "https://example.test/api/t/one/", token: "private-token" }, { fetch: async (url, options) => {
    seen.push({ url, options }); return Response.json(response);
  } });
  assert.deepEqual(await client.records.append(f.bytes, { historyId }), f.entry);
  assert.equal(seen[0].url, "https://example.test/api/t/one/records/entries");
  assert.equal(seen[0].options.headers.Authorization, "Bearer private-token");
  assert.deepEqual(JSON.parse(seen[0].options.body), { historyId, record: f.entry.record });
  response = { ...f.entry, record: encodeRecord(new Uint8Array([12])) };
  await assert.rejects(client.records.append(f.bytes, { historyId }), error => error.code === "invalid_response");
  response = { ...f.entry, root: "0".repeat(64) };
  await assert.rejects(client.records.append(f.bytes, { historyId }), error => error.code === "integrity_error");
});
test("conditional append sends the reviewed predecessor and preserves an exact retry receipt", async () => {
  const f = await fixture(), seen = [];
  const expectedHead = { position: f.empty.position, root: f.empty.root };
  const client = createRecordLogClient({ base: "https://example.test", fetch: async (_url, options) => {
    seen.push(JSON.parse(options.body));
    expectedHead.position = 99;
    return Response.json(f.entry);
  } });
  assert.deepEqual(await client.append(f.bytes, { historyId, expectedHead }), f.entry);
  assert.deepEqual(seen[0], { historyId, record: f.entry.record, expectedHead: { position: 0, root: f.empty.root } });
  await assert.rejects(client.append(f.bytes, { historyId, expectedHead: { position: 0, root: "invalid" } }), { code: "bad_request" });
});
test("reads verify contiguous prefixes and reject head mismatch, identity changes and fabricated empty progress", async () => {
  const f = await fixture(); let response = f.page;
  const client = createRecordLogClient({ base: "https://example.test", fetch: async () => Response.json(response) });
  assert.deepEqual(await client.read({ historyId, after: 0, previous: f.empty }), f.page);
  for (const invalid of [
    { ...f.page, cursor: 2 }, { ...f.page, entries: [], cursor: 0 }, { ...f.page, head: { ...f.head, root: "0".repeat(64) } },
    { ...f.page, entries: [{ ...f.entry, position: 2 }] }, { ...f.page, historyId: "h_" + "0".repeat(32) },
  ]) {
    response = invalid;
    await assert.rejects(client.read({ historyId, after: 0, previous: f.empty }));
  }
});
test("watch treats reconnect as a hint, recovers by retained reads, and reports rollback", async () => {
  const f = await fixture(), observed = [], errors = [];
  let head = f.empty, notify, removed = false;
  const client = createRecordLogClient({ base: "https://example.test", subscribeHints: listener => { notify = listener; return () => { removed = true; }; },
    fetch: async () => Response.json({ descriptor: f.descriptor, head }) });
  const turn = () => new Promise(resolve => setImmediate(resolve));
  const until = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()); };
  const stop = client.watch({ historyId, after: 0, onError: error => errors.push(error) }, value => observed.push(value));
  try {
    await turn(); assert.deepEqual(observed, []);
    head = f.head; notify(); await until(() => observed.length === 1);
    assert.deepEqual(observed, [f.head]);
    notify(); await turn(); assert.equal(observed.length, 1);
    head = f.empty; notify(); await until(() => errors.length > 0);
    assert.equal(errors.at(-1)?.code, "history_conflict");
  } finally { stop(); }
  assert.equal(removed, true);
  head = f.head; notify(); await turn(); assert.equal(observed.length, 1);
});


test("record root helpers consistently reject through their promised asynchronous contract", async () => {
  await assert.rejects(recordGenesisRoot("wrong-history"), { code: "bad_request" });
  await assert.rejects(recordEntryRoot(historyId, 0, "0".repeat(64), "1".repeat(64)), { code: "bad_request" });
  await assert.rejects(recordEntryRoot(historyId, 1, "invalid", "1".repeat(64)), { code: "bad_request" });
});
