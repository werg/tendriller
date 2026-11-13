import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fake-tendril.js", import.meta.url));

/** Open the blank page with the fake window.tendril, then load the named snippets. */
export async function load(page: Page, ...snippets: string[]) {
  await page.addInitScript({ path: FAKE });
  await page.goto("/blank.html");
  for (const s of snippets) await page.addScriptTag({ url: `/${s}.js` });
}

export const calls = (page: Page) => page.evaluate(() => (window as any).__calls);

let netCache: Promise<boolean> | null = null;
/** Whether jsDelivr is reachable from this machine (CDN-dependent tests skip otherwise). */
export function cdnReachable(): Promise<boolean> {
  return (netCache ||= fetch("https://cdn.jsdelivr.net/npm/qrcode-generator@2/package.json", { signal: AbortSignal.timeout(8000) })
    .then((r) => r.ok)
    .catch(() => false));
}

/** Install a scriptable SpeechRecognition before page scripts run. */
export async function fakeSpeech(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__sr = { instances: [] as any[], starts: 0 };
    class FakeSR {
      lang = ""; continuous = false; interimResults = false;
      onresult: any = null; onend: any = null; onerror: any = null;
      results: any[] = [];
      running = false;
      constructor() { w.__sr.instances.push(this); w.__sr.last = this; }
      start() { this.running = true; w.__sr.starts++; }
      stop() { if (this.running) { this.running = false; setTimeout(() => this.onend && this.onend(), 0); } }
      abort() { this.stop(); }
      // test helpers
      say(text: string, isFinal = true) {
        const r: any = [{ transcript: text, confidence: 0.9 }];
        r.isFinal = isFinal;
        const idx = this.results.length && !this.results[this.results.length - 1].isFinal ? this.results.length - 1 : this.results.length;
        this.results[idx] = r;
        this.onresult && this.onresult({ resultIndex: idx, results: this.results });
      }
      end() { this.running = false; this.onend && this.onend(); }
    }
    w.SpeechRecognition = FakeSR;
    w.webkitSpeechRecognition = FakeSR;
  });
}
