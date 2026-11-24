import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serveWakePipeline } from "../../test/e2e/wake-pipeline-fixture";

test("real browser AudioWorklet segments microphone PCM, sends one bounded utterance and releases tracks", async ({ page }, info) => {
  const fixture = await serveWakePipeline(false);
  const evidence = async (name: string, value: unknown) => {
    const path = info.outputPath(name + ".json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + "\n");
    await info.attach(name, { path, contentType: "application/json" });
  };
  try {
    await page.goto(fixture.origin);
    await expect(page.locator("#start")).toBeEnabled();
    expect(await page.evaluate(() => (window as any).wakePipeline.starts)).toBe(0);
    // WebKit may collect a DOM wrapper between setup and the user gesture. The
    // synthetic microphone must survive that collection without using real input.
    await page.requestGC();
    await page.locator("#start").click();
    await page.waitForFunction(() => (window as any).wakePipeline.started || (window as any).wakePipeline.error);
    const supported = await page.evaluate(() => (window as any).wakePipeline.supported);
    if (!supported) {
      const stopped = await page.evaluate(() => ({ active: (window as any).wakePipeline.voice.microphoneActive, requests: (window as any).wakePipeline.starts, message: (window as any).wakePipeline.error }));
      expect(stopped.active).toBe(false); expect(stopped.requests).toBe(0); expect(stopped.message).toBeTruthy();
      await evidence("unsupported-audio", stopped);
      return;
    }
    expect(await page.evaluate(() => (window as any).wakePipeline.error)).toBeNull();
    expect(await page.evaluate(() => (window as any).wakePipeline.starts)).toBe(1);
    await page.waitForFunction(() => (window as any).wakePipeline.readyToPlay);
    await page.evaluate(() => (window as any).wakePipeline.play());
    await expect.poll(() => page.evaluate(() => (window as any).wakePipeline.commands), { timeout: 15_000 }).toEqual(["measured acoustic pipeline"]);
    const stats = await page.evaluate(() => (window as any).wakePipeline.stats);
    expect(stats).toHaveLength(1); expect(stats[0].samples).toBeGreaterThan(3200); expect(stats[0].samples).toBeLessThanOrEqual(128000); expect(stats[0].rms).toBeGreaterThan(0.001); expect(stats[0].finite).toBe(true);
    await page.locator("#stop").click();
    expect(await page.evaluate(() => (window as any).wakePipeline.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
    expect(await page.evaluate(() => (window as any).wakePipeline.voice.microphoneActive)).toBe(false);
    expect(fixture.requests.every(request => request.method === "GET")).toBe(true);
    await evidence("pcm-evidence", { fixture_sha256: fixture.fixture.sha256, stats, environment: info.project.name, inference: "deterministic fixture; actual browser audio capture graph and AudioWorklet", physical_microphone: false });
  } catch (error) {
    const state = await page.evaluate(() => {
      const pipeline = (window as any).wakePipeline;
      return {
        started: pipeline?.started, error: pipeline?.error, requests: pipeline?.starts,
        states: pipeline?.states, stats: pipeline?.stats,
        syntheticMicrophone: Object.prototype.hasOwnProperty.call(navigator.mediaDevices, "getUserMedia"),
        tracks: pipeline?.streams.flatMap((stream: MediaStream) => stream.getAudioTracks().map(track => ({ readyState: track.readyState, muted: track.muted }))),
      };
    }).catch(captureError => ({ captureError: String(captureError) }));
    await evidence("pcm-failure", { environment: info.project.name, state, requests: fixture.requests });
    throw error;
  } finally { await page.evaluate(() => (window as any).wakePipeline?.close()).catch(() => {}); await fixture.close(); }
});
