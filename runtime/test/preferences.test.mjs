import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({ entryPoints: [new URL("../src/voice/preferences.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false });
const { createPreferences } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
function environment() {
  const saved = new Map();
  globalThis.window = new EventTarget();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  return { saved, event(key, value) { window.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: value })); } };
}
test("voice settings are page-local and muted by default, without presentation vocabulary", () => {
  const env = environment(), a = createPreferences("A"), b = createPreferences("B");
  a.update({ audio: true, language: "de-de", voice: "neural" });
  assert.equal(a.get().language, "de-DE"); assert.equal(b.get().audio, false);
  assert.deepEqual(createPreferences("A").get(), { ...a.get(), audio: false });
  assert.equal(JSON.parse(env.saved.get("tendril:voice:A:preferences")).audio, undefined);
  assert.deepEqual([...env.saved.keys()], ["tendril:voice:A:preferences"]);
  a.get().audio = false; assert.equal(a.get().audio, true);
  assert.equal(b.get().wakeMode, "local");
  assert.throws(() => a.update({ textSize: "large" }), /Unknown preference/);
});
test("another tab cannot change a live adapter's engine or session consent", () => {
  const env = environment(), a = createPreferences("A"), observed = [];
  const off = a.on(value => { observed.push(value); value.voice = "browser"; });
  env.event("tendril:voice:B:preferences", JSON.stringify({ audio: true })); assert.equal(observed.length, 0);
  env.event("tendril:voice:A:preferences", JSON.stringify({ audio: true, voice: "neural" }));
  assert.equal(a.get().audio, false); assert.equal(a.get().voice, "browser"); assert.equal(observed.length, 0);
  a.update({ audio: true }); assert.equal(observed.length, 1); assert.equal(a.get().audio, true);
  off(); a.update({ audio: false }); assert.equal(observed.length, 1);
});
test("invalid changes are atomic; unavailable storage preserves current visit settings", () => {
  const env = environment(), preferences = createPreferences("A");
  assert.throws(() => preferences.update({ audio: true, unknown: true }), /Unknown preference/);
  assert.throws(() => preferences.update({ language: "not a language" }), RangeError);
  assert.equal(preferences.get().audio, false); assert.equal(env.saved.size, 0);
  env.saved.set("tendril:voice:B:preferences", "{bad"); assert.equal(createPreferences("B").get().audio, false);
  globalThis.localStorage = { getItem() { throw Error("unavailable"); }, setItem() { throw Error("unavailable"); } };
  const memory = createPreferences("C"); memory.update({ audio: true }); assert.equal(memory.get().audio, true);
});
