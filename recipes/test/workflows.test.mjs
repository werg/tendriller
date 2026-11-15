import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRun, record, annotate, snapshot, parseReading, csv, MAX_RAW, MAX_SERIES } from "../hardware-experiment/model.mjs";
import { validateSchema } from "../../contract/index.mjs";
import { resolveFixture } from "../../cli/lib/preview-runtime.mjs";

test("instrument parser rejects empty/nonnumeric lines and preserves numeric measurements", () => {
  for (const value of ["", "hello", "NaN", "Infinity", '{"value":"23"}', "null"]) assert.equal(parseReading(value), null);
  assert.equal(parseReading("23.4"), 23.4); assert.equal(parseReading('{"value":-12.5}'), -12.5);
});
test("long experiment bounds retained data while totals and bucket statistics remain accurate", () => {
  const run = createRun({ id: "r1", source: "serial", unit: "C", now: 0 });
  for (let i = 0; i < 3000; i++) record(run, i, i * 250);
  assert.equal(run.raw.length, MAX_RAW); assert.equal(run.discarded_raw, 3000 - MAX_RAW);
  assert.equal(run.series.length, MAX_SERIES); assert.ok(run.discarded_series > 0);
  const value = snapshot(run);
  assert.equal(value.count, 3000); assert.equal(value.mean, 1499.5); assert.equal(value.min, 0); assert.equal(value.max, 2999);
  assert.equal(value.series.at(-1).mean, 2997.5);
  assert.equal(csv(run).trim().split("\n").length, MAX_RAW + 1);
});
test("interventions and simulation provenance survive snapshot; report matches the event contract", () => {
  const run = createRun({ id: "r1", source: "simulation", unit: "test", now: 1 });
  record(run, 10, 100); record(run, 14, 500); annotate(run, "Changed the light", 600);
  const value = snapshot(run); value.interventions[0].text = "changed clone";
  assert.equal(run.interventions[0].text, "Changed the light");
  assert.equal(value.source, "simulation");
  const schema = JSON.parse(readFileSync(new URL("../hardware-experiment/contract.json", import.meta.url)));
  assert.deepEqual(validateSchema(schema, { type: "experiment.summary", run: snapshot(run) }), []);
  assert.ok(validateSchema(schema, { type: "experiment.summary", run: { ...snapshot(run), source: "real" } }).length);
  assert.ok(validateSchema(schema, { type: "experiment.summary" }).length);
});
test("a full intervention notebook keeps every existing note and declines another", () => {
  const run = createRun({ id: "r1", source: "simulation", unit: "C", session_id: "session-one", now: 1 });
  for (let i = 0; i < 50; i++) assert.ok(annotate(run, `Observation ${i}`, i));
  assert.equal(annotate(run, "Do not evict the first observation", 51), null);
  assert.equal(run.interventions.length, 50);
  assert.equal(run.interventions[0].text, "Observation 0");
  assert.equal(snapshot(run).session_id, "session-one");
});
test("scenario references connect agent results to actual generated event/device IDs", () => {
  const actual = resolveFixture({ path: ["experiment", "results", "$event.data.run.id"], device: "$device.id" }, { event: { data: { run: { id: "run-unique" } } }, device: { id: "d_unique" } });
  assert.deepEqual(actual, { path: ["experiment", "results", "run-unique"], device: "d_unique" });
  assert.throws(() => resolveFixture("$event.data.missing", { event: { data: {} } }), /unavailable/);
});
test("workshop machine contract bounds coordinates and permits a frame before the first step", () => {
  const schema = JSON.parse(readFileSync(new URL("../multi-device-workshop/contract.json", import.meta.url)));
  assert.deepEqual(validateSchema(schema, { type: "workshop.frame", device: "d_camera", step_id: null, blob: "b_frame", url: "_tendril/blob/b_frame", at: 1 }), []);
  assert.ok(validateSchema(schema, { type: "workshop.point", device: "d_camera", frame: "b_frame", x: 2, y: .5 }).length);
  assert.ok(validateSchema(schema, { type: "workshop.step_ack", device: "d_camera" }).length);
});
