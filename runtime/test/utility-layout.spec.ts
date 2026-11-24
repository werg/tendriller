import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';

// Exercise the real utility/voice presentation in a browser. No microphone,
// installation or application transport is opened by this layout fixture.
const compiled = await build({
  stdin: { contents: "export {mountUtility} from './runtime/src/utility.ts';export {createTransportBinding} from './runtime/src/transport.ts';export {mountVoiceControls} from './runtime/src/voice/controls.ts';",
    resolveDir: new URL('../..', import.meta.url).pathname, loader: 'ts' },
  bundle: true, format: 'iife', globalName: 'Layout', platform: 'browser', write: false,
  plugins: [{ name: 'inert-voice', setup(build) {
    build.onResolve({ filter: /^\.\/index$/ }, args => args.importer.endsWith('/voice/controls.ts')
      ? { path: 'inert-voice', namespace: 'inert-voice' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'inert-voice' }, () => ({ contents:
      "export function createVoice(){return {settings:{wakePhrase:'Listen computer',language:'en-US'},microphoneActive:false,stop(){},dispose(){}}}", loader: 'js' }));
  } }],
});

async function fixture(page: Page) {
  await page.route('https://layout.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page utility layout</title>
    <style>
      *{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui;background:#f5f7f8;color:#173735}
      main{max-width:760px;margin:0 auto;padding:28px 22px 190px}small{color:#586f6d}h1{font-size:32px;margin:8px 0}
      article{padding:20px;background:white;border:1px solid #d9e3e1;border-radius:16px;margin-top:20px}
      #tabs{position:fixed;bottom:0;left:0;right:0;height:64px;display:flex;background:white;border-top:1px solid #d9e3e1}
      #tabs button{flex:1;border:0;background:transparent;color:#173735;font:600 14px system-ui;min-height:44px}
      #tabs button:focus-visible{outline:3px solid #176e60;outline-offset:-4px}
    </style><body><main><small>FIELD NOTES / DEMONSTRATION</small><h1>Your workspace</h1>
    <p>Keep the controls you use every day within reach.</p><article><strong>Today's observations</strong><p>Review your latest entries and continue where you left off.</p></article>
    </main><nav id="tabs" aria-label="App sections"><button>Overview</button><button>Notes</button><button>Machines</button><button>More</button></nav></body></html>` }));
  await page.goto('https://layout.test/');
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  await page.evaluate(() => {
    const w = window as any, noop = () => () => {};
    w.sensorState = { active: [], pending: [] };
    w.disposedSensors = 0;
    w.api = {
      transport: w.Layout.createTransportBinding().api,
      identity: { base: 'https://layout.test/', version: 1, publication: null, managementUrl: 'https://layout.test/manage' },
      publication: { pinned: false, onUpdate: noop },
      installation: { status: () => ({ state: 'unavailable', platform: 'desktop' }), on: noop },
      sensors: { status: () => w.sensorState, on(fn: () => void) { w.updateSensors = fn; return () => {}; }, stopAll() {
        w.disposedSensors++; w.sensorState = { active: [], pending: [] }; w.updateSensors();
      } },
    };
    w.mount = () => w.disposeUtility = w.Layout.mountUtility(w.api);
    w.mount();
    w.tabs = [];
    document.querySelectorAll('#tabs button').forEach(button => button.addEventListener('click', () => w.tabs.push(button.textContent)));
  });
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('tendril-utility')!.shadowRoot!.querySelector('nav')!.getBoundingClientRect();
    const style = getComputedStyle(document.documentElement);
    const voice = document.querySelector('tendril-voice-controls')?.getBoundingClientRect();
    return { width: bar.width, height: bar.height, top: bar.top, bottom: bar.bottom, right: bar.right,
      publishedWidth: parseFloat(style.getPropertyValue('--tendril-utility-width')),
      publishedHeight: parseFloat(style.getPropertyValue('--tendril-utility-height')), voiceBottom: voice?.bottom };
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 640, height: 360 }]) {
  test('bottom tabs remain tappable with declared clearance at ' + viewport.width + '×' + viewport.height, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    await expect.poll(async () => (await geometry(page)).publishedHeight).toBe(54);
    const original = await geometry(page);
    expect(original.bottom).toBe(viewport.height - 12);
    await page.screenshot({ path: testInfo.outputPath('before-clearance.png') });
    await page.addStyleTag({ content: ':root{--tendril-utility-inset-bottom:calc(64px + env(safe-area-inset-bottom) + 8px);--tendril-utility-inset-right:20px}' });
    const positioned = await geometry(page);
    expect(positioned.bottom).toBeCloseTo(viewport.height - 72, 2);
    expect(positioned.right).toBeCloseTo(viewport.width - 20, 2);
    expect(positioned.publishedWidth).toBeCloseTo(positioned.width, 3);
    for (const name of ['Overview', 'Notes', 'Machines', 'More']) await page.getByRole('button', { name, exact: true }).click();
    expect(await page.evaluate(() => (window as any).tabs)).toEqual(['Overview', 'Notes', 'Machines', 'More']);
    await page.screenshot({ path: testInfo.outputPath('after-clearance.png') });

    const options = page.getByRole('button', { name: 'Page options', exact: true });
    await options.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Keep this page handy' })).toBeFocused();
    const utility = await page.locator('tendril-utility').boundingBox();
    expect(utility!.y).toBeGreaterThanOrEqual(11);
    expect(utility!.x).toBeGreaterThanOrEqual(11);
    expect(utility!.y + utility!.height).toBeLessThanOrEqual(viewport.height - 72);
    await page.keyboard.press('Escape'); await expect(options).toBeFocused();
  });
}

test('geometry tracks wrapped sensors and the voice dock follows changes without hiding Stop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page);
  await page.addStyleTag({ content: ':root{--tendril-utility-inset-bottom:72px;--tendril-utility-inset-right:20px}' });
  await page.evaluate(() => {
    const w = window as any; w.voice = w.Layout.mountVoiceControls(w.api);
    w.sensorState = { active: [], pending: [], resources: [{ kind: 'camera', state: 'active', label: 'Front camera observation stream' },
      { kind: 'location', state: 'pending', label: 'Precise location for this observation' }] };
    w.updateSensors();
  });
  await expect.poll(async () => { const box = await geometry(page); return box.publishedHeight === box.height && box.height > 54; }).toBe(true);
  let box = await geometry(page);
  expect(box.voiceBottom).toBeCloseTo(box.top - 10, 3);
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  const voice = await page.locator('tendril-voice-controls').boundingBox();
  expect(voice!.y).toBeGreaterThanOrEqual(11);
  await page.getByRole('button', { name: 'Close voice input' }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  await expect.poll(async () => { const current = await geometry(page); return current.publishedHeight === current.height && current.publishedWidth === current.width; }).toBe(true);
  box = await geometry(page); expect(box.voiceBottom).toBeCloseTo(box.top - 10, 3);
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  expect((await page.locator('tendril-voice-controls').boundingBox())!.y).toBeGreaterThanOrEqual(11);
  await page.getByRole('button', { name: 'Close voice input' }).click();
  await page.getByRole('button', { name: /^Stop Front camera/ }).click();
  expect(await page.evaluate(() => (window as any).disposedSensors)).toBe(1);
  await expect.poll(async () => (await geometry(page)).publishedHeight).toBe(54);
  box = await geometry(page); expect(box.voiceBottom).toBeCloseTo(box.top - 10, 3);
});

test('disposing geometry restores authored values and does not overwrite newer authored changes', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any, style = document.documentElement.style;
    w.disposeUtility();
    style.setProperty('--tendril-utility-width', '201px', 'important');
    style.setProperty('--tendril-utility-height', '202px'); w.mount();
  });
  await expect.poll(async () => (await geometry(page)).publishedHeight).toBe(54);
  const restored = await page.evaluate(() => {
    const w = window as any, style = document.documentElement.style;
    style.setProperty('--tendril-utility-height', '303px');
    w.disposeUtility();
    return { width: style.getPropertyValue('--tendril-utility-width'), priority: style.getPropertyPriority('--tendril-utility-width'),
      height: style.getPropertyValue('--tendril-utility-height') };
  });
  expect(restored).toEqual({ width: '201px', priority: 'important', height: '303px' });
  await expect(page.locator('tendril-utility')).toHaveCount(0);
});
