import { test, expect } from "@playwright/test";
import { serveWakePipeline } from "./wake-pipeline-fixture";

test("pinned model detects a wake phrase through the actual voice adapter and AudioWorklet", async ({ page }, info) => {
  test.skip(process.env.E2E_REAL_SPEECH !== "1", "Run the explicit real-model qualification");
  test.setTimeout(180_000);
  const fixture = await serveWakePipeline(true);
  try {
    await page.goto(fixture.origin);
    await expect(page.locator("#start")).toBeEnabled();
    expect(await page.evaluate(() => (window as any).wakePipeline.starts)).toBe(0);
    await page.locator("#start").click();
    await page.waitForFunction(() => (window as any).wakePipeline.started || (window as any).wakePipeline.error, undefined, { timeout: 150_000 });
    expect(await page.evaluate(() => (window as any).wakePipeline.error)).toBeNull();
    await page.waitForFunction(() => (window as any).wakePipeline.readyToPlay);
    const downloaded = fixture.requests.length;
    await page.evaluate(() => (window as any).wakePipeline.play());
    await expect.poll(() => page.evaluate(() => (window as any).wakePipeline.commands.length), { timeout: 20_000 }).toBe(1);
    const result = await page.evaluate(() => ({ commands: (window as any).wakePipeline.commands, states: (window as any).wakePipeline.states, microphone: (window as any).wakePipeline.voice.microphoneActive }));
    expect(result.commands[0]).toMatch(/sensor.*temperature/i); expect(result.commands[0]).not.toMatch(/listen.? computer/i);
    expect(result.states.some((state: any) => state.state === "detected")).toBe(true);
    expect(fixture.requests.length).toBe(downloaded);
    expect(fixture.requests.every(request => request.method === "GET")).toBe(true);
    await page.locator("#stop").click();
    expect(await page.evaluate(() => (window as any).wakePipeline.voice.microphoneActive)).toBe(false);
    expect(await page.evaluate(() => (window as any).wakePipeline.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
    await info.attach("wake-model-pipeline", { body: JSON.stringify({ ...result, phrase: fixture.fixture.phrase, fixture_sha256: fixture.fixture.sha256, evidence: "Real browser, AudioWorklet and pinned speech model; injected synthetic WAV microphone source, no physical-device accuracy claim." }, null, 2), contentType: "application/json" });
  } finally { await page.evaluate(() => (window as any).wakePipeline?.close()).catch(() => {}); await fixture.close(); }
});
