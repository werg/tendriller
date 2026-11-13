// Node test for server/src/voice.ts with a mocked fetch (no real provider key).
// Run: node --test runtime/test/voice/server-voice.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const r = await build({ entryPoints: [join(here, "../../../server/src/voice.ts")], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent" });
const file = join(mkdtempSync(join(tmpdir(), "voice-test-")), "voice.mjs");
writeFileSync(file, r.outputFiles[0].text);
const voice = await import(pathToFileURL(file).href);

const KEY = "sk-test-SECRET-123";
const ctx = { tendrilId: "abcdefghijkl", name: "Kitchen" };
const req = (body, method = "POST") => new Request("https://x.test/t/abcdefghijkl/s/key/_tendril/voice/session", { method, headers: { "content-type": "application/json" }, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });

function mockFetch(responder) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null }); return responder(url, init); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test("voiceAvailable", () => {
  assert.equal(voice.voiceAvailable({}), false);
  assert.equal(voice.voiceAvailable({ OPENAI_API_KEY: KEY }), true);
  assert.equal(voice.voiceAvailable({ VOICE_PROVIDER: "openai-realtime", OPENAI_API_KEY: KEY }), true);
  assert.equal(voice.voiceAvailable({ VOICE_PROVIDER: "openai-realtime" }), false);
  assert.equal(voice.voiceAvailable({ VOICE_PROVIDER: "other", OPENAI_API_KEY: KEY }), false);
});

test("501 when unconfigured, no fetch", async () => {
  const m = mockFetch(() => { throw new Error("should not fetch"); });
  try {
    const res = await voice.handleVoiceSession(req({ tools: [] }), {}, ctx);
    assert.equal(res.status, 501);
    assert.deepEqual((await res.json()).error.code, "unavailable");
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test("mints an OpenAI client secret with session config; key not returned", async () => {
  const m = mockFetch(async () => Response.json({ value: "ek_abc", expires_at: 1763000000, session: { type: "realtime", model: "gpt-realtime-2.1" } }));
  try {
    const res = await voice.handleVoiceSession(req({
      instructions: "This page: shopping list",
      tools: [{ name: "tick", description: "Tick an item", parameters: { type: "object", properties: { text: { type: "string" } } } }, { name: "next_step", description: "Next" }, { name: "ask_agent", description: "page version ignored", parameters: {} }],
    }), { OPENAI_API_KEY: KEY }, ctx);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(KEY), "API key must never reach the browser");
    const j = JSON.parse(text);
    assert.deepEqual(j, { provider: "openai-realtime", client_secret: "ek_abc", expires_at: 1763000000, model: "gpt-realtime-2.1", voice: "marin", calls_url: "https://api.openai.com/v1/realtime/calls" });
    assert.equal(m.calls.length, 1);
    const c = m.calls[0];
    assert.equal(c.url, "https://api.openai.com/v1/realtime/client_secrets");
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
    assert.match(c.init.headers["OpenAI-Safety-Identifier"], /^[0-9a-f]{64}$/);
    const s = c.body.session;
    assert.equal(s.type, "realtime");
    assert.equal(s.model, voice.DEFAULT_OPENAI_MODEL);
    assert.equal(c.body.expires_after.anchor, "created_at");
    assert.ok(c.body.expires_after.seconds >= 10 && c.body.expires_after.seconds <= 7200);
    assert.match(s.instructions, /fast voice layer/);
    assert.match(s.instructions, /"Kitchen"/);
    assert.match(s.instructions, /This page: shopping list/);
    assert.deepEqual(s.tools.map((t) => t.name), ["tick", "next_step", "ask_agent"]);
    assert.ok(s.tools.every((t) => t.type === "function"));
    assert.deepEqual(s.tools[1].parameters, { type: "object", properties: {} });
    assert.deepEqual(s.tools[2], { type: "function", ...voice.ASK_AGENT_TOOL });
    assert.equal(s.audio.output.voice, "marin");
    assert.equal(s.tool_choice, "auto");
  } finally { m.restore(); }
});

test("VOICE_MODEL overrides the default", async () => {
  const m = mockFetch(async () => Response.json({ value: "ek_x", expires_at: 1 }));
  try {
    const res = await voice.handleVoiceSession(req({ tools: [] }), { OPENAI_API_KEY: KEY, VOICE_PROVIDER: "openai-realtime", VOICE_MODEL: "gpt-realtime-mini" }, ctx);
    assert.equal(res.status, 200);
    assert.equal(m.calls[0].body.session.model, "gpt-realtime-mini");
    assert.equal((await res.json()).model, "gpt-realtime-mini");
  } finally { m.restore(); }
});

test("bad input → 400 without calling the provider", async () => {
  const m = mockFetch(() => { throw new Error("should not fetch"); });
  try {
    for (const body of ["not json", { tools: "x" }, { tools: [{ name: "has space" }] }, { tools: [{ name: "a", parameters: [] }] }, [1]]) {
      const res = await voice.handleVoiceSession(req(body), { OPENAI_API_KEY: KEY }, ctx);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const res = await voice.handleVoiceSession(req(null, "GET"), { OPENAI_API_KEY: KEY }, ctx);
    assert.equal(res.status, 405);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test("provider error → 502 provider_error, key not leaked", async () => {
  const m = mockFetch(async () => Response.json({ error: { message: "Invalid model" } }, { status: 400 }));
  try {
    const res = await voice.handleVoiceSession(req({ tools: [] }), { OPENAI_API_KEY: KEY }, ctx);
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.ok(!text.includes(KEY));
    assert.equal(JSON.parse(text).error.code, "provider_error");
    assert.match(JSON.parse(text).error.message, /Invalid model/);
  } finally { m.restore(); }
  const m2 = mockFetch(async () => { throw new TypeError("network down"); });
  try {
    const res = await voice.handleVoiceSession(req({ tools: [] }), { OPENAI_API_KEY: KEY }, ctx);
    assert.equal(res.status, 502);
  } finally { m2.restore(); }
});
