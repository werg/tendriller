import { voicePage } from "./authored-pages";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { claim, createPage, deletePage, openClaimed, publish, signInFixture } from "./local-helpers";

// The upstream runtime/test/tts suite covers the speech module's edge cases.
// These tests cover explicit page callbacks and speech ownership on a real signed page.
// The module below is a deterministic substitute. Publication-integrity behavior
// is tested separately; a service worker must never cache these substitute bytes.
test.use({ serviceWorkers: "block" });

const phonon = `
export class PhononTTS {
  static async load() {
    window.__ttsE2E.loads++;
    if (window.__ttsE2E.failLoad) throw Error('offline');
    return new PhononTTS();
  }
  sampleRate = 24000;
  stream(text, {signal}) {
    const state = window.__ttsE2E;
    state.spoken.push(text);
    signal.addEventListener('abort', () => state.aborted.push(text), {once:true});
    const stream = (async function*() {
      if (text === 'long reply') await new Promise(resolve => state.releaseLong = resolve);
      if (!signal.aborted) yield new Float32Array(2400).fill(0.01);
      state.completed.push(text);
    })();
    stream.done = Promise.resolve();
    return stream;
  }
  dispose() { window.__ttsE2E.disposals++; window.__ttsE2E.releaseLong?.(); }
}`;

async function setUpVoice(context: BrowserContext, page: Page, withInput = false) {
  await context.route(/\/_tendril\/runtime\/[a-f0-9]{64}\/tts\/index\.js$/, route => route.fulfill({ status: 200, contentType: "text/javascript", body: phonon }));
  await page.addInitScript((mockInput) => {
    const w = window as any;
    w.__ttsE2E = { loads: 0, spoken: [], completed: [], aborted: [], disposals: 0, fallback: [], starts: 0 };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak: (utterance: any) => w.__ttsE2E.fallback.push(utterance.text), cancel() {} } });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: any[]) { w.__ttsE2E.starts++; return start.apply(this, args as any); };
    if (mockInput) {
      const NativeWorker = window.Worker;
      w.Worker = class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor(url: string | URL) { if (!String(url).includes("voice-worker.js")) return new NativeWorker(url) as any; }
        postMessage(message: any) {
          queueMicrotask(() => this.onmessage?.({ data: message.action === "init" ? { id: message.id, ready: true } : { id: message.id, text: "voice follow up" } } as MessageEvent));
        }
        terminate() {}
      };
      w.OfflineAudioContext = class {
        async decodeAudioData() { return { numberOfChannels: 1, length: 16000, sampleRate: 16000, getChannelData: () => new Float32Array(16000) }; }
      };
    }
  }, withInput);
}

test("an explicit page action displays and plays neural speech", async ({ page, context }) => {
  const h = await createPage();
  try {
    await signInFixture(context);
    await claim(context, h);
    await publish(h, voicePage);
    await setUpVoice(context, page);
    await openClaimed(page, h);
    await page.waitForFunction(() => !!(window as any).voice);
    await page.locator("#enable-speech").click();
    await expect.poll(() => page.evaluate(() => (window as any).voice.outputStatus.state)).toBe("ready");
    await page.evaluate(() => (window as any).speakReviewed("Hello from the agent"));
    await expect(page.locator("body")).toContainText("Hello from the agent");
    await expect.poll(() => page.evaluate(() => (window as any).__ttsE2E.completed)).toEqual(["Hello from the agent"]);
    expect(await page.evaluate(() => (window as any).__ttsE2E.starts)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__ttsE2E.fallback)).toEqual([]);
  } finally { await deletePage(h); }
});

test("voice input interrupts speech, reaches the page callback, and later output recovers", async ({ page, context }) => {
  const h = await createPage();
  try {
    await signInFixture(context);
    await claim(context, h);
    await publish(h, voicePage);
    await setUpVoice(context, page, true);
    await openClaimed(page, h);
    await page.waitForFunction(() => !!(window as any).voice);
    await page.locator("#enable-speech").click();
    await expect.poll(() => page.evaluate(() => (window as any).voice.outputStatus.state)).toBe("ready");
    await page.evaluate(() => (window as any).speakReviewed("long reply"));
    await expect.poll(() => page.evaluate(() => (window as any).__ttsE2E.spoken)).toEqual(["long reply"]);
    const mic = page.locator("#record");
    await mic.click();
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await mic.click();
    await expect(page.locator("#draft")).toHaveValue("voice follow up");
    await expect.poll(() => page.evaluate(() => (window as any).__ttsE2E.aborted)).toContain("long reply");
    await page.evaluate(() => (window as any).speakReviewed("recovered"));
    await expect.poll(() => page.evaluate(() => (window as any).__ttsE2E.completed)).toContain("recovered");
    await expect(page.locator("body")).toContainText("recovered");
  } finally { await deletePage(h); }
});
