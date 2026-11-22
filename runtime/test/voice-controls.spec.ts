import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

// Real DOM, focus, trusted input and viewport checks. The adapter is deliberately
// deterministic here; model/audio behavior has its own tests and device gate.
const adapter = `
export function createVoice(runtime, handlers) {
  const fixture = window.voiceFixture = {
    requests: [], starts: [], language: null, microphone: false, stops: 0,
    disposed: false, generation: 0, pending: [],
    wake: {state:'off',message:''}, capture:{state:'idle',message:''},
    report(kind,state,message='',microphone) {
      if (microphone !== undefined) this.microphone = microphone;
      this[kind] = {state,message}; handlers.status?.({kind,state,message});
    },
    complete() {
      const pending = this.pending.shift(); if (!pending) return;
      if (pending.generation !== this.generation) { pending.resolve(false); return; }
      this.report(pending.kind,pending.kind === 'wake' ? 'listening' : 'recording','Listening on this device',true);
      pending.resolve(true);
    },
    fail(message) {
      const pending = this.pending.shift();
      this.report(pending?.kind || 'wake','error',message,false); pending?.resolve(false);
    },
    text(text) { handlers.transcript(text); },
  };
  const stop = () => {
    fixture.generation++; fixture.stops++; fixture.microphone = false;
    for (const pending of fixture.pending.splice(0)) pending.resolve(false);
    fixture.report('wake','off'); fixture.report('capture','idle');
  };
  const start = (kind, settings) => {
    const purpose = kind === 'wake' ? 'wake' : 'transcription';
    const accepted = handlers.consent({purpose,engine:'cactus-whistle',description:'Pinned local model'});
    fixture.requests.push({purpose,accepted});
    if (accepted !== true || fixture.disposed) return Promise.resolve(false);
    fixture.starts.push({kind,settings});
    fixture.report(kind,kind === 'wake' ? 'loading' : 'working','Verifying private speech assets',false);
    return new Promise(resolve => fixture.pending.push({resolve,kind,generation:fixture.generation}));
  };
  return {
    get wakeStatus(){return fixture.wake;}, get captureStatus(){return fixture.capture;},
    get settings(){return {language:'en-US',wakePhrase:'Listen computer',wakeMode:'model'};},
    get microphoneActive(){return fixture.microphone;}, get listening(){return fixture.microphone;},
    startWake(settings){return start('wake',settings);}, startCapture(){return start('capture');},
    language(tag){stop();fixture.language=tag;}, stop, stopWake:stop,
    finishCapture(){fixture.report('capture','working','Transcribing on this device',false);},
    cancelCapture:stop,
    dispose(){stop();fixture.disposed=true;},
  };
}`;

let origin: string, server: Server;
test.beforeAll(async () => {
  const compiled = await build({
    entryPoints: [new URL("../src/voice/controls.ts", import.meta.url).pathname],
    bundle: true, format: "esm", platform: "browser", write: false,
    plugins: [{ name: "deterministic-voice-adapter", setup(build) {
      build.onResolve({ filter: /^\.\/index$/ }, args => args.importer.endsWith("/voice/controls.ts")
        ? { path: "voice-fixture", namespace: "voice-fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "voice-fixture" }, () => ({ contents: adapter, loader: "js" }));
    } }],
  });
  server = createServer((request, response) => {
    if (request.url === "/controls.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(compiled.outputFiles[0].text); return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voice controls qualification</title>
      <main><h1>Authored application</h1><button id="outside">Unrelated action</button></main>
      <script type="module">
      import {mountVoiceControls} from '/controls.js';
      window.delivered=[];window.copied=[];
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copied.push(text)}});
      const options = new URL(location.href).searchParams.has('copy') ? {} : {transcript:text=>window.delivered.push(text)};
      window.voiceControls=mountVoiceControls({},options);
      </script></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No voice controls server address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (!server) return;
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections(); await closed;
});
test.beforeEach(async ({ page }) => {
  await page.goto(origin);
  await page.waitForFunction(() => !!(window as any).voiceControls);
});

test("mounting is inert, disclosures precede capture, and synthetic activation cannot enable it", async ({ page }) => {
  await expect(page.getByText("Microphone off", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceFixture.requests)).toEqual([]);
  await page.evaluate(() => (document.querySelector("tendril-voice-controls")!.shadowRoot!.querySelector('button[aria-controls="voice-panel"]') as HTMLButtonElement).click());
  await expect(page.getByRole("region", { name: "Voice input", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await page.getByRole("button", { name: "Set up wake word" }).click();
  await expect(page.getByRole("heading", { name: "Enable on-device wake word?" })).toBeVisible();
  await expect(page.getByText(/18,224,260 bytes/)).toBeVisible();
  await expect(page.getByText(/Wake phrase: “Listen computer”/)).toBeVisible();
  await expect(page.getByText(/Background Web Push notifications use no microphone/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toEqual([]);
  await page.getByRole("button", { name: "Start microphone", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toEqual([]);
  expect(await page.evaluate(() => (window as any).voiceControls.voice.startWake({phrase:"Remote action",mode:"model"}))).toBe(false);
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByText("Microphone off · Preparing", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toEqual([{kind:"wake",settings:{phrase:"Listen computer",mode:"model"}}]);
  await page.evaluate(() => (window as any).voiceFixture.complete());
  await expect(page.getByText("Microphone on · Listening", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close voice input" }).click();
  await expect(page.getByRole("button", { name: "Stop microphone", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop microphone", exact: true }).click();
  await expect(page.getByText("Microphone off", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceControls.voice.startWake({phrase:"Remote action",mode:"model"}))).toBe(false);
});

test("keyboard controls retain focus, cancel consent with Escape, and validate phrases", async ({ page }) => {
  const voice = page.getByRole("button", { name: "Voice", exact: true });
  await voice.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Voice input", exact: true })).toBeFocused();
  const phrase = page.getByRole("textbox", { name: "Wake phrase", exact: true });
  await phrase.fill("hello");
  await page.getByRole("button", { name: "Set up wake word" }).click();
  await expect(page.getByRole("alert")).toContainText("at least two words");
  await expect(phrase).toBeFocused();
  await phrase.fill("Hallo Tendril");
  await page.getByRole("combobox", { name: "Speech language" }).selectOption("de-DE");
  await page.getByRole("button", { name: "Set up wake word" }).focus(); await page.keyboard.press("Space");
  await expect(page.getByRole("heading", { name: "Enable on-device wake word?" })).toBeFocused();
  await page.evaluate(() => { (window as any).outerEscapes = 0; document.addEventListener("keydown", event => { if (event.key === "Escape") (window as any).outerEscapes++; }); });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Set up wake word" })).toBeFocused();
  expect(await page.evaluate(() => (window as any).outerEscapes)).toBe(0);
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toEqual([]);
  await page.keyboard.press("Escape"); await expect(voice).toBeFocused();
});

test("model progress leaves microphone off, stop cancels preparation, and failures preserve typed fallback", async ({ page }) => {
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Text to review or type" });
  await draft.fill("Keep my typed draft");
  await page.getByRole("button", { name: "Set up wake word" }).click();
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await page.getByRole("button", { name: "Cancel preparation" }).click();
  await page.evaluate(() => (window as any).voiceFixture.complete());
  await expect(page.getByText("Microphone off", { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("Keep my typed draft");
  await page.getByRole("button", { name: "Set up wake word" }).click();
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await page.evaluate(() => (window as any).voiceFixture.fail("Microphone permission was denied. Check site settings."));
  await expect(page.getByRole("alert")).toContainText("permission was denied");
  await expect(draft).toHaveValue("Keep my typed draft");
  await page.getByRole("button", { name: "Use text", exact: true }).click();
  expect(await page.evaluate(() => (window as any).delivered)).toEqual(["Keep my typed draft"]);
  await expect(page.getByText("Text shared with this page.", { exact: true })).toBeVisible();
});

test("detected commands become editable drafts and are delivered only through a trusted Use text click", async ({ page }) => {
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Text to review or type" });
  await draft.fill("Existing thought");
  await page.evaluate(() => (window as any).voiceFixture.text("Record the temperature"));
  await expect(draft).toHaveValue("Existing thought\nRecord the temperature");
  expect(await page.evaluate(() => (window as any).delivered)).toEqual([]);
  await draft.fill("Reviewed temperature is 18 degrees");
  await page.getByRole("button", { name: "Use text", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => (window as any).delivered)).toEqual([]);
  await page.getByRole("button", { name: "Use text", exact: true }).click();
  expect(await page.evaluate(() => (window as any).delivered)).toEqual(["Reviewed temperature is 18 degrees"]);
  await expect(draft).toHaveValue("");
});

test("tap-to-talk has separate consent, explicit finish and cancel, and a visible recording state", async ({ page }) => {
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await page.getByRole("button", { name: "Record a message", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enable on-device recording?" })).toBeVisible();
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByText("Microphone off · Preparing", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).voiceFixture.complete());
  await expect(page.getByText("Microphone on · Recording", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await expect(page.getByText("Microphone off · Transcribing", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel voice input", exact: true }).click();
  await expect(page.getByText("Microphone off", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).delivered)).toEqual([]);
});

test("generic hosted controls copy a reviewed draft without inventing application commands", async ({ page }) => {
  await page.goto(`${origin}/?copy`);
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Text to review or type" });
  await draft.fill("Reviewed generic page input");
  await expect(page.getByRole("button", { name: "Use text", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Copy text", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copied)).toEqual(["Reviewed generic page input"]);
  expect(await page.evaluate(() => (window as any).delivered)).toEqual([]);
  await expect(draft).toHaveValue("Reviewed generic page input");
  await expect(page.getByText("Text copied. Paste it where you want to use it.", { exact: true })).toBeVisible();
});

test("mobile layout stays within the viewport and disposal removes controls and stops the adapter", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await page.getByRole("button", { name: "Set up wake word" }).click();
  const panel = page.getByRole("region", { name: "Voice input", exact: true });
  const bounds = await panel.boundingBox();
  expect(bounds).toBeTruthy(); expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320); expect(bounds!.y).toBeGreaterThanOrEqual(0);
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await page.evaluate(() => (window as any).voiceFixture.complete());
  const activeBounds = await panel.boundingBox();
  expect(activeBounds!.y).toBeGreaterThanOrEqual(0);
  await expect(page.getByRole("button", { name: "Stop microphone", exact: true })).toBeInViewport();
  await page.evaluate(() => (window as any).voiceControls.dispose());
  await expect(page.locator("tendril-voice-controls")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).voiceFixture.disposed)).toBe(true);
  await page.evaluate(() => (window as any).voiceFixture.complete());
  expect(await page.evaluate(() => (window as any).voiceFixture.microphone)).toBe(false);
});
