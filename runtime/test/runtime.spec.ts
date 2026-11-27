import { test, expect, type Page } from '@playwright/test';
import { savedForOffline } from './publication';
import { MockServer, type MockTendril } from './mock-server';
let mock: MockServer;
test.beforeAll(async () => { mock = new MockServer(); await mock.start(); });
test.afterAll(async () => { await mock.stop(); });
async function open(page: Page, fixture: MockTendril) {
  await mock.prepareBrowser(page, fixture);
  await page.goto(mock.url(fixture));
  await page.waitForFunction(() => !!window.tendril && (window as any).__fixtureTransport.sockets[0]?.received.length === 1);
}
async function expectOnlyHealthyPublicationWatch(page: Page, fixture: MockTendril) {
  const endpoint = new URL('_tendril/publication-ready', mock.url(fixture)); endpoint.protocol = 'ws:';
  expect(await page.evaluate(() => (window as any).__fixtureTransport.sockets)).toEqual([{
    url: endpoint.href, protocols: ['tendriller.publication.v1'],
    received: [JSON.stringify({ type: 'publication', version: 1, current: fixture.version })], sent: [],
  }]);
  // The exact single socket above excludes every application/peer/data transport.
  // Any socket that escaped interception would also reach this upgrade counter.
  expect(mock.upgrades).toBe(0);
  expect(mock.requests.filter(path => path.startsWith(mock.base(fixture)) && path.includes('_tendril/') && !path.includes('/runtime/'))).toEqual([]);
}
test('the sole runtime has only a healthy publication watch and exposes explicit application and live bindings', async ({ page }) => {
  await page.clock.install();
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
  await page.clock.fastForward(48 * 3600_000);
  await expectOnlyHealthyPublicationWatch(page, fixture);
  await page.evaluate(() => window.tendril.ready());
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Manage page' })).toBeVisible();
  const info = await page.evaluate(() => window.tendril.host.request<{ version: number }>('info'));
  expect(info.version).toBe(1);
  expect(mock.requests.filter(path => path === mock.base(fixture) + '_tendril/info')).toHaveLength(1);
});

test('application installation adds no transport to the healthy publication watch', async ({ page }) => {
  await page.clock.install();
  const fixture = mock.create(); await open(page, fixture);
  const result = await page.evaluate(async () => {
    const application = { applicationId: window.__TENDRIL__.application.id, capabilities: ['events'],
      status: { canAuthor: true, phase: 'ready', database: 'ready', connectedPeers: 0, pendingOperations: 0, materializationError: null },
      onStatus() { return () => {}; },
      async submit() {}, readView() {}, async *changes() {},
      events: { publish() {}, read() {}, subscribe() {} }, operations: { get() {}, retry() {}, subscribe() {} } };
    window.tendril.application.install(application as any);
    const installed = await window.tendril.application.ready();
    let repeated = ''; try { window.tendril.application.install(application as any); } catch (error) { repeated = (error as any).code; }
    return { same: installed === application, available: window.tendril.application.available, repeated };
  });
  expect(result).toEqual({ same: true, available: true, repeated: 'backend_already_selected' });
  await page.clock.fastForward(48 * 3600_000);
  await expectOnlyHealthyPublicationWatch(page, fixture);
});

test('open tabs keep the code graph of their release; reloads open the latest; an explicit release URL pins, also offline', async ({ page, context }) => {
  const fixture = mock.create({ noSw: false, html: '<h1 id="h">Page A</h1><script src="app.js"></script>' });
  fixture.files['app.js'] = { type: 'text/javascript', body: "window.__app = 'A';" };
  fixture.files['lazy.js'] = { type: 'text/javascript', body: "window.__lazy = 'A';" };
  await open(page, fixture); expect(await savedForOffline(page)).toBe('1');
  // The address stays the page's own URL, so a reload opens the latest release.
  expect(page.url()).toBe(mock.url(fixture));
  fixture.version = 2; fixture.html = '<h1 id="h">Page B</h1><script src="app.js"></script>';
  fixture.files['app.js'] = { type: 'text/javascript', body: "window.__app = 'B';" };
  fixture.files['lazy.js'] = { type: 'text/javascript', body: "window.__lazy = 'B';" };
  const next = await context.newPage(); await open(next, fixture); expect(await savedForOffline(next)).toBe('2');
  expect(await page.evaluate(() => window.tendril.version)).toBe(1);
  const pinned = await context.newPage();
  await pinned.goto(mock.url(fixture) + '_publications/1/index.html'); await pinned.waitForFunction(() => !!window.tendril);
  expect(await pinned.evaluate(() => window.tendril.publication.pinned)).toBe(true);
  await context.setOffline(true);
  // Each open tab still resolves lazy code within its own release.
  for (const [tab, label] of [[page, 'A'], [next, 'B'], [pinned, 'A']] as const) {
    await tab.evaluate(() => new Promise<void>((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'lazy.js'; script.onload = () => resolve();
      script.onerror = () => reject(Error('lazy asset failed')); document.head.append(script);
    }));
    expect(await tab.evaluate(() => (window as any).__lazy)).toBe(label);
  }
  // Offline reloads: the page URL opens the latest saved release, the release URL its own.
  for (const [tab, label] of [[page, 'B'], [next, 'B'], [pinned, 'A']] as const) {
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

async function offerInstallation(page: Page, outcome: 'accepted' | 'dismissed' = 'accepted') {
  return page.evaluate(outcome => {
    const w = window as any;
    w.installCalls = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt() { w.installCalls++; w.installActivation = navigator.userActivation.isActive; return Promise.resolve(); },
      userChoice: Promise.resolve({ outcome }),
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }, outcome);
}

test('installation is explicit, consumes its browser event once, and distinguishes acceptance from completion', async ({ page }) => {
  await open(page, mock.create());
  expect(await offerInstallation(page)).toBe(true);
  expect(await page.evaluate(() => (window as any).installCalls)).toBe(0);
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('button', { name: /App & offline/ }).click();
  await page.getByRole('button', { name: 'Add to Home Screen', exact: true }).click();
  await expect(page.getByText('Installation requested.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => ({ calls: (window as any).installCalls,
    activated: (window as any).installActivation, state: window.tendril.installation.status().state,
  }))).toEqual({ calls: 1, activated: true, state: 'manual' });
  expect(await page.evaluate(() => window.tendril.installation.prompt())).toBe('unavailable');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.getByText('This page is available as an app on this device.')).toBeVisible();
  await expect(page.getByText('Installation requested.', { exact: false })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add to Home Screen', exact: true })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeFocused();
});

test('the page controls save the actual code graph on demand and report offline success only after acknowledgement', async ({ page, context }) => {
  const fixture = mock.create({ noSw: false, html: '<h1>My saved page</h1>' });
  await open(page, fixture);
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('button', { name: /App & offline/ }).click();
  await page.getByRole('button', { name: 'Save for offline use', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Page files saved', exact: true })).toBeDisabled();
  await expect(page.getByText('This version’s page files are saved on this device.', { exact: false })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My saved page' })).toBeVisible();
  await context.setOffline(false);
});

test('offline saving failures remain retryable without claiming success', async ({ page }) => {
  await open(page, mock.create());
  await page.evaluate(() => { window.tendril.publication.saveOffline = async () => { throw Error('No space'); }; });
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('button', { name: /App & offline/ }).click();
  await page.getByRole('button', { name: 'Save for offline use', exact: true }).click();
  await expect(page.getByText('Could not save the page files.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try saving again', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Page files saved', exact: true })).toBeHidden();
});

test.describe('mobile home-screen setup', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });

  test('iPhone help fits small screens, preserves focus, and explains the first app launch', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, mock.create());
    await page.getByRole('button', { name: 'Page options', exact: true }).click();
    await page.getByRole('button', { name: /App & offline/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Keep this page handy' });
    await expect(dialog.getByText('Choose Add to Home Screen.')).toBeVisible();
    await expect(dialog.getByText('Keep Open as Web App enabled if shown, then tap Add.')).toBeVisible();
    await expect(dialog.getByText('When you first open the Home Screen app,', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add to Home Screen', exact: true })).toBeHidden();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
    await page.evaluate(() => window.addEventListener('devicemotion', () => {}));
    await expect(page.getByRole('button', { name: 'Stop Motion', exact: true })).toBeVisible();
    const withSensors = await dialog.boundingBox();
    expect(withSensors!.y).toBeGreaterThanOrEqual(0);
    expect(withSensors!.y + withSensors!.height).toBeLessThanOrEqual(640);
    await page.screenshot({ path: test.info().outputPath('mobile-page-options.png') });
    await page.getByRole('button', { name: 'Close app dialog' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeFocused();
  });

  test('suggestions wait for engagement and remember Not now for this page across reloads', async ({ page }) => {
    await page.clock.install();
    const fixture = mock.create(); await open(page, fixture);
    const suggestion = page.getByRole('complementary', { name: 'Home screen suggestion' });
    await page.clock.fastForward(20_000); await expect(suggestion).toBeHidden();
    await page.locator('main').tap();
    await page.clock.fastForward(11_000); await expect(suggestion).toBeHidden();
    await page.clock.fastForward(1_000); await expect(suggestion).toBeVisible();
    await suggestion.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeFocused();
    await page.reload(); await page.locator('main').tap();
    await page.clock.fastForward(20_000); await expect(suggestion).toBeHidden();
    await page.getByRole('button', { name: 'Page options', exact: true }).click();
    await page.getByRole('button', { name: /App & offline/ }).click();
    await expect(page.getByText('Choose Add to Home Screen.')).toBeVisible();
    // A different page on this fixture origin has an independent suggestion preference.
    await open(page, mock.create()); await page.locator('main').tap();
    await page.clock.fastForward(12_000); await expect(suggestion).toBeVisible();
  });

  test('opening setup voluntarily prevents a later suggestion during the same visit', async ({ page }) => {
    await page.clock.install(); await open(page, mock.create());
    await page.locator('main').tap();
    await page.getByRole('button', { name: 'Page options', exact: true }).click();
    await page.getByRole('button', { name: 'Close page options' }).click();
    await page.locator('main').tap(); await page.clock.fastForward(20_000);
    await expect(page.getByRole('complementary', { name: 'Home screen suggestion' })).toBeHidden();
  });

  test('native installation from a suggestion gives a visible result and never prompts twice', async ({ page }) => {
    await page.clock.install(); await open(page, mock.create());
    await offerInstallation(page, 'dismissed');
    await page.locator('main').tap(); await page.clock.fastForward(12_000);
    const suggestion = page.getByRole('complementary', { name: 'Home screen suggestion' });
    await suggestion.getByRole('button', { name: 'Add to Home Screen', exact: true }).click();
    await expect(suggestion).toBeHidden();
    await expect(page.getByText('You can add this page later from Page options.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Keep this page handy' })).toBeFocused();
    expect(await page.evaluate(() => (window as any).installCalls)).toBe(1);
  });

  test('suggestions stay out of typing and active sensor use', async ({ page }) => {
    await page.clock.install();
    await open(page, mock.create({ html: '<main style="margin-bottom:48px"><button style="min-height:44px">Use page</button></main><input aria-label="Notes">' }));
    const suggestion = page.getByRole('complementary', { name: 'Home screen suggestion' });
    const notes = page.getByRole('textbox', { name: 'Notes' });
    const usePage = page.getByRole('button', { name: 'Use page', exact: true });
    await notes.tap();
    await page.clock.fastForward(12_000); await expect(suggestion).toBeHidden();
    // Keep the engagement target away from the input so mobile touch adjustment
    // cannot refocus the editor while exercising the separate sensor guard.
    await notes.blur();
    await page.evaluate(() => window.addEventListener('devicemotion', () => {}));
    await usePage.tap(); await expect(notes).not.toBeFocused();
    await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: ['motion'], pending: [] });
    await page.clock.fastForward(12_000);
    await expect(suggestion).toBeHidden();
    await expect(page.getByRole('button', { name: 'Stop Motion', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop Motion', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeFocused();
    await usePage.tap(); await expect(notes).not.toBeFocused();
    expect(await page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: [] });
    await page.clock.fastForward(12_000);
    await expect(suggestion).toBeVisible();
  });

  test('standalone launches suppress installation help and suggestions', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    await page.clock.install(); await open(page, mock.create());
    await page.locator('main').tap(); await page.clock.fastForward(20_000);
    await expect(page.getByRole('complementary', { name: 'Home screen suggestion' })).toBeHidden();
    await page.getByRole('button', { name: 'Page options', exact: true }).click();
    await page.getByRole('button', { name: /App & offline/ }).click();
    await expect(page.getByText('This page is available as an app on this device.')).toBeVisible();
    await expect(page.getByText('Choose Add to Home Screen.')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Save for offline use', exact: true })).toBeVisible();
  });

  test('blocked browser storage does not break dismissal or setup', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('Storage blocked', 'SecurityError'); },
    }));
    await page.clock.install(); await open(page, mock.create());
    await page.locator('main').tap(); await page.clock.fastForward(12_000);
    const suggestion = page.getByRole('complementary', { name: 'Home screen suggestion' });
    await suggestion.getByRole('button', { name: 'Not now', exact: true }).click();
    await page.locator('main').tap(); await page.clock.fastForward(20_000);
    await expect(suggestion).toBeHidden();
    await page.getByRole('button', { name: 'Page options', exact: true }).click();
    await page.getByRole('button', { name: /App & offline/ }).click();
    await expect(page.getByText('Choose Add to Home Screen.')).toBeVisible();
  });
});

test('hosted voice controls load only on a local choice and remain microphone-free through consent review', async ({ page }) => {
  await page.addInitScript(() => {
    const state = (window as any).__voiceOpening = { microphones: 0, contexts: 0 };
    navigator.mediaDevices.getUserMedia = async () => { state.microphones++; throw new Error('The test never consents to capture'); };
    const NativeAudio = window.AudioContext;
    (window as any).AudioContext = class extends NativeAudio {
      constructor(options?: AudioContextOptions) { super(options); state.contexts++; }
    };
  });
  const fixture = mock.create(); await open(page, fixture);
  const voiceRequests = () => mock.requests.filter(path => path.startsWith(mock.base(fixture)) && /voice|cactus|whistle|resources\.json/.test(path));
  expect(voiceRequests()).toEqual([]);
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('button', { name: /Voice & audio/ }).click();
  expect(voiceRequests()).toEqual([]);
  const setup = page.getByRole('button', { name: 'Set up voice input', exact: true });
  await setup.evaluate((button: HTMLButtonElement) => button.click());
  expect(voiceRequests()).toEqual([]);
  await setup.click();
  const controls = page.locator('tendril-voice-controls');
  await expect(controls.getByRole('heading', { name: 'Wake word', exact: true })).toBeVisible();
  await expect(controls.getByLabel('Wake phrase', { exact: true })).toHaveValue('Listen computer');
  await controls.getByLabel('Text to review or type').fill('Keep this typed draft');
  await controls.getByRole('button', { name: 'Set up wake word' }).click();
  await expect(controls.getByText(/18,224,260 bytes/)).toBeVisible();
  await expect(controls.getByRole('button', { name: 'Start microphone', exact: true })).toBeVisible();
  await controls.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(controls.getByLabel('Text to review or type')).toHaveValue('Keep this typed draft');
  expect(voiceRequests()).toEqual([new URL('voice.mjs', mock.origin + mock.runtimeUrl(fixture)).pathname]);
  expect(await page.evaluate(() => (window as any).__voiceOpening)).toEqual({ microphones: 0, contexts: 0 });
  expect(await page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: [] });
});

test('cooperative resource labels and asynchronous stopping stay visible in the real browser', async ({ page }) => {
  await open(page, mock.create());
  await page.evaluate(() => {
    const w = window as any;
    w.stopCalls = 0;
    w.resource = window.tendril.sensors.register({ kind: 'serial', label: 'Bench meter', stop() {
      if (!w.resource.signal.aborted) throw Error('signal must be invalidated before cleanup');
      w.stopCalls++;
      return new Promise<void>(resolve => { w.finishStop = resolve; });
    } });
  });
  const indicator = page.locator('tendril-utility').getByRole('status');
  await expect(indicator).toHaveText('Bench meter request pending');
  await page.evaluate(() => (window as any).resource.setState('active'));
  await expect(indicator).toHaveText('Bench meter active');
  expect(await page.evaluate(async () => (await window.tendril.capabilities(['serial'])).capabilities.serial.active)).toBe(true);
  const stop = page.getByRole('button', { name: 'Stop Bench meter', exact: true });
  await stop.click();
  await expect(indicator).toHaveText('Bench meter stopping');
  await expect(stop).toBeEnabled();
  expect(await page.evaluate(() => window.tendril.sensors.stopAll())).toBe(0);
  expect(await page.evaluate(() => (window as any).stopCalls)).toBe(1);
  await page.evaluate(() => { (window as any).resource.setState('active'); (window as any).finishStop(); });
  await expect(indicator).toBeHidden();
  expect(await page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: [] });
});

test('failed cooperative cleanup remains visible after repeated local and global Stop', async ({ page }) => {
  await open(page, mock.create());
  await page.evaluate(() => {
    const w = window as any;
    w.stopCalls = 0;
    w.resource = window.tendril.sensors.register({ kind: 'serial', label: 'Bench meter', state: 'active', stop() {
      w.stopCalls++;
      throw Error('device refused close');
    } });
  });
  const indicator = page.locator('tendril-utility').getByRole('status');
  const stop = page.getByRole('button', { name: 'Stop Bench meter', exact: true });
  await stop.click();
  await expect(indicator).toHaveText('Bench meter failed');
  await stop.click();
  await page.evaluate(() => { (window as any).resource.unregister(); (window as any).resource.unregister(); });
  await expect(indicator).toHaveText('Bench meter failed');
  expect(await page.evaluate(() => (window as any).stopCalls)).toBe(1);
  await page.evaluate(() => (window as any).resource.unregister({ acknowledgeFailure: true }));
  await expect(indicator).toBeHidden();
  expect(await page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: [] });
});
