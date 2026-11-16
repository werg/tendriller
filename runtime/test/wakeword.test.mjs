import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({ entryPoints: [new URL("../src/voice/wakeword.ts", import.meta.url).pathname],
  bundle: true, format: "esm", platform: "node", write: false });
const { WakeWordCapture, matchWakePhrase } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));

function env({ local = true } = {}) {
  const instances = [];
  let visibility = "visible";
  let outputSpeaking = false;
  globalThis.window = new EventTarget();
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  globalThis.document = new EventTarget();
  Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
  class FakeRecognition {
    processLocally = false;
    continuous = false;
    interimResults = true;
    results = [];
    constructor() { instances.push(this); }
    start() { this.started = true; this.onstart?.(); }
    abort() { this.aborted = true; this.onend?.(); }
    heard(transcript) {
      const resultIndex = this.results.length;
      this.results.push({ isFinal: true, 0: { transcript } });
      this.onresult?.({ resultIndex, results: this.results });
    }
    error(error) { this.onerror?.({ error }); this.onend?.(); }
  }
  // Simulate a browser without support for on-device recognition.
  class BrowserOnly extends FakeRecognition {
    constructor() { super(); delete this.processLocally; }
  }
  const factory = local ? FakeRecognition : BrowserOnly;
  factory.available = async () => "downloadable";
  factory.install = async () => true;
  window.SpeechRecognition = factory;
  const states = [], wakes = [], commands = [];
  const capture = new WakeWordCapture({
    onState: (state, detail) => states.push({ state, detail }),
    onWake: () => wakes.push("wake"),
    onCommand: text => commands.push(text),
    isOutputSpeaking: () => outputSpeaking,
  });
  return { capture, instances, states, wakes, commands, setOutputSpeaking: value => { outputSpeaking = value; }, setVisibility: state => { visibility = state; document.dispatchEvent(new Event("visibilitychange")); } };
}

test("whole-word phrase detection preserves the following command", () => {
  assert.deepEqual(matchWakePhrase("Hey Kitchen, set a timer for 10 minutes.", "hey kitchen"), { command: "set a timer for 10 minutes." });
  assert.equal(matchWakePhrase("hey kitchens set a timer", "hey kitchen"), null);
  assert.equal(matchWakePhrase("hey", "hey kitchen"), null);
  assert.deepEqual(matchWakePhrase("bonjour café ! allume les lumières", "Bonjour Café"), { command: "allume les lumières" });
});

test("local recognition is strict, opt-in, and commands follow normal callbacks", () => {
  const { capture, instances, states, wakes, commands } = env();
  assert.equal(capture.running, false);
  assert.equal(capture.start({ phrase: "Hey Kitchen", lang: "en-US", mode: "local" }), true);
  const rec = instances.at(-1);
  assert.equal(rec.processLocally, true);
  assert.equal(rec.interimResults, false);
  rec.heard("I was talking about the kitchen");
  assert.equal(wakes.length, 0);
  rec.heard("Hey kitchen");
  assert.equal(wakes.length, 1);
  assert.equal(states.at(-1).state, "command");
  rec.heard("Turn on the lights.");
  assert.deepEqual(commands, ["Turn on the lights."]);
  capture.stop();
  assert.equal(rec.aborted, true);
  assert.equal(capture.running, false);
  rec.heard("hey kitchen reopen");
  assert.equal(commands.length, 1);
});

test("a phrase and its command in one final result send only once", () => {
  const { capture, instances, wakes, commands } = env();
  capture.start({ phrase: "Hey Tendril", lang: "de-DE", mode: "browser" });
  const rec = instances.at(-1);
  assert.equal(rec.processLocally, false);
  rec.heard("Hey Tendril, remember the milk");
  assert.deepEqual(commands, ["remember the milk"]);
  rec.onresult?.({ resultIndex: 0, results: rec.results }); // duplicate final index
  assert.deepEqual(commands, ["remember the milk"]);
  assert.equal(wakes.length, 1);
  capture.stop();
});

test("spoken agent replies cannot trigger wake commands", () => {
  const { capture, instances, wakes, commands, setOutputSpeaking } = env();
  capture.start({ phrase: "Hey Tendril", lang: "en-US", mode: "browser" });
  const rec = instances.at(-1);
  setOutputSpeaking(true);
  rec.heard("Hey Tendril, change the dashboard");
  assert.deepEqual(wakes, []);
  assert.deepEqual(commands, []);
  setOutputSpeaking(false);
  rec.heard("Hey Tendril, change the dashboard");
  assert.deepEqual(commands, ["change the dashboard"]);
  capture.stop();
});

test("no silent cloud fallback and denied permission are terminal", () => {
  const { capture, states, instances } = env({ local: false });
  assert.equal(capture.start({ phrase: "Hey Tendril", lang: "en-US", mode: "local" }), false);
  assert.match(states.at(-1).detail, /not supported/i);
  assert.equal(capture.running, false);
  assert.equal(capture.start({ phrase: "Hey Tendril", lang: "en-US", mode: "browser" }), true);
  instances.at(-1).error("not-allowed");
  assert.equal(capture.running, false);
  assert.match(states.at(-1).detail, /permission was denied/i);
});

test("backgrounding always stops recognition and never auto-rearms", () => {
  const { capture, instances, states, setVisibility } = env();
  capture.start({ phrase: "Hey Tendril", lang: "en-US", mode: "browser" });
  setVisibility("hidden");
  assert.equal(capture.running, false);
  assert.equal(instances.at(-1).aborted, true);
  assert.equal(states.at(-1).state, "paused");
  setVisibility("visible");
  assert.equal(capture.running, false);
});

test("browser language pack availability can be checked and explicitly installed", async () => {
  env();
  assert.equal(await WakeWordCapture.localAvailability("en-US"), "downloadable");
  assert.equal(await WakeWordCapture.installLocal("en-US"), true);
});

test("recognizer construction failure leaves the microphone off", () => {
  const { capture, states } = env();
  window.SpeechRecognition = class { constructor() { throw new Error("browser unavailable"); } };
  assert.equal(capture.start({ phrase: "Hey Tendril", lang: "en-US", mode: "browser" }), false);
  assert.equal(capture.running, false);
  assert.equal(states.at(-1).state, "error");
});
