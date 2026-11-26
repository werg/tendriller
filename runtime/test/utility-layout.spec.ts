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

test('desktop chat icon hover-expands to reveal mic without shifting, supporting hold-to-talk and tap-to-toggle', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1280, height: 800 });
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
  const voiceBtn = page.getByRole('button', { name: 'Voice input', exact: true });

  // At rest on desktop: chat icon is 44px and mic is collapsed inside .voice-reveal
  const talkBefore = (await talkBtn.boundingBox())!;
  expect(talkBefore.width).toBeGreaterThanOrEqual(42);
  const voiceCollapsed = await page.evaluate(() => {
    const el = document.querySelector('tendril-utility')?.shadowRoot?.querySelector('.voice-reveal') as HTMLElement | null;
    return el ? el.getBoundingClientRect().width : -1;
  });
  expect(voiceCollapsed).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('dock-desktop-rest.png') });

  // Hovering the chat button expands the mic inward (left) without shifting the chat button under the pointer
  await talkBtn.hover();
  await expect.poll(async () => {
    const box = await voiceBtn.boundingBox();
    return box ? box.width : 0;
  }).toBeGreaterThanOrEqual(40);
  const talkAfter = (await talkBtn.boundingBox())!;
  expect(Math.abs(talkAfter.x - talkBefore.x)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('dock-desktop-hover-expand.png') });

  // 1) Press-and-hold on the revealed mic button -> push-to-talk
  const vBox = (await voiceBtn.boundingBox())!;
  await page.mouse.move(vBox.x + vBox.width / 2, vBox.y + vBox.height / 2);
  await page.mouse.down();
  const stopVoiceBtn = page.getByRole('button', { name: 'Finish voice input', exact: true });
  await expect(stopVoiceBtn).toHaveAttribute('data-recording', 'true');
  await expect(page.getByText('Listening… release to send')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('hold-to-talk-dark.png') });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).voiceSent)).toEqual([
    expect.objectContaining({ text: 'Check the greenhouse sensors', via: 'voice' }),
  ]);

  // 2) Quick tap/click on the mic button -> tap-to-toggle recording
  await talkBtn.hover();
  await expect.poll(async () => (await voiceBtn.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(40);
  await voiceBtn.click();
  await expect(stopVoiceBtn).toHaveAttribute('data-recording', 'true');
  await expect(page.getByText('Listening… tap mic to send')).toBeVisible();
  // Move pointer away: recording state keeps the mic stop button expanded and reachable
  await page.mouse.move(10, 10);
  await expect.poll(async () => (await stopVoiceBtn.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(40);
  await stopVoiceBtn.click();
  await expect.poll(() => page.evaluate(() => (window as any).voiceSent.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__holdVoiceEvents)).toEqual(['start', 'finish', 'start', 'finish']);

  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('options-menu-dark.png') });
});

test('touch mobile shows compact always-expanded chat and mic split pill', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const page = await context.newPage();
  try {
    await fixture(page);
    const talkBtn = page.getByRole('button', { name: 'Talk to assistant', exact: true });
    const voiceBtn = page.getByRole('button', { name: 'Voice input', exact: true });
    const dockBox = (await page.locator('tendril-utility').boundingBox())!;
    const vBox = (await voiceBtn.boundingBox())!;
    const tBox = (await talkBtn.boundingBox())!;
    expect(vBox.width).toBeGreaterThanOrEqual(40);
    expect(tBox.width).toBeGreaterThanOrEqual(42);
    expect(vBox.x).toBeLessThan(tBox.x);
    expect(dockBox.height).toBeCloseTo(54, 0);
    expect(dockBox.width).toBeLessThan(180);
    await page.screenshot({ path: testInfo.outputPath('dock-mobile-split-pill.png') });
  } finally {
    await context.close();
  }
});

test('toggling spoken replies in chat modal speaks new agent messages and supports reading a reply aloud', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await fixture(page);
  await page.route('https://layout.test/voice-speak-fixture.mjs', route => route.fulfill({
    contentType: 'text/javascript',
    body: `export function createVoice(runtime, handlers) {
      let enabled = false;
      window.__spoken = [];
      return {
        get speaking() { return false; },
        get listening() { return false; },
        get muted() { return !enabled; },
        language() {},
        async enableOutput() { enabled = true; return true; },
        mute() { enabled = false; },
        speak(text) {
          if (!enabled) return;
          window.__spoken.push(text);
          handlers.status({ kind: 'output', state: 'speaking', speaking: true });
          setTimeout(() => handlers.status({ kind: 'output', state: 'idle', speaking: false, completed: true }), 10);
        },
        stop() {},
        dispose() {},
      };
    }`,
  }));
  await page.evaluate(() => {
    const w = window as any;
    w.api.assetUrl = () => 'https://layout.test/voice-speak-fixture.mjs';
    w.chatStore.api.register({ title: 'Voice chat', onSend() {} });
    w.chatStore.api.setMessages([
      { id: 'm1', role: 'agent', senderHandle: 'atlas', text: 'Earlier message before speaker enabled.' },
    ]);
  });

  await page.getByRole('button', { name: 'Talk to assistant', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assistant' });
  const speakerBtn = dialog.getByRole('button', { name: 'Toggle spoken replies', exact: true });
  await speakerBtn.click();
  await expect(speakerBtn).toHaveAttribute('aria-pressed', 'true');
  // Historical message should NOT auto-replay just from toggling on
  expect(await page.evaluate(() => (window as any).__spoken)).toEqual([]);

  // New arriving agent reply IS spoken aloud automatically
  await page.evaluate(() => {
    const w = window as any;
    w.chatStore.api.setMessages([
      { id: 'm1', role: 'agent', senderHandle: 'atlas', text: 'Earlier message before speaker enabled.' },
      { id: 'm2', role: 'agent', senderHandle: 'atlas', text: 'Greenhouse temperature is 22 degrees.' },
    ]);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__spoken)).toEqual([
    'Greenhouse temperature is 22 degrees.',
  ]);

  // Clicking the per-message Read reply aloud button speaks that specific message on demand
  await dialog.getByRole('button', { name: 'Read reply aloud', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__spoken)).toEqual([
    'Greenhouse temperature is 22 degrees.',
    'Earlier message before speaker enabled.',
  ]);

  // Turning speaker off stops further automatic speech
  await speakerBtn.click();
  await expect(speakerBtn).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => {
    const w = window as any;
    w.chatStore.api.setMessages([
      { id: 'm1', role: 'agent', senderHandle: 'atlas', text: 'Earlier message before speaker enabled.' },
      { id: 'm2', role: 'agent', senderHandle: 'atlas', text: 'Greenhouse temperature is 22 degrees.' },
      { id: 'm3', role: 'agent', senderHandle: 'atlas', text: 'Should stay silent.' },
    ]);
  });
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => (window as any).__spoken)).toEqual([
    'Greenhouse temperature is 22 degrees.',
    'Earlier message before speaker enabled.',
  ]);
});

test('floating dock adapts its surface and accent colors to the host page palette', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await fixture(page);
  const readDockPalette = () => page.evaluate(() => {
    const host = document.querySelector('tendril-utility')!;
    const pill = host.shadowRoot!.querySelector('.talk-pill')!;
    const nav = host.shadowRoot!.querySelector('nav.dock')!;
    const pillBg = getComputedStyle(pill).backgroundColor;
    const dockBg = getComputedStyle(nav).backgroundColor;
    const hostScheme = getComputedStyle(host).colorScheme;
    return { pillBg, dockBg, hostScheme };
  });

  // 1) Warm cream & terracotta page -> warm light dock + terracotta accent (r >> g, b)
  await page.evaluate(() => {
    document.body.style.background = '#faf3e8';
    document.body.style.color = '#2c1e16';
    const cta = document.createElement('button');
    cta.textContent = 'Save note';
    cta.style.cssText = 'background:#c2410c;color:#ffffff;border:0;padding:10px 18px;border-radius:10px;';
    document.body.prepend(cta);
  });
  await expect.poll(async () => {
    const { pillBg } = await readDockPalette();
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(pillBg);
    return m ? Number(m[1]) > Number(m[2]) + 40 && Number(m[1]) > Number(m[3]) + 60 : false;
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dock-adaptive-warm.png') });

  // 2) Switch to dark navy & indigo page (even in light OS mode) -> dark dock + indigo accent (b > r, g)
  await page.evaluate(() => {
    document.body.style.background = '#0f172a';
    document.body.style.color = '#e2e8f0';
    const cta = document.body.querySelector('button') as HTMLElement;
    cta.style.background = '#4f46e5';
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await expect.poll(async () => {
    const { pillBg, hostScheme } = await readDockPalette();
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(pillBg);
    return hostScheme === 'dark' && Boolean(m && Number(m[3]) > Number(m[1]) + 40 && Number(m[3]) > Number(m[2]) + 40);
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dock-adaptive-indigo-dark.png') });
});

test('tapping outside closes Page options and chat composer merges Stop+Send vs Done by voice mode', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await fixture(page);
  await page.route('https://layout.test/voice-composer-fixture.mjs', route => route.fulfill({
    contentType: 'text/javascript',
    body: `export function createVoice(runtime, handlers) {
      let n = 0;
      return {
        get speaking() { return false; },
        get listening() { return false; },
        get muted() { return true; },
        language() {},
        async startCapture() {
          handlers.status({ kind: 'capture', state: 'recording', message: 'Listening…' });
          handlers.level?.(0.55);
        },
        finishCapture() {
          handlers.status({ kind: 'capture', state: 'idle' });
          handlers.transcript(++n === 1 ? 'Water the tomatoes' : 'Draft note to review');
        },
        cancelCapture() { handlers.status({ kind: 'capture', state: 'idle' }); },
        stop() {},
        mute() {},
        dispose() {},
      };
    }`,
  }));
  await page.evaluate(() => {
    const w = window as any;
    w.sentMsgs = [];
    w.api.assetUrl = () => 'https://layout.test/voice-composer-fixture.mjs';
    w.chatStore.api.register({ title: 'Clean chat', onSend(input: unknown) { w.sentMsgs.push(input); } });
  });

  // 1) Tapping anywhere else on the page closes the Page options popover
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await expect(page.locator('#page-options')).toBeVisible();
  await page.mouse.click(40, 40);
  await expect(page.locator('#page-options')).toBeHidden();

  // 2) Open chat modal: empty input shows primary Mic and hides disabled Send
  await page.getByRole('button', { name: 'Talk to assistant', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assistant' });
  await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeHidden();
  const micBtn = dialog.getByRole('button', { name: 'Tap or hold to speak', exact: true });
  await expect(micBtn).toBeVisible();

  // Typing reveals Send
  const input = dialog.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Hello');
  await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await input.fill('');
  await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeHidden();

  // 3) Recording in default "Send immediately" mode merges Stop + Send into one button
  await micBtn.click();
  const stopAndSend = dialog.getByRole('button', { name: 'Stop and send voice message', exact: true });
  await expect(stopAndSend).toBeVisible();
  await expect(stopAndSend).toContainText('Send');
  await page.screenshot({ path: testInfo.outputPath('chat-composer-voice-send.png') });
  await stopAndSend.click();
  await expect.poll(() => page.evaluate(() => (window as any).sentMsgs)).toEqual([
    expect.objectContaining({ text: 'Water the tomatoes', via: 'voice' }),
  ]);

  // 4) Switching to "Review in box" mode shows "Done" button and puts transcript into textarea
  await dialog.getByRole('button', { name: 'Voice and chat settings', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Review in box', exact: true }).click();
  await dialog.getByRole('button', { name: 'Voice and chat settings', exact: true }).click();
  await micBtn.click();
  const stopToDraft = dialog.getByRole('button', { name: 'Stop dictating to draft', exact: true });
  await expect(stopToDraft).toBeVisible();
  await expect(stopToDraft).toContainText('Done');
  await page.screenshot({ path: testInfo.outputPath('chat-composer-voice-draft.png') });
  await stopToDraft.click();
  await expect(input).toHaveValue('Draft note to review');
  expect(await page.evaluate(() => (window as any).sentMsgs.length)).toBe(1);
});

test('mobile full-screen chat tracks visualViewport when soft keyboard opens without hiding feed or composer', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await fixture(page);
    await page.evaluate(() => {
      const w = window as any;
      w.chatStore.api.register({ title: 'Mobile chat', onSend() {} });
      w.chatStore.api.setMessages([
        { id: 'm1', role: 'user', senderHandle: 'alex', isSelf: true, text: 'First check-in' },
        { id: 'm2', role: 'agent', senderHandle: 'atlas', isPrimary: true, text: 'Everything looks steady.' },
        { id: 'm3', role: 'user', senderHandle: 'alex', isSelf: true, text: 'How is the soil moisture?' },
        { id: 'm4', role: 'agent', senderHandle: 'atlas', isPrimary: true, text: 'Zone B is at 48% and healthy.' },
      ]);
    });

    // Opening chat on touch mobile must NOT force-focus the textarea (so keyboard doesn't slam open)
    await page.getByRole('button', { name: 'Talk to assistant', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Assistant' });
    await expect(dialog).toBeVisible();
    const focusedTag = await page.evaluate(() => {
      const root = document.querySelector('tendril-utility')?.shadowRoot;
      return root?.activeElement?.tagName.toLowerCase() ?? '';
    });
    expect(focusedTag).not.toBe('textarea');

    // Full-screen on mobile: fills viewport edge-to-edge
    const fullBox = (await dialog.boundingBox())!;
    expect(fullBox.width).toBeCloseTo(390, 0);
    expect(fullBox.height).toBeCloseTo(844, 0);
    expect(fullBox.y).toBeCloseTo(0, 0);
    await page.screenshot({ path: testInfo.outputPath('chat-mobile-fullscreen.png') });

    // Simulate iOS Safari soft keyboard opening (layout stays 844px, visualViewport shrinks to 460px shifted down 40px)
    await page.evaluate(() => {
      const fakeVv = Object.assign(new EventTarget(), { width: 390, height: 460, offsetTop: 40, offsetLeft: 0 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: fakeVv });
      // Re-mount utility with the simulated visualViewport so listener binds cleanly
      (window as any).disposeUtility();
      (window as any).mount();
    });
    await page.getByRole('button', { name: 'Talk to assistant', exact: true }).click();
    const kbDialog = page.getByRole('dialog', { name: 'Assistant' });
    await expect(kbDialog).toBeVisible();
    const kbBox = (await kbDialog.boundingBox())!;
    const composerBox = (await kbDialog.getByRole('textbox', { name: 'Message', exact: true }).boundingBox())!;
    const msgBox = (await kbDialog.getByText('Zone B is at 48% and healthy.').boundingBox())!;
    // Modal locks directly to the visible visualViewport band [40 .. 500]
    expect(kbBox.y).toBeCloseTo(40, 1);
    expect(kbBox.height).toBeCloseTo(460, 1);
    // Latest agent message AND composer are both fully visible inside the 460px visible band
    expect(msgBox.y).toBeGreaterThanOrEqual(kbBox.y + 40);
    expect(msgBox.y + msgBox.height).toBeLessThanOrEqual(composerBox.y + 4);
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(kbBox.y + kbBox.height);
    // Input font-size is >= 16px on mobile to prevent iOS Safari focus-zoom
    const inputFont = await kbDialog.getByRole('textbox', { name: 'Message', exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(inputFont).toBeGreaterThanOrEqual(16);
    await page.screenshot({ path: testInfo.outputPath('chat-mobile-keyboard-open.png') });
  } finally {
    await context.close();
  }
});

test('failed voice send on ENDPOINT_CLOSED preserves transcript without overwriting draft and reuses operationId on retry', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await fixture(page);
  await page.route('https://layout.test/voice-endpoint-closed.mjs', route => route.fulfill({
    contentType: 'text/javascript',
    body: `export function createVoice(runtime, handlers) {
      return {
        get speaking() { return false; },
        get listening() { return false; },
        get muted() { return true; },
        language() {},
        async startCapture() { handlers.status({ kind: 'capture', state: 'recording' }); },
        finishCapture() {
          handlers.status({ kind: 'capture', state: 'idle' });
          handlers.transcript('Dictated check-in note');
        },
        cancelCapture() { handlers.status({ kind: 'capture', state: 'idle' }); },
        stop() {},
        mute() {},
        dispose() {},
      };
    }`,
  }));
  await page.evaluate(() => {
    const w = window as any;
    w.api.assetUrl = () => 'https://layout.test/voice-endpoint-closed.mjs';
    w.submitted = [];
    w.storedEvents = [];
    w.failNextSubmit = true;
    w.api.application = {
      available: true,
      backend: {
        status: { canAuthor: true, phase: 'ready', connectedPeers: 0 },
        onStatus() { return () => {}; },
        async readView() {
          return {
            async readEvents() { return { events: w.storedEvents, hasMore: false, cursor: 'c1' }; },
            async release() {},
          };
        },
        async *changes() { /* idle */ },
        async submit(req: any) {
          w.submitted.push(req);
          if (w.failNextSubmit) {
            w.failNextSubmit = false;
            throw Object.assign(new Error('ENDPOINT_CLOSED'), { code: 'ENDPOINT_CLOSED' });
          }
          w.storedEvents.push({
            id: 'ev1',
            operationId: req.operationId,
            author: '00'.repeat(32),
            authorTimestampMs: String(Date.now()),
            topic: 'agent/message',
            payload: req.program.steps[0].payload,
          });
        },
      },
    };
    // Re-mount so chatModal attaches to the installed application backend
    w.disposeUtility();
    w.mount();
  });

  // Trigger voice dictation from the dock while chat modal is closed -> fails with ENDPOINT_CLOSED
  const talkBtn = page.getByRole('button', { name: 'Talk to assistant', exact: true });
  await talkBtn.hover();
  const voiceBtn = page.getByRole('button', { name: 'Voice input', exact: true });
  await expect.poll(async () => (await voiceBtn.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(40);
  await voiceBtn.click();
  const stopVoiceBtn = page.getByRole('button', { name: 'Finish voice input', exact: true });
  await expect(stopVoiceBtn).toHaveAttribute('data-recording', 'true');
  await stopVoiceBtn.click();

  // Chat modal opens automatically with the preserved dictated transcript and clear ENDPOINT_CLOSED message
  const dialog = page.getByRole('dialog', { name: 'Assistant' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('textbox', { name: 'Message', exact: true });
  await expect(input).toHaveValue('Dictated check-in note');
  await expect(dialog).toContainText('endpoint closed');

  // Retrying without editing reuses the EXACT same operationId (no duplicate external effect)
  await dialog.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).submitted.length)).toBe(2);
  const [firstOpId, secondOpId] = await page.evaluate(() => (window as any).submitted.map((r: any) => r.operationId));
  expect(secondOpId).toBe(firstOpId);
  await expect(dialog).toContainText('Saved locally');
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

test('Share & invite exposes optional Target view selector when facets are mounted and sends view in link creation', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await fixture(page);
  const links: any[] = [];
  let postedBody: any = null;
  await page.route('https://layout.test/_tendril/links**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      postedBody = request.postDataJSON();
      const created = {
        id: 'lnk_view',
        url: `https://layout.test/kiosk/${postedBody.view ? `?view=${postedBody.view}` : ''}`,
        role: postedBody.role,
        label: postedBody.label ?? null,
        view: postedBody.view ?? null,
        expires_at: null,
      };
      links.push(created);
      await route.fulfill({ status: 201, json: created });
      return;
    }
    await route.fulfill({ json: { name: 'Board', links } });
  });
  await page.route('https://layout.test/_tendril/guests**', route => route.fulfill({ json: { guests: [] } }));
  await page.evaluate(() => {
    const w = window as any;
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    w.api.publication.facets = [
      { id: 'workspace', title: 'Workspace', module: 'facets/workspace.mjs' },
      { id: 'kiosk', title: 'Wallboard', module: 'facets/kiosk.mjs' },
    ];
    w.disposeUtility();
    w.mount();
  });

  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('button', { name: /Share & invite/ }).click();
  await page.getByRole('tab', { name: 'Invite person', exact: true }).click();

  const viewSelect = page.getByRole('combobox', { name: 'Target view (optional)', exact: true });
  await expect(viewSelect).toBeVisible();
  await viewSelect.selectOption('kiosk');
  await page.getByRole('button', { name: 'Create invite link', exact: true }).click();

  await expect.poll(() => postedBody).toEqual({ role: 'guest', view: 'kiosk', expires_in: 604800 });
  await page.getByRole('tab', { name: /Links/ }).click();
  await expect(page.getByText('View: kiosk', { exact: true })).toBeVisible();
});
