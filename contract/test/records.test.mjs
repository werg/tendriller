import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RECORD_LOG_FORMAT, RECORD_LOG_LIMITS, recordId, recordGenesisRoot, recordEntryRoot, encodeRecord, decodeRecord, verifyRecordEntry } from "../records.mjs";
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
