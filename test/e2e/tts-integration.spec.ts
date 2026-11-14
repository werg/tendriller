import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { agent, createPage, deletePage, openClaimed, publish, signInFixture } from "./local-helpers";

// The upstream runtime/test/tts suite covers the speech module's edge cases.
// These tests cover the agent API -> Worker -> owner page -> speech module path.

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
  await context.route("**/_tendril/tts/index.js", route => route.fulfill({ status: 200, contentType: "text/javascript", body: phonon }));
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
        constructor(url: string | URL) { if (!String(url).includes("speech-worker.js")) return new NativeWorker(url) as any; }
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

test("agent reply is displayed and played by neural voice on the owner page", async ({ page, context }) => {
  const h = await createPage();
  try {
    await publish(h, '<button id="gesture">Ready</button>');
    await setUpVoice(context, page);
    await signInFixture(context);
    await openClaimed(page, h);
    await page.locator("#gesture").click();
    const reply = await agent(h, "/say", "POST", { text: "Hello from the agent", speak: true });
    expect(reply.status).toBe(200);
    await expect(page.locator("body")).toContainText("Hello from the agent");
    await expect.poll(() => page.evaluate(() => (window as any).__ttsE2E.completed)).toEqual(["Hello from the agent"]);
    expect(await page.evaluate(() => (window as any).__ttsE2E.starts)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__ttsE2E.fallback)).toEqual([]);
  } finally { await deletePage(h); }
});

test("voice input interrupts an agent reply, reaches the event queue, and later speech recovers", async ({ page, context }) => {
  const h = await createPage();
  try {
    await publish(h, '<button id="gesture">Ready</button>');
    await setUpVoice(context, page, true);
    await signInFixture(context);
    await openClaimed(page, h);
    await page.locator("#gesture").click();
    const cursor = (await agent(h, "/events?wait=0")).data.cursor;
    expect((await agent(h, "/say", "POST", { text: "long reply", speak: true })).status).toBe(200);
    await expect.poll(() => page.evaluate(() => (window as any).__ttsE2E.spoken)).toEqual(["long reply"]);
    const mic = page.locator('[data-tendril="control"] .mic').first();
    await mic.click();
    await page.getByRole("button", { name: "Download and continue" }).click();
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await mic.click();
    await expect.poll(async () => (await agent(h, `/events?after=${cursor}&wait=0`)).data.events.some((e: any) => e.type === "instruction" && JSON.stringify(e.data).includes("voice follow up"))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__ttsE2E.aborted)).toContain("long reply");
    expect((await agent(h, "/say", "POST", { text: "recovered", speak: true })).status).toBe(200);
    await expect.poll(() => page.evaluate(() => (window as any).__ttsE2E.completed)).toContain("recovered");
    await expect(page.locator("body")).toContainText("recovered");
  } finally { await deletePage(h); }
});
