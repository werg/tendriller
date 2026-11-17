import { test, expect, type Page } from '@playwright/test';
import { savedForOffline } from './publication';
import { MockServer, type MockTendril } from './mock-server';
let mock: MockServer;
test.beforeAll(async () => { mock = new MockServer(); await mock.start(); });
test.afterAll(async () => { await mock.stop(); });
async function open(page: Page, fixture: MockTendril) {
  await page.goto(mock.url(fixture));
  await page.waitForFunction(() => !!window.tendril);
}
test('the sole runtime is quiet and exposes explicit application and live bindings', async ({ page }) => {
  const fixture = mock.create();
  await open(page, fixture);
  expect(await page.evaluate(() => ({
    application: window.tendril.application.available,
    signals: window.tendril.signals.available,
    host: Object.keys(window.tendril.host).sort(),
    device: 'device' in window.tendril,
    profile: 'kind' in window.tendril,
    legacyState: 'state' in window.tendril,
    storage: Object.keys(localStorage),
  }))).toEqual({ application: false, signals: false, host: ['peers', 'request'], device: false, profile: false, legacyState: false, storage: [] });
  expect(mock.upgrades).toBe(0);
  expect(mock.requests.filter(path => path.startsWith(mock.base(fixture)) && path.includes('_tendril/') && !path.includes('/runtime/'))).toEqual([]);
  await page.evaluate(() => window.tendril.ready());
  await expect(page.getByRole('link', { name: 'Manage page' })).toBeVisible();
  const info = await page.evaluate(() => window.tendril.host.request<{ version: number }>('info'));
  expect(info.version).toBe(1);
  expect(mock.requests.filter(path => path === mock.base(fixture) + '_tendril/info')).toHaveLength(1);
});

test('application installation binds one identity without starting host transport', async ({ page }) => {
  const fixture = mock.create(); await open(page, fixture);
  const result = await page.evaluate(async () => {
    const application = { id: window.__TENDRIL__.application.id, capabilities: ['events'],
      status: { phase: 'ready', role: 'coordinator', generation: 'g', coordinator: 'device', connectedPeers: 0 },
      onStatus() { return () => {}; }, onRecovery() { return () => {}; }, async inspectRecovery() { return []; },
      async submit() {}, readView() {}, async *changes() {},
      events: { publish() {}, read() {}, subscribe() {} }, operations: { get() {}, subscribe() {} } };
    window.tendril.application.install(application as any);
    const installed = await window.tendril.application.ready();
    let repeated = ''; try { window.tendril.application.install(application as any); } catch (error) { repeated = (error as any).code; }
    return { same: installed === application, available: window.tendril.application.available, repeated };
  });
  expect(result).toEqual({ same: true, available: true, repeated: 'backend_already_selected' });
  expect(mock.upgrades).toBe(0);
});

test('publications retain distinct code graphs across two tabs and offline reload', async ({ page, context }) => {
  const fixture = mock.create({ noSw: false, html: '<h1 id="h">Page A</h1><script src="app.js"></script>' });
  fixture.files['app.js'] = { type: 'text/javascript', body: "window.__app = 'A';" };
  fixture.files['lazy.js'] = { type: 'text/javascript', body: "window.__lazy = 'A';" };
  await open(page, fixture); expect(await savedForOffline(page)).toBe('1');
  await expect(page).toHaveURL(/\/_publications\/1\/index.html$/);
  fixture.version = 2; fixture.html = '<h1 id="h">Page B</h1><script src="app.js"></script>';
  fixture.files['app.js'] = { type: 'text/javascript', body: "window.__app = 'B';" };
  fixture.files['lazy.js'] = { type: 'text/javascript', body: "window.__lazy = 'B';" };
  const next = await context.newPage(); await open(next, fixture); expect(await savedForOffline(next)).toBe('2');
  expect(await page.evaluate(() => window.tendril.version)).toBe(1);
  await context.setOffline(true);
  for (const [tab, label] of [[page, 'A'], [next, 'B']] as const) {
    await tab.evaluate(() => new Promise<void>((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'lazy.js'; script.onload = () => resolve();
      script.onerror = () => reject(Error('lazy asset failed')); document.head.append(script);
    }));
    expect(await tab.evaluate(() => (window as any).__lazy)).toBe(label);
    await tab.reload(); await expect(tab.locator('#h')).toHaveText(`Page ${label}`);
    expect(await tab.evaluate(() => (window as any).__app)).toBe(label);
    expect(await tab.evaluate(() => 'state' in window.tendril || 'connected' in window.tendril)).toBe(false);
  }
  await context.setOffline(false);
});

test("the small utility observes active sensors without opening one and stops tracked use", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).mediaCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      (window as any).mediaCalls++;
      const canvas = document.createElement("canvas");
      const stream = canvas.captureStream(); (window as any).fixtureStream = stream; return stream;
    };
  });
  const t = mock.create({ html: '<button id="camera" onclick="navigator.mediaDevices.getUserMedia({video:true})">Start camera fixture</button>' });
  await open(page, t);
  expect(await page.evaluate(() => (window as any).mediaCalls)).toBe(0);
  expect(await page.evaluate(() => window.tendril.sensors.status().active)).toEqual([]);
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await page.locator("#camera").click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status().active)).toEqual(["camera"]);
  await page.getByRole("button", { name: "Stop Camera", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status().active)).toEqual([]);
  expect(await page.evaluate(() => (window as any).fixtureStream.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended"))).toBe(true);
});

test("the utility exposes pending acquisitions and cancels them before native permission replies", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.mediaRequests = []; w.mediaResults = [];
    navigator.mediaDevices.getUserMedia = () => new Promise((resolve, reject) => w.mediaRequests.push({ resolve, reject }));
  });
  const t = mock.create({ html: `<button id="camera" onclick="navigator.mediaDevices.getUserMedia({video:true}).then(()=>mediaResults.push('accepted'), error=>mediaResults.push(error.name))">Request camera fixture</button>` });
  await open(page, t);
  await page.locator("#camera").click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: ["camera"] });
  await expect(page.locator("tendril-utility").getByRole("status")).toHaveText("Camera request pending");
  await page.getByRole("button", { name: "Stop Camera", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).mediaResults)).toEqual(["AbortError"]);
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.lateStream = document.createElement("canvas").captureStream();
    w.mediaRequests[0].resolve(w.lateStream);
  });
  await expect.poll(() => page.evaluate(() => (window as any).lateStream.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended"))).toBe(true);

  await page.locator("#camera").click();
  await expect(page.getByRole("button", { name: "Stop Camera", exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).mediaRequests[1].reject(new DOMException("Denied", "NotAllowedError")));
  await expect.poll(() => page.evaluate(() => (window as any).mediaResults)).toEqual(["AbortError", "NotAllowedError"]);
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);

  await page.locator("#camera").click();
  await page.evaluate(() => {
    const w = window as any;
    w.freshStream = document.createElement("canvas").captureStream();
    w.mediaRequests[2].resolve(w.freshStream);
  });
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: ["camera"], pending: [] });
  await page.locator("#camera").click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: ["camera"], pending: ["camera"] });
  await expect(page.locator("tendril-utility").getByRole("status")).toHaveText("Camera active. Camera request pending");
  await page.getByRole("button", { name: "Stop Camera", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: [] });
  expect(await page.evaluate(() => (window as any).freshStream.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended"))).toBe(true);
});

test("the utility keeps pending one-shot location cancellable without claiming a location fix", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.locationReads = []; w.locationResults = [];
    navigator.geolocation.getCurrentPosition = (success, error) => w.locationReads.push({ success, error });
  });
  const t = mock.create({ html: `<button id="location" onclick="navigator.geolocation.getCurrentPosition(position=>locationResults.push(position))">Request location fixture</button>` });
  await open(page, t);
  await page.locator("#location").click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: ["location"] });
  await expect(page.locator("tendril-utility").getByRole("status")).toHaveText("Location request pending");
  await page.getByRole("button", { name: "Stop Location", exact: true }).click();
  await page.evaluate(() => (window as any).locationReads[0].success({ coords: { latitude: 1, longitude: 2 } }));
  expect(await page.evaluate(() => (window as any).locationResults)).toEqual([]);
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: [] });
});
