import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({ entryPoints: [new URL("../src/preferences.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false });
const { createPreferences } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
function environment() {
  const saved = new Map();
  globalThis.window = new EventTarget();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  return { saved, event(key, value) { window.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: value })); } };
}

test("device preferences persist separately for each page and expose copies", () => {
  const env = environment(), a = createPreferences("A"), b = createPreferences("B");
  a.update({ audio: false, language: "de-de", textSize: "large", voice: "neural" });
  assert.equal(a.get().language, "de-DE");
  assert.equal(b.get().audio, true);
  assert.deepEqual(createPreferences("A").get(), a.get());
  assert.deepEqual([...env.saved.keys()], ["tendril:v2:A:preferences"]);
  a.get().audio = true;
  assert.equal(a.get().audio, false);
  assert.equal(b.get().voice, "browser");
});

test("preference changes synchronize tabs without becoming shared application state", () => {
  const env = environment(), a = createPreferences("A"), observed = [];
  const unsubscribe = a.on(value => { observed.push(value); value.contrast = "normal"; });
  env.event("tendril:v2:B:preferences", JSON.stringify({ audio: false }));
  assert.equal(observed.length, 0);
  env.event("tendril:v2:A:preferences", JSON.stringify({ audio: false, contrast: "high" }));
  assert.equal(a.get().audio, false);
  assert.equal(a.get().contrast, "high");
  assert.equal(observed.length, 1);
  assert.equal(env.saved.size, 0, "receiving a storage event does not write it back");
  unsubscribe();
  env.event("tendril:v2:A:preferences", null);
  assert.equal(a.get().audio, true);
  assert.equal(observed.length, 1);
});

test("invalid patches are atomic, corrupt saved settings reset, unavailable storage retains local settings", () => {
  const env = environment(), preferences = createPreferences("A");
  assert.throws(() => preferences.update({ audio: false, unknown: true }), /Unknown preference/);
  assert.throws(() => preferences.update({ mode: "custom" }), /Invalid mode/);
  assert.throws(() => preferences.update({ language: "not a language" }), RangeError);
  assert.equal(preferences.get().audio, true);
  assert.equal(env.saved.size, 0);
  env.saved.set("tendril:v2:B:preferences", "{bad");
  assert.equal(createPreferences("B").get().audio, true);
  globalThis.localStorage = { getItem() { throw Error("unavailable"); }, setItem() { throw Error("unavailable"); } };
  const memory = createPreferences("C");
  memory.update({ audio: false });
  assert.equal(memory.get().audio, false);
});
