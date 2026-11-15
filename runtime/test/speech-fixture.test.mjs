import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { wordErrorRate } from "../../test/e2e/speech-fixture.mjs";

test("the known spoken fixture has verified PCM bytes and silence cannot satisfy its transcript", () => {
  const dir = new URL("../../test/fixtures/speech/", import.meta.url);
  const fixture = JSON.parse(readFileSync(new URL("manifest.json", dir)));
  const bytes = readFileSync(new URL(fixture.file, dir));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt16LE(20), 1, "PCM format");
  assert.equal(bytes.readUInt16LE(22), 1, "mono");
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.ok(bytes.length > 32_000 && bytes.length < 320_000, "bounded spoken fixture");
  assert.equal(wordErrorRate(fixture.transcript, fixture.transcript.toUpperCase()), 0);
  assert.equal(wordErrorRate(fixture.transcript, ""), 1);
  assert.ok(wordErrorRate(fixture.transcript, "the sky") > fixture.max_word_error_rate);
  assert.equal(wordErrorRate("one two three", "one three"), 1 / 3);
  assert.equal(wordErrorRate("one two three", "one four three"), 1 / 3);
});
