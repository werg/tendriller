import test from "node:test";
import assert from "node:assert/strict";
import { observation, entries, exportNotebook } from "../../../recipes/field-notebook/model.mjs";

test("notebook preserves capture identity and reviewed location, rejects invalid fixes", () => {
  const entry = observation({ note: "  A red flower ", tags: "Garden,garden, morning", location: { latitude: 52, longitude: 13, accuracy: 20 } }, "observation-1", 100);
  assert.deepEqual(entry, { id: "observation-1", created_at: 100, note: "A red flower", tags: ["garden", "morning"], location: { latitude: 52, longitude: 13, accuracy: 20 } });
  assert.throws(() => observation({ note: "Bad fix", location: { latitude: 120, longitude: 13, accuracy: 20 } }));
  assert.throws(() => observation({ note: " " }));
});
test("notebook merges queued observations once, prefers agent recovery and exports explicit media limits", () => {
  const pending = { a: { id: "a", note: "leaf", created_at: 1, status: "queued", capture_id: "private-local-id" } };
  const shared = { a: { ...pending.a, status: "accepted", interpretation: "Serrated edge" }, b: { id: "b", note: "flower", created_at: 2 } };
  assert.equal(entries(shared, pending).length, 2);
  assert.equal(entries(shared, pending, "serrated")[0].status, "accepted");
  const report = exportNotebook(entries(shared, pending), 200);
  assert.match(report.media, /References only/);
  assert.equal(report.entries.some(entry => "capture_id" in entry), false);
  assert.equal(report.entries[0].id, "b");
});
