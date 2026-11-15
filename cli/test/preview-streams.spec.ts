import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, preview } from "../lib/preview.mjs";

const record = (id: string, value: number) => ({ id, type: "sample", data: { value } });
const fixture = () => ({ streams: [
  { name: "metrics", durability: "durable", records: [record("a", 1), record("b", 2)] },
  { name: "live", durability: "ephemeral", readers: "page" },
] });
let dir: string, server: any;
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tendril-preview-stream-browser-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><html><head><title>Stream fixture</title></head><body><h1>Stream fixture</h1></body></html>');
  server = await startServer(dir, undefined, fixture());
});
test.afterEach(async () => { await server?.stopPreview(); rmSync(dir, { recursive: true, force: true }); });
const open = async (page: any) => { await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.tendril.connected); };

test("the real stream client reads snapshots, replays history and catches up after reconnect", async ({ page }) => {
  await open(page);
  const snapshot = await page.evaluate(async () => {
    const streams = window.tendril.streams;
    (window as any).records = [];
    (window as any).streamErrors = [];
    (window as any).stopStream = streams.subscribe("metrics", record => (window as any).records.push(record.seq), {
      after: 0, onError: error => (window as any).streamErrors.push(error.message),
    });
    return { list: await streams.list(), info: await streams.info("metrics"), latest: await streams.latest("metrics"), page: await streams.read("metrics", { after: 0, limit: 1 }) };
  });
  expect(snapshot.list.streams.map(stream => stream.name)).toEqual(["metrics", "live"]);
  expect(snapshot.info.durability).toBe("durable");
  expect(snapshot.latest.record?.data).toEqual({ value: 2 });
  expect(snapshot.page.records.map(record => record.seq)).toEqual([1]);
  await expect.poll(() => page.evaluate(() => (window as any).records)).toEqual([1, 2]);
  server.preview.streams.feed([{ name: "metrics", records: [record("c", 3)] }]);
  await expect.poll(() => page.evaluate(() => (window as any).records)).toEqual([1, 2, 3]);
  server.preview.setOnline(false);
  await page.waitForFunction(() => !window.tendril.connected);
  server.preview.streams.feed([{ name: "metrics", records: [record("d", 4)] }]);
  server.preview.setOnline(true);
  await expect.poll(() => page.evaluate(() => (window as any).records), { timeout: 15000 }).toEqual([1, 2, 3, 4]);
  expect(await page.evaluate(() => (window as any).streamErrors)).toEqual([]);
  expect(server.preview.events).toEqual([]);
  expect(await page.evaluate(() => (window as any).__tendrilCalls.some((call: any) => call.fn === "streams.subscribe"))).toBe(true);
});

test("the real client receives ephemeral live data and reports forbidden or non-replayable reads", async ({ page }) => {
  server.preview.setRole("guest");
  await open(page);
  const result = await page.evaluate(async () => {
    const streams = window.tendril.streams;
    (window as any).liveRecords = [];
    streams.subscribe("live", record => (window as any).liveRecords.push(record.data));
    const code = async (read: () => Promise<unknown>) => { try { await read(); return null; } catch (error) { return (error as any).code; } };
    return { list: await streams.list(), forbidden: await code(() => streams.latest("metrics")), nonReplayable: await code(() => streams.read("live", { after: 0 })) };
  });
  expect(result.list.streams.map(stream => stream.name)).toEqual(["live"]);
  expect(result.forbidden).toBe("forbidden");
  expect(result.nonReplayable).toBe("not_replayable");
  await expect.poll(() => server.preview.messages.some((message: any) => message.t === "stream_subscribe" && message.stream === "live")).toBe(true);
  server.preview.streams.feed([{ name: "live", records: [record("sample", 42)] }]);
  await expect.poll(() => page.evaluate(() => (window as any).liveRecords)).toEqual([{ value: 42 }]);
});

test("ordered fixture steps feed streams through the production runtime without replacing its API", async () => {
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><head><title>Fixture steps</title></head><body><p id="value">Waiting</p>
    <script>tendril.streams.subscribe('metrics', record => document.querySelector('#value').textContent = 'Metric ' + record.data.value, {after:0});</script></body></html>`);
  const result = await preview(dir, { waitMs: 0, fixture: { streams: [{ name: "metrics", durability: "durable", records: [record("initial", 1)] }],
    steps: [{ expect_text: "Metric 1" }, { streams: [{ name: "metrics", records: [record("next", 2)] }], expect_text: "Metric 2" }] } });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.runtime).toBe("production");
  expect(result.fixture_trace.every((step: any) => step.ok)).toBe(true);
  expect(result.calls.some((call: any) => call.fn === "streams.subscribe")).toBe(true);
  expect(result.events).toEqual([]);
});
