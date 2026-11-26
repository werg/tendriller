import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';

// Exercise the real utility/voice presentation in a browser. No microphone,
// installation or application transport is opened by this layout fixture.
const compiled = await build({
  stdin: { contents: "export {mountUtility} from './runtime/src/utility.ts';export {createTransportBinding} from './runtime/src/transport.ts';export {createChatStore} from './runtime/src/chat.ts';export {createAgentsStore} from './runtime/src/agents.ts';export {mountVoiceControls} from './runtime/src/voice/controls.ts';",
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
    const cfg = { id: 'layout-page', base: 'https://layout.test/', version: 1, documentPath: null, application: { id: 'a'.repeat(64) }, features: { speech: null, shared_by: 'Owner' } };
    w.chatStore = w.Layout.createChatStore(cfg);
    w.agentsStore = w.Layout.createAgentsStore(cfg);
    w.api = {
      transport: w.Layout.createTransportBinding().api,
      agents: w.agentsStore.api,
      chat: w.chatStore.api,
      identity: { page: 'layout-page', base: 'https://layout.test/', version: 1, publication: null, managementUrl: 'https://layout.test/manage' },
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
    await expect(page.getByRole('heading', { name: 'Page utility layout' })).toBeFocused();
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

for (const width of [1280, 320]) {
  test(`sharing retains a selectable link when clipboard is denied at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 }); await fixture(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('denied'); } } });
      const w = window as any; w.disposeUtility(); w.mount();
    });
    await page.getByRole('button', { name: 'Page options', exact: true }).click();
    await page.getByRole('button', { name: /Share & invite/ }).click();
    await page.getByRole('button', { name: 'Copy page link', exact: true }).click();
    const fallback = page.getByRole('textbox', { name: 'Link to copy', exact: true });
    await expect(fallback).toHaveValue('https://layout.test/');
    await expect(fallback).toBeFocused();
    expect(await fallback.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 'https://layout.test/'.length]);
    await page.screenshot({ path: testInfo.outputPath('share-clipboard-fallback.png') });
  });

  test(`sharing can revoke expired links, approve pending guests, and create labelled invites at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 }); await fixture(page);
    const links = [{ id: 'expired', url: 'https://layout.test/old/', role: 'display', label: 'Old tablet', expires_at: 1 }];
    const guests = [{ account_id: 'acc_1', link_id: 'l_guest', created_at: Date.now(), email: 'sam@example.com' }];
    let createdBody: unknown;
    let approvedGuest = false;
    await page.route('https://layout.test/_tendril/links**', async route => {
      const request = route.request();
      if (request.method() === 'DELETE') { links.splice(0); await route.fulfill({ status: 204 }); return; }
      if (request.method() === 'POST') {
        createdBody = request.postDataJSON();
        const link = { id: 'new', url: 'https://layout.test/guest/', ...request.postDataJSON(), expires_at: null };
        links.push(link); await route.fulfill({ status: 201, json: link }); return;
      }
      await route.fulfill({ json: { name: 'Test page', links } });
    });
    await page.route('https://layout.test/_tendril/guests**', async route => {
      if (route.request().url().endsWith('/approve')) {
        approvedGuest = true; guests.splice(0); await route.fulfill({ json: { ok: true } }); return;
      }
      await route.fulfill({ json: { guests } });
    });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
      const w = window as any; w.disposeUtility(); w.mount();
    });
    await page.getByRole('button', { name: 'Page options', exact: true }).click();
    await page.getByRole('button', { name: /Share & invite/ }).click();
    await page.getByRole('tab', { name: /Links/ }).click();
    await expect(page.getByText('sam@example.com')).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => approvedGuest).toBe(true);
    await expect(page.getByText('Old tablet', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByText('Old tablet', { exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Invite person', exact: true }).click();
    await page.getByRole('textbox', { name: 'Invite label (optional)', exact: true }).fill('Tablet visitor');
    await page.getByRole('button', { name: '24 hours', exact: true }).click();
    await page.getByRole('button', { name: 'Create invite link', exact: true }).click();
    expect(createdBody).toEqual({ role: 'guest', label: 'Tablet visitor', expires_in: 86400 });
    await expect(page.getByText('Link created and copied to clipboard.', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('share-invite-created.png') });
  });

  test(`Agents & MCP modal grants account agents and generates one-time join codes at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 }); await fixture(page);
    const posted: unknown[] = [];
    let joinRequested = 0;
    await page.route('https://layout.test/_tendril/links**', route => route.fulfill({ json: { name: 'Test page', links: [] } }));
    await page.route('https://layout.test/_tendril/agents/join', async route => {
      joinRequested++;
      await route.fulfill({ status: 201, json: {
        code: 'tj_' + 'a'.repeat(26),
        expires_at: Date.now() + 600_000,
        blurb: 'Paste this to connect your agent with code tj_' + 'a'.repeat(26),
        command: 'tendril workspace join --code tj_' + 'a'.repeat(26) + ' --handle <handle>',
      } });
    });
    await page.route('https://layout.test/_tendril/agents', async route => {
      if (route.request().method() === 'POST') { posted.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
      await route.fulfill({ json: {
        primary_agent_id: 'ag_' + 'a'.repeat(26),
        can_manage: true,
        dashboard: 'https://tendriller.dev/dashboard#agents',
        connections: 'https://tendriller.dev/connections',
        platforms: 'https://tendriller.dev/agents',
        agents: [{ id: 'ag_' + 'a'.repeat(26), handle: 'builder', bio: '', public_key: 'a'.repeat(64), kind: 'workspace', is_primary: true, granted_at: 1 }],
        account_agents: [
          { id: 'ag_' + 'a'.repeat(26), handle: 'builder', bio: '', granted: true },
          { id: 'ag_' + 'b'.repeat(26), handle: 'reviewer', bio: '', granted: false },
        ],
      } });
    });
    await page.evaluate(() => { const w = window as any; w.disposeUtility(); w.mount(); });
    await page.getByRole('button', { name: 'Page options', exact: true }).click();
    await page.getByRole('button', { name: /Agents & MCP/ }).click();
    await page.getByRole('tab', { name: 'Add agent', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '@builder', exact: true })).toBeChecked();
    const reviewer = page.getByRole('checkbox', { name: '@reviewer', exact: true });
    await expect(reviewer).not.toBeChecked();
    await reviewer.check();
    await expect.poll(() => posted).toEqual([{ agent: 'ag_' + 'b'.repeat(26), granted: true }]);
    await expect(page.getByText('@reviewer can now maintain this page.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Generate agent join code', exact: true }).click();
    await expect.poll(() => joinRequested).toBe(1);
    await expect(page.getByText('tj_' + 'a'.repeat(26)).first()).toBeVisible();
    await page.getByRole('button', { name: 'CLI command', exact: true }).click();
    await expect(page.getByText(/tendril workspace join --code/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add an agent on your dashboard', exact: true })).toHaveAttribute('href', 'https://tendriller.dev/dashboard#agents');
    await page.screenshot({ path: testInfo.outputPath('agent-grants.png') });
  });
}

test('Talk button glows on incoming messages, opens modal chat with agent & user handles, @mention autocomplete, and quick voice/wake-word config', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.route('https://layout.test/_tendril/agents', route => route.fulfill({ json: {
    primary_agent_id: 'ag_atlas',
    can_manage: true,
    viewer: { role: 'owner', handle: 'alex' },
    people: [
      { id: 'acc_alex', handle: 'alex', role: 'owner', is_self: true },
      { id: 'acc_sam', handle: 'sam', role: 'guest', is_self: false },
    ],
    agents: [
      { id: 'ag_atlas', handle: 'atlas', bio: 'Planner', public_key: 'a'.repeat(64), kind: 'workspace', is_primary: true, granted_at: 1 },
      { id: 'ag_scout', handle: 'scout', bio: 'Research', public_key: 'b'.repeat(64), kind: 'workspace', is_primary: false, granted_at: 2 },
    ],
  } }));
  await page.evaluate(() => {
    const w = window as any;
    w.sent = [];
    w.chatStore.api.register({
      title: 'Workspace chat',
      onSend(input: unknown) { w.sent.push(input); },
    });
    w.chatStore.api.setPeople([
      { id: 'acc_alex', handle: 'alex', role: 'owner', is_self: true },
      { id: 'acc_sam', handle: 'sam', role: 'guest', is_self: false },
    ]);
    w.chatStore.api.setMessages([
      { id: 'm1', role: 'user', senderHandle: 'alex', senderRole: 'owner', isSelf: true, text: 'Hello @atlas' },
    ]);
    w.chatStore.api.setMessages([
      { id: 'm1', role: 'user', senderHandle: 'alex', senderRole: 'owner', isSelf: true, text: 'Hello @atlas' },
      { id: 'm2', role: 'agent', senderHandle: 'atlas', isPrimary: true, text: 'Hi @alex, ready to help!' },
    ]);
  });
  const talkBtn = page.getByRole('button', { name: 'Talk to assistant', exact: true });
  await expect(talkBtn).toHaveAttribute('data-glow', 'true');
  await expect(talkBtn).toContainText('1');
  await page.screenshot({ path: testInfo.outputPath('dock-talk-glow.png') });

  await talkBtn.click();
  await expect(talkBtn).toHaveAttribute('data-glow', 'false');
  const dialog = page.getByRole('dialog', { name: 'Assistant' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('@alex');
  await expect(dialog).toContainText('@atlas');

  // Mention autocomplete includes both agents and human users
  const input = dialog.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('@sa');
  const listbox = dialog.getByRole('listbox', { name: 'Mention an agent or person' });
  await expect(listbox).toBeVisible();
  await expect(listbox).toContainText('@sam');
  await input.press('Enter');
  await expect(input).toHaveValue('@sam ');
  await input.fill('@scout check this');
  await input.press('Enter');
  expect(await page.evaluate(() => (window as any).sent)).toEqual([
    expect.objectContaining({ text: '@scout check this', via: 'text' }),
  ]);

  // Quick config drawer exposes handle, voice, and wake word settings
  await dialog.getByRole('button', { name: 'Voice and chat settings', exact: true }).click();
  await expect(dialog.getByLabel('Wake phrase', { exact: true })).toHaveValue('Listen computer');
  await expect(dialog.getByLabel('Your chat handle', { exact: true })).toHaveValue('alex');
  await page.screenshot({ path: testInfo.outputPath('chat-modal-mobile.png') });
});

test('holding the Talk button starts immediate voice input and delivers transcript on release', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.route('https://layout.test/voice-fixture.mjs', route => route.fulfill({
    contentType: 'text/javascript',
    body: `export function createVoice(runtime, handlers) {
      let recording = false;
      window.__holdVoiceEvents = [];
      return {
        get speaking() { return false; },
        get listening() { return recording; },
        get muted() { return true; },
        language() {},
        async startCapture() {
          recording = true;
          window.__holdVoiceEvents.push('start');
          handlers.status({ kind: 'capture', state: 'recording', message: 'Listening…' });
          handlers.level?.(0.6);
        },
        finishCapture() {
          recording = false;
          window.__holdVoiceEvents.push('finish');
          handlers.status({ kind: 'capture', state: 'idle' });
          handlers.transcript('Check the greenhouse sensors');
        },
        cancelCapture() { recording = false; handlers.status({ kind: 'capture', state: 'idle' }); },
        stop() { recording = false; },
        mute() {},
        dispose() { recording = false; },
      };
    }`,
  }));
  await page.evaluate(() => {
    const w = window as any;
    w.voiceSent = [];
    w.api.assetUrl = () => 'https://layout.test/voice-fixture.mjs';
    w.chatStore.api.register({ title: 'Dark chat', onSend(input: unknown) { w.voiceSent.push(input); } });
  });
  const talkBtn = page.getByRole('button', { name: 'Talk to assistant', exact: true });
  const box = (await talkBtn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(talkBtn).toHaveAttribute('data-recording', 'true');
  await expect(page.getByText('Listening… release to send')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('hold-to-talk-dark.png') });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).voiceSent)).toEqual([
    expect.objectContaining({ text: 'Check the greenhouse sensors', via: 'voice' }),
  ]);
  expect(await page.evaluate(() => (window as any).__holdVoiceEvents)).toEqual(['start', 'finish']);
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('options-menu-dark.png') });
});

test('the page options bar drags to any corner, snaps there, remembers it and still opens on a tap', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 800 }); await fixture(page);
  const options = page.getByRole('button', { name: 'Page options', exact: true });
  const box = async () => (await page.locator('tendril-utility').boundingBox())!;
  const start = await options.boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(60, 80, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => { const b = await box(); return b.x < 40 && b.y < 40; }).toBe(true);
  await expect(page.locator('#page-options')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('utility-top-left.png') });
  await options.click();
  await expect(page.locator('#page-options')).toBeVisible();
  expect((await page.locator('#page-options').boundingBox())!.y).toBeGreaterThan((await options.boundingBox())!.y);
  await page.screenshot({ path: testInfo.outputPath('utility-top-left-open.png') });
  await expect(page.getByRole('button', { name: 'Top left', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Bottom right', exact: true }).click();
  await expect.poll(async () => { const b = await box(); return b.x + b.width > 340 && b.y + b.height > 740; }).toBe(true);
  await page.getByRole('button', { name: 'Top right', exact: true }).click();
  await page.evaluate(() => { const w = window as any; w.disposeUtility(); w.mount(); });
  await expect.poll(async () => { const b = await box(); return b.x + b.width > 340 && b.y < 40; }).toBe(true);
});
