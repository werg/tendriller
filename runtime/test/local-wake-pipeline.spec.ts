import { test, expect } from "@playwright/test";
import { serveWakePipeline } from "../../test/e2e/wake-pipeline-fixture";

test("real browser AudioWorklet segments microphone PCM, sends one bounded utterance and releases tracks", async ({ page }, info) => {
  const fixture = await serveWakePipeline(false);
  try {
    await page.goto(fixture.origin);
    await expect(page.locator("#start")).toBeEnabled();
    expect(await page.evaluate(() => (window as any).wakePipeline.starts)).toBe(0);
    await page.locator("#start").click();
    await page.waitForFunction(() => (window as any).wakePipeline.started || (window as any).wakePipeline.error);
    const supported = await page.evaluate(() => (window as any).wakePipeline.supported);
    if (!supported) {
      const stopped = await page.evaluate(() => ({ active: (window as any).wakePipeline.voice.microphoneActive, requests: (window as any).wakePipeline.starts, message: (window as any).wakePipeline.error }));
      expect(stopped.active).toBe(false); expect(stopped.requests).toBe(0); expect(stopped.message).toBeTruthy();
      await info.attach("unsupported-audio", { body: JSON.stringify(stopped), contentType: "application/json" });
      return;
    }
    expect(await page.evaluate(() => (window as any).wakePipeline.error)).toBeNull();
    await page.waitForFunction(() => (window as any).wakePipeline.readyToPlay);
    await page.evaluate(() => (window as any).wakePipeline.play());
    await expect.poll(() => page.evaluate(() => (window as any).wakePipeline.commands), { timeout: 15_000 }).toEqual(["measured acoustic pipeline"]);
    const stats = await page.evaluate(() => (window as any).wakePipeline.stats);
    expect(stats).toHaveLength(1); expect(stats[0].samples).toBeGreaterThan(3200); expect(stats[0].samples).toBeLessThanOrEqual(128000); expect(stats[0].rms).toBeGreaterThan(0.001); expect(stats[0].finite).toBe(true);
    await page.locator("#stop").click();
    expect(await page.evaluate(() => (window as any).wakePipeline.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
    expect(await page.evaluate(() => (window as any).wakePipeline.voice.microphoneActive)).toBe(false);
    expect(fixture.requests.every(request => request.method === "GET")).toBe(true);
    await info.attach("pcm-evidence", { body: JSON.stringify({ fixture_sha256: fixture.fixture.sha256, stats, environment: info.project.name, inference: "deterministic fixture; actual browser audio capture graph and AudioWorklet", physical_microphone: false }), contentType: "application/json" });
  } finally { await page.evaluate(() => (window as any).wakePipeline?.close()).catch(() => {}); await fixture.close(); }
});
