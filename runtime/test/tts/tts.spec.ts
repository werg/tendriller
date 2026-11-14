import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let entry: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("./entry.ts", import.meta.url))], bundle: true, format: "iife", write: false });
  entry = result.outputFiles[0].text;
});

const module = `
window.loads = (window.loads || 0) + 1;
export class PhononTTS {
  static async load(options) {
    window.initializations = (window.initializations || 0) + 1;
    window.loadOptions = options;
    options.onProgress({file:'weights',loaded:30e6,total:65e6,cached:false});
    if (window.holdLoad) await new Promise(resolve => window.releaseLoad = resolve);
    if (window.failLoad) throw Error('offline');
    return new PhononTTS();
  }
  sampleRate = 24000;
  stream(text, {signal}) {
    window.spoken.push(text);
    const stalled = text === 'stall';
    const done = stalled ? new Promise(resolve => window.releaseDone = resolve) : Promise.resolve({});
    signal.addEventListener('abort', () => window.cancelSeen = true, {once:true});
    const stream = (async function*() {
      try {
        if (stalled) await new Promise(resolve => window.releaseStall = resolve);
        for(let i=0;i<(text==='empty'?0:text==='long'?200:1);i++) {
          if(signal.aborted) break;
          yield new Float32Array(2400).fill(0.01);
          await new Promise(resolve=>setTimeout(resolve, 5));
        }
      } finally { window.completed.push(text); }
    })();
    stream.done = done;
    return stream;
  }
  dispose() { window.disposals++; window.releaseStall?.(); window.releaseDone?.({}); }
}`;

async function open(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.spoken = []; w.browserSpoken = []; w.completed = []; w.disposals = 0; w.starts = 0; w.stops = 0;
    Object.defineProperty(window, "speechSynthesis", { value: { speak: (u: any) => w.browserSpoken.push(u.text), cancel() {} } });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args: any[]) { w.starts++; return start.apply(this, args as any); };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function(...args: any[]) { w.stops++; return stop.apply(this, args as any); };
  });
  await page.route("http://localhost:7789/**", route => {
    if (route.request().url().endsWith("/_tendril/tts/index.js")) return route.fulfill({body:module, contentType:"text/javascript"});
    return route.fulfill({body:`<!doctype html><meta charset="utf-8"><script>${entry}</script>`, contentType:"text/html"});
  });
  await page.goto("http://localhost:7789/page/");
}

test("neural speech is default and lazy; replies play sequentially", async ({page}) => {
  await open(page);
  expect(await page.evaluate(() => (window as any).tts.status.enabled)).toBe(true);
  expect(await page.evaluate(() => (window as any).loads || 0)).toBe(0);
  await page.evaluate(() => { const w=window as any; w.tts.speak('first'); w.tts.speak('second'); });
  await expect.poll(() => page.evaluate(() => (window as any).completed)).toEqual(['first','second']);
  expect(await page.evaluate(() => ({spoken:(window as any).spoken, browser:(window as any).browserSpoken, starts:(window as any).starts}))).toEqual({spoken:['first','second'],browser:[],starts:2});
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('ready');
});

test("mute and non-English preferences avoid the model download", async ({page}) => {
  await open(page);
  await page.evaluate(() => { const w=window as any; w.prefs.audio=false; w.tts.speak('muted'); });
  await page.evaluate(() => { const w=window as any; w.prefs={language:'de-DE'}; w.tts.speak('Guten Tag'); });
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['Guten Tag']);
  expect(await page.evaluate(() => (window as any).loads || 0)).toBe(0);
});

test("failed model falls back without repeated downloads and can retry", async ({page}) => {
  await open(page);
  await page.evaluate(() => { const w=window as any; w.failLoad=true; w.tts.speak('fallback'); w.tts.speak('next'); });
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['fallback','next']);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('error');
  await page.evaluate(async () => { const w=window as any; w.failLoad=false; await w.tts.enable(); w.tts.speak('retry'); });
  await expect.poll(() => page.evaluate(() => (window as any).spoken)).toEqual(['retry']);
});

test("stop discards pending and queued replies while model is loading", async ({page}) => {
  await open(page);
  await page.evaluate(() => { const w=window as any; w.holdLoad=true; w.tts.speak('old'); w.tts.speak('queued'); });
  await page.waitForFunction(() => !!(window as any).releaseLoad);
  await page.evaluate(() => { const w=window as any; w.tts.stop(); w.releaseLoad(); });
  await expect.poll(() => page.evaluate(() => (window as any).tts.status.state)).toBe('ready');
  await page.evaluate(() => (window as any).tts.speak('fresh'));
  await expect.poll(() => page.evaluate(() => (window as any).completed)).toEqual(['fresh']);
  expect(await page.evaluate(() => (window as any).browserSpoken)).toEqual([]);
});

test("stop interrupts scheduled audio and a browser choice survives reload", async ({page}) => {
  await open(page);
  await page.evaluate(() => (window as any).tts.speak('long'));
  await expect.poll(() => page.evaluate(() => (window as any).starts)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).tts.disable());
  expect(await page.evaluate(() => (window as any).stops)).toBeGreaterThan(0);
  await page.reload();
  expect(await page.evaluate(() => (window as any).tts.status.enabled)).toBe(false);
  await page.evaluate(() => (window as any).tts.speak('browser only'));
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['browser only']);
  expect(await page.evaluate(() => (window as any).loads || 0)).toBe(0);
});

test("disabling during a download disposes the late model", async ({page}) => {
  await open(page);
  await page.evaluate(() => { const w=window as any; w.holdLoad=true; w.tts.speak('cancel'); });
  await page.waitForFunction(() => !!(window as any).releaseLoad);
  await page.evaluate(() => { const w=window as any; w.tts.disable(); w.releaseLoad(); });
  await expect.poll(() => page.evaluate(() => (window as any).disposals)).toBe(1);
  expect(await page.evaluate(() => (window as any).spoken)).toEqual([]);
  expect(await page.evaluate(() => (window as any).tts.status.enabled)).toBe(false);
});

test("empty neural output falls back rather than silently dropping the reply", async ({page}) => {
  await open(page);
  await page.evaluate(() => (window as any).tts.speak('empty'));
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['empty']);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('error');
});

test("unsupported browsers use browser speech without downloading a model", async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    Object.defineProperty(window, 'Worker', {value:undefined});
    (window as any).tts.speak('fallback');
  });
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['fallback']);
  expect(await page.evaluate(() => (window as any).loads || 0)).toBe(0);
});

test("retrying a ready voice preserves the ready status and reuses its model", async ({page}) => {
  await open(page);
  await page.evaluate(async () => { const w=window as any; await w.tts.enable(); await w.tts.enable(); });
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('ready');
  expect(await page.evaluate(() => (window as any).initializations)).toBe(1);
});

test("autoplay rejection preserves the model and neural speech recovers after interaction", async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    const w=window as any;
    const state = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state')!;
    Object.defineProperty(AudioContext.prototype, 'state', {get() { return w.blockAudio ? 'suspended' : state.get!.call(this); }});
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function() { return w.blockAudio ? Promise.reject(Error('autoplay blocked')) : resume.call(this); };
    w.blockAudio = true;
    w.tts.speak('blocked');
  });
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['blocked']);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('ready');
  await page.evaluate(() => { const w=window as any; w.blockAudio=false; w.tts.speak('unblocked'); });
  await expect.poll(() => page.evaluate(() => (window as any).completed)).toEqual(['unblocked']);
  expect(await page.evaluate(() => (window as any).initializations)).toBe(1);
  expect(await page.evaluate(() => (window as any).disposals)).toBe(0);
});

test("stop releases an unresponsive worker before the next reply starts", async ({page}) => {
  await open(page);
  await page.clock.install();
  await page.evaluate(() => (window as any).tts.speak('stall'));
  await page.waitForFunction(() => !!(window as any).releaseStall);
  await page.evaluate(() => { const w=window as any; w.tts.stop(); w.tts.speak('fresh'); });
  await page.waitForFunction(() => !!(window as any).cancelSeen);
  await page.clock.fastForward(1100);
  await expect.poll(() => page.evaluate(() => (window as any).spoken)).toEqual(['stall','fresh']);
  expect(await page.evaluate(() => (window as any).disposals)).toBe(1);
  expect(await page.evaluate(() => (window as any).initializations)).toBe(2);
});

test("a stalled synthesis falls back instead of blocking the reply queue forever", async ({page}) => {
  await open(page);
  await page.clock.install();
  await page.evaluate(() => { const w=window as any; w.tts.speak('stall'); w.tts.speak('next'); });
  await page.waitForFunction(() => !!(window as any).releaseStall);
  await page.clock.fastForward(30_001);
  await page.waitForFunction(() => !!(window as any).cancelSeen);
  await page.clock.fastForward(1100);
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['stall','next']);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('error');
});

test("returning to a page does not reuse an invalidated in-flight model load", async ({page}) => {
  await open(page);
  await page.evaluate(() => { const w=window as any; w.holdLoad=true; w.tts.speak('old'); });
  await page.waitForFunction(() => !!(window as any).releaseLoad);
  await page.evaluate(() => { const w=window as any; window.dispatchEvent(new Event('pagehide')); w.releaseLoad(); });
  await expect.poll(() => page.evaluate(() => (window as any).disposals)).toBe(1);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('idle');
  await page.evaluate(async () => { const w=window as any; w.holdLoad=false; await w.tts.enable(); w.tts.speak('fresh'); });
  await expect.poll(() => page.evaluate(() => (window as any).spoken)).toEqual(['fresh']);
});
