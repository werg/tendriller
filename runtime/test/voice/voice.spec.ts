import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let bundle = "";

test.beforeAll(async () => {
  const r = await build({ entryPoints: [join(here, "entry.ts")], bundle: true, format: "iife", target: "es2020", write: false, logLevel: "silent" });
  bundle = r.outputFiles[0].text;
});

type SessionReply = { status: number; body: any };

async function setup(page: Page, opts: { voice?: boolean; session?: SessionReply; noSR?: boolean } = {}) {
  const sessionBodies: any[] = [];
  const session = opts.session ?? { status: 200, body: { provider: "mock", client_secret: "ek_test" } };
  await page.route("http://voice.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/t/abc/s/key/_tendril/voice/session") {
      sessionBodies.push(route.request().postDataJSON());
      return route.fulfill({ status: session.status, contentType: "application/json", body: JSON.stringify(session.body) });
    }
    if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head>${opts.noSR ? "<script>delete window.webkitSpeechRecognition;delete window.SpeechRecognition;</script>" : ""}<script src="/bundle.js"></script></head><body></body></html>` });
  });
  await page.goto("http://voice.test/t/abc/s/key/");
  if (opts.voice) await page.evaluate(() => (window as any).T.setVoiceFeature(true));
  await page.evaluate(() => {
    const T = (window as any).T;
    T.voice.expose("tick", { description: "Tick an item on the shopping list", phrases: ["tick *", "mark * as done"] }, (a: any) => { T.calls.push({ name: "tick", args: a }); return `Ticked ${a.text}.`; });
    T.voice.expose("next step", { description: "Go to the next recipe step", phrases: ["next step", "next"] }, (a: any) => { T.calls.push({ name: "next step", args: a }); });
    T.voice.expose("say", { phrases: ["next *"] }, (a: any) => { T.calls.push({ name: "say", args: a }); });
  });
  return { sessionBodies };
}

const get = (page: Page, expr: string) => page.evaluate(`(() => ${expr})()`) as Promise<any>;

test.describe("phrase matcher", () => {
  test("case, punctuation, wildcards, politeness", async ({ page }) => {
    await setup(page);
    const r = await page.evaluate(() => {
      const { matchPhrase } = (window as any).T;
      const E = [{ key: "tick", phrases: ["tick *"] }, { key: "next", phrases: ["next step"] }, { key: "move", phrases: ["move * to *"] }, { key: "dont", phrases: ["don't stop"] }];
      return {
        a: matchPhrase("Tick oat milk!", E),
        b: matchPhrase("NEXT, step.", E),
        c: matchPhrase("please tick eggs, thanks", E),
        d: matchPhrase("move the chart to the left", E),
        e: matchPhrase("Don't stop!", E),
        f: matchPhrase("what's the weather", E),
        g: matchPhrase("tick", E),
        h: matchPhrase("Tick 2.5 kg flour", E),
      };
    });
    expect(r.a).toMatchObject({ key: "tick", args: { text: "oat milk" } });
    expect(r.b).toMatchObject({ key: "next", args: {} });
    expect(r.c).toMatchObject({ key: "tick", args: { text: "eggs" } });
    expect(r.d).toMatchObject({ key: "move", args: { text: "the chart", captures: ["the chart", "the left"] } });
    expect(r.e).toMatchObject({ key: "dont" });
    expect(r.f).toBeNull();
    expect(r.g).toBeNull(); // wildcard needs at least one word
    expect(r.h).toMatchObject({ key: "tick", args: { text: "2.5 kg flour" } });
  });
});

test.describe("handleUtterance, local", () => {
  test("exposed function matched with wildcard args; voice_event shape; string result spoken", async ({ page }) => {
    await setup(page);
    const handled = await get(page, `T.voice.handleUtterance("Tick oat milk, please.", "voice")`);
    expect(handled).toBe(true);
    expect(await get(page, "T.calls")).toEqual([{ name: "tick", args: { text: "oat milk" } }]);
    const raw = await get(page, "T.log.raw");
    expect(raw).toHaveLength(1);
    expect(raw[0]).toEqual({ t: "voice_event", cid: expect.stringMatching(/^v_[a-z2-7]{10}$/), text: "Tick oat milk, please.", function: "tick", args: { text: "oat milk" }, handled: true });
    const bus = await get(page, "T.log.bus");
    expect(bus).toContainEqual({ type: "voice:reply", payload: { text: "Ticked oat milk.", spoken: false } }); // _prefs.audio false
    expect(bus).toContainEqual({ type: "voice:handled", payload: { text: "Tick oat milk, please.", function: "tick", args: { text: "oat milk" } } });
  });

  test("exact phrase beats wildcard", async ({ page }) => {
    await setup(page);
    expect(await get(page, `T.voice.handleUtterance("Next step", "text")`)).toBe(true);
    expect(await get(page, `T.voice.handleUtterance("next slide please", "text")`)).toBe(true);
    expect(await get(page, "T.calls")).toEqual([{ name: "next step", args: {} }, { name: "say", args: { text: "slide" } }]);
  });

  test("unmatched returns false and sends nothing", async ({ page }) => {
    await setup(page);
    expect(await get(page, `T.voice.handleUtterance("find me a restaurant nearby", "voice")`)).toBe(false);
    expect(await get(page, "T.log.raw")).toEqual([]);
    expect(await get(page, "T.log.instructions")).toEqual([]);
  });

  test("built-in go back emits control:go_back", async ({ page }) => {
    await setup(page);
    expect(await get(page, `T.voice.handleUtterance("Go back!", "voice")`)).toBe(true);
    expect(await get(page, `T.voice.handleUtterance("undo", "voice")`)).toBe(true);
    const bus = await get(page, "T.log.bus.filter(e => e.type === 'control:go_back')");
    expect(bus).toHaveLength(2);
    const raw = await get(page, "T.log.raw");
    expect(raw[0]).toMatchObject({ t: "voice_event", text: "Go back!", function: "go_back", handled: true });
  });

  test("unregister removes the phrase; throwing fn falls through", async ({ page }) => {
    await setup(page);
    expect(await page.evaluate(() => {
      const T = (window as any).T;
      const off = T.voice.expose("boom", { phrases: ["explode"] }, () => { throw new Error("x"); });
      const off2 = T.voice.expose("zap", { phrases: ["zap"] }, () => {});
      off2();
      return Promise.all([T.voice.handleUtterance("explode", "voice"), T.voice.handleUtterance("zap", "voice")]).then((r: any) => { off(); return r; });
    })).toEqual([false, false]);
    expect(await get(page, "T.log.raw")).toEqual([]);
  });

  test("state is unavailable with no provider and no SpeechRecognition", async ({ page }) => {
    await setup(page, { noSR: true });
    expect(await get(page, "T.voice.state")).toBe("unavailable");
    await get(page, "T.voice.start()");
    expect(await get(page, "T.voice.state")).toBe("unavailable");
    await page.evaluate(() => (window as any).T.setVoiceFeature(true));
    expect(await get(page, "T.voice.state")).toBe("idle");
  });
});

test.describe("handleUtterance, realtime provider (mocked)", () => {
  test("model calls an exposed function", async ({ page }) => {
    const { sessionBodies } = await setup(page, { voice: true });
    await page.evaluate(() => (window as any).T.setScript(`return text.includes("milk") ? { tool: "tick", args: { text: "milk" }, reply: "Ticked." } : null`));
    expect(await get(page, `T.voice.handleUtterance("we're out of milk, cross it off", "voice")`)).toBe(true);
    expect(await get(page, "T.calls")).toEqual([{ name: "tick", args: { text: "milk" } }]);
    const raw = await get(page, "T.log.raw");
    expect(raw).toEqual([{ t: "voice_event", cid: expect.stringMatching(/^v_/), text: "we're out of milk, cross it off", function: "tick", args: { text: "milk" }, handled: true }]);
    // Session request: tools = exposed (sanitised names) + built-ins + ask_agent.
    expect(sessionBodies).toHaveLength(1);
    const names = sessionBodies[0].tools.map((t: any) => t.name);
    expect(names).toEqual(["tick", "next_step", "say", "go_back", "stop_listening", "ask_agent"]);
    expect(sessionBodies[0].tools[0].parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
    const conns = await get(page, "T.log.connects");
    expect(conns).toHaveLength(1);
    expect(conns[0].mic).toBe(false);
    expect(await get(page, "T.log.sent")).toEqual([{ text: "we're out of milk, cross it off", modality: "audio" }]);
    // Session is reused for the next utterance; text input asks for a text reply.
    await page.evaluate(() => (window as any).T.setScript(`return { reply: "Hello." }`));
    expect(await get(page, `T.voice.handleUtterance("hello there", "text")`)).toBe(false);
    expect(await get(page, "T.log.connects.length")).toBe(1);
    expect((await get(page, "T.log.sent"))[1]).toEqual({ text: "hello there", modality: "text" });
    expect(await get(page, "T.log.bus")).toContainEqual({ type: "voice:reply", payload: { text: "Hello.", spoken: false } });
    // Tool list updates are pushed to an open session.
    await page.evaluate(() => (window as any).T.voice.expose("zoom out", { description: "Zoom the map out" }, () => {}));
    const upd = await get(page, "T.log.updates");
    expect(upd.at(-1).map((t: any) => t.name)).toContain("zoom_out");
  });

  test("model calls ask_agent: voice_event handled:false, returns true, no instruction sent", async ({ page }) => {
    await setup(page, { voice: true });
    await page.evaluate(() => (window as any).T.setScript(`return { tool: "ask_agent", args: { request: "find dinner nearby" }, reply: "Passed to the agent." }`));
    expect(await get(page, `T.voice.handleUtterance("Find somewhere for dinner nearby", "voice")`)).toBe(true);
    const raw = await get(page, "T.log.raw");
    expect(raw).toEqual([{ t: "voice_event", cid: expect.stringMatching(/^v_/), text: "Find somewhere for dinner nearby", handled: false }]);
    expect(await get(page, "T.log.instructions")).toEqual([]);
    expect(await get(page, "T.log.bus")).toContainEqual({ type: "voice:passed", payload: { text: "Find somewhere for dinner nearby" } });
    expect(await get(page, "T.calls")).toEqual([]);
  });

  test("local phrase wins without contacting the provider", async ({ page }) => {
    const { sessionBodies } = await setup(page, { voice: true });
    expect(await get(page, `T.voice.handleUtterance("tick bread", "voice")`)).toBe(true);
    expect(sessionBodies).toHaveLength(0);
  });

  test("provider unavailable (501) returns false and backs off", async ({ page }) => {
    const { sessionBodies } = await setup(page, { voice: true, session: { status: 501, body: { error: { code: "unavailable" } } } });
    expect(await get(page, `T.voice.handleUtterance("what is this", "voice")`)).toBe(false);
    expect(await get(page, `T.voice.handleUtterance("what is that", "voice")`)).toBe(false);
    expect(sessionBodies).toHaveLength(1);
    expect(await get(page, "T.log.raw")).toEqual([]);
  });

  test("live audio: start() opens a mic session; tool call reported with the user's transcript", async ({ page }) => {
    await setup(page, { voice: true });
    await get(page, "T.voice.start()");
    expect(await get(page, "T.voice.state")).toBe("listening");
    const conns = await get(page, "T.log.connects");
    expect(conns.map((c: any) => c.mic)).toEqual([true]);
    const out = await get(page, `T.liveToolCall("tick", { text: "eggs" }, "Tick eggs.")`);
    expect(out).toEqual({ ok: true, result: "Ticked eggs." });
    expect(await get(page, "T.log.raw")).toEqual([{ t: "voice_event", cid: expect.stringMatching(/^v_/), text: "Tick eggs.", function: "tick", args: { text: "eggs" }, handled: true }]);
    await get(page, `T.liveToolCall("ask_agent", { request: "plan a route home" }, "Plan me a route home")`);
    expect((await get(page, "T.log.raw"))[1]).toMatchObject({ t: "voice_event", text: "plan a route home", handled: false });
    // "stop listening" via the model's built-in tool closes the mic session.
    await get(page, `T.liveToolCall("stop_listening", {}, "stop listening")`);
    expect(await get(page, "T.voice.state")).toBe("idle");
  });
});
