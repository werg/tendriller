import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { build } from 'esbuild';
import { MockServer } from './mock-server';

// Exercise the policy source in a real DOM without rebuilding shared release assets.
const compiled = await build({ stdin: {
  contents: "export * from './runtime/src/updates.ts';export {mountUtility} from './runtime/src/utility.ts';export {createTransportBinding} from './runtime/src/transport.ts';",
  resolveDir: new URL('../..', import.meta.url).pathname, loader: 'ts',
}, bundle: true,
  format: 'iife', globalName: 'UpdatePolicy', platform: 'browser', write: false });
let mock: MockServer;
test.beforeAll(async () => { mock = new MockServer(); await mock.start(); });
test.afterAll(async () => { await mock.stop(); });
async function policy(page: Page, html = '<button id="outside">Outside</button>', pinned = false, mode: 'live' | 'careful' | null = 'careful') {
  let stream!: WebSocketRoute;
  await page.clock.install();
  await page.routeWebSocket('**/_tendril/publication-ready', route => {
    stream = route; route.send(JSON.stringify({ type: 'publication', version: 1, current: 1 }));
  });
  await page.goto(mock.origin);
  await page.setContent(html);
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  await page.evaluate(({ origin, pinned, mode }) => {
    const w = window as any;
    w.reloads = 0; w.notices = [];
    w.cfg = { base: origin + '/t/example/', version: 1, publication: {}, documentPath: 'index.html' };
    w.updates = w.UpdatePolicy.watchPublicationUpdates(w.cfg, { pinned, watch: true, reload: () => w.reloads++, ...(mode ? { policy: mode } : {}) });
    w.updates.onUpdate((notice: unknown) => w.notices.push(notice));
  }, { origin: mock.origin, pinned, mode });
  await expect.poll(() => !!stream).toBe(true);
  return async (current: number) => {
    stream.send(JSON.stringify({ type: 'publication', version: 1, current }));
    await expect.poll(() => page.evaluate(() => (window as any).updates.updateAvailable)).toBe(current !== 1 && current !== 0);
  };
}
const reloads = (page: Page) => page.evaluate(() => (window as any).reloads);
async function mountUtility(page: Page) {
  await page.evaluate(() => {
    const w = window as any, noop = () => () => {};
    w.disposeUtility = w.UpdatePolicy.mountUtility({
      transport: w.UpdatePolicy.createTransportBinding().api,
      identity: { base: w.cfg.base, version: 1, publication: null, managementUrl: w.cfg.base + '_tendril/manage' },
      publication: w.updates,
      installation: { status: () => ({ state: 'unavailable', platform: 'desktop' }), on: noop },
      sensors: { status: () => ({ active: [], pending: [] }), on: noop, stopAll: () => 0 },
    });
  });
}

test('fresh utility permission defaults do not block an idle publication switch', async ({ page }) => {
  const notice = await policy(page);
  await mountUtility(page);
  expect(await page.locator('tendril-utility input[type=checkbox]').evaluateAll(inputs => inputs.map(input => {
    const box = input as HTMLInputElement; return [box.checked, box.defaultChecked];
  }))).toEqual([[true, true], [true, true], [false, false], [false, false], [false, false]]);
  await notice(2);
  expect(await reloads(page)).toBe(1);
});

test('edited utility permissions still protect a blurred draft until restored', async ({ page }) => {
  const notice = await policy(page);
  await mountUtility(page);
  await page.evaluate(() => {
    const box = document.querySelector('tendril-utility')!.shadowRoot!.querySelector('input[type=checkbox]') as HTMLInputElement;
    box.checked = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  await notice(2); await page.clock.runFor(60_000);
  expect(await reloads(page)).toBe(0);
  await page.evaluate(() => {
    const box = document.querySelector('tendril-utility')!.shadowRoot!.querySelector('input[type=checkbox]') as HTMLInputElement;
    box.checked = box.defaultChecked;
    box.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  });
  await page.clock.runFor(1);
  expect(await reloads(page)).toBe(1);
});

const dirtyControls = [
  { name: 'checkbox checkedness (constant value=yes)', html: '<input id="editor" type="checkbox" value="yes">', kind: 'checkbox' },
  { name: 'radio group default checkedness', html: '<input type="radio" name="r" checked><input id="editor" name="r" type="radio">', kind: 'checkbox' },
  { name: 'range value', html: '<input id="editor" type="range" value="3" min="0" max="10">', kind: 'value' },
  { name: 'disabled textarea draft', html: '<textarea id="editor">original</textarea>', kind: 'disabled' },
  { name: 'read-only textarea draft', html: '<textarea id="editor">original</textarea>', kind: 'readonly' },
  { name: 'disabled input draft', html: '<input id="editor" value="original">', kind: 'disabled' },
  { name: 'read-only input draft', html: '<input id="editor" value="original">', kind: 'readonly' },
  { name: 'single select with implicit default', html: '<select id="editor"><option>A</option><option>B</option></select>', kind: 'select' },
  { name: 'multiple select with explicit defaults', html: '<select id="editor" multiple><option selected>A</option><option>B</option></select>', kind: 'select' },
];
for (const control of dirtyControls) test(`automatic switching preserves ${control.name} after blur, also when hidden`, async ({ page }) => {
  const notice = await policy(page, control.html);
  await page.evaluate(kind => {
    const editor = document.querySelector('#editor') as HTMLInputElement;
    if (kind === 'checkbox') editor.checked = true;
    else if (kind === 'select') (editor as unknown as HTMLSelectElement).options[1].selected = true;
    else { editor.value = '7'; if (kind === 'disabled') editor.disabled = true; if (kind === 'readonly') editor.readOnly = true; }
    editor.blur(); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  }, control.kind);
  await notice(2); await page.clock.runFor(10_000);
  expect(await reloads(page)).toBe(0);
  await page.evaluate(() => { document.body.replaceChildren(); document.dispatchEvent(new Event('change')); });
  await expect.poll(() => reloads(page)).toBe(1);
});

test('clean disabled/read-only controls, implicit select defaults and checkbox values permit a hidden-page switch', async ({ page }) => {
  const notice = await policy(page, '<input type="range"><input type="color"><input type="number" value="invalid"><input disabled value="saved"><textarea readonly>saved</textarea><input type="checkbox" value="yes"><input type="radio" checked><select><option disabled>skip</option><option>default</option></select><select multiple><option>A</option></select>');
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' }));
  await notice(2); await expect.poll(() => reloads(page)).toBe(1);
});

test('nested open shadow roots protect a clean focused editor and its blurred dirty value', async ({ page }) => {
  const notice = await policy(page);
  await page.evaluate(() => {
    const host = document.createElement('section'); document.body.append(host);
    const child = document.createElement('section'); host.attachShadow({ mode: 'open' }).append(child);
    const editor = document.createElement('textarea'); editor.id = 'shadow-editor'; child.attachShadow({ mode: 'open' }).append(editor); editor.focus();
    (window as any).editor = editor;
  });
  await notice(2); expect(await reloads(page)).toBe(0);
  await page.evaluate(() => { (window as any).editor.value = 'unsaved'; (window as any).editor.blur(); });
  await page.clock.runFor(5000); expect(await reloads(page)).toBe(0);
  await page.evaluate(() => { (window as any).editor.value = ''; document.dispatchEvent(new Event('change')); });
  await expect.poll(() => reloads(page)).toBe(1);
});

test('an explicit hold protects blurred custom editors in closed shadow roots until the app saves', async ({ page }) => {
  const notice = await policy(page);
  await page.evaluate(() => {
    const host = document.createElement('section'); document.body.append(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<div contenteditable>unsaved custom model</div>';
    (window as any).release = (window as any).updates.hold();
  });
  await notice(2); await page.clock.runFor(10_000); expect(await reloads(page)).toBe(0);
  await page.evaluate(() => (window as any).release()); await expect.poll(() => reloads(page)).toBe(1);
});

test('focused plaintext-only contenteditable in an open shadow root blocks switching', async ({ page }) => {
  const notice = await policy(page);
  await page.evaluate(() => { const host = document.createElement('section'); document.body.append(host); host.attachShadow({ mode: 'open' }).innerHTML = '<div contenteditable="plaintext-only">editor</div>'; (host.shadowRoot!.firstChild as HTMLElement).focus(); });
  await notice(2); await page.clock.runFor(5000); expect(await reloads(page)).toBe(0);
});

test('rollback withdraws a notice while held; a later lower-numbered selection is still an update', async ({ page }) => {
  const notice = await policy(page); await page.evaluate(() => (window as any).release = (window as any).updates.hold());
  await notice(3); await notice(1);
  expect(await page.evaluate(() => (window as any).notices)).toEqual([{ version: 3 }, { version: null }]);
  await page.evaluate(() => (window as any).release()); expect(await reloads(page)).toBe(0);
  await notice(2); expect(await reloads(page)).toBe(1);
});

test('multiple holds are independent, and manual update explicitly overrides them', async ({ page }) => {
  const notice = await policy(page, '<textarea>saved</textarea>');
  await page.evaluate(() => { const w = window as any; w.a = w.updates.hold(); w.b = w.updates.hold(); });
  await notice(2); await page.evaluate(() => (window as any).a()); expect(await reloads(page)).toBe(0);
  await page.evaluate(() => (window as any).updates.update()); expect(await reloads(page)).toBe(1);
});

test('close fences deferred edits, timer ticks, held releases and manual update', async ({ page }) => {
  const notice = await policy(page); await page.evaluate(() => (window as any).release = (window as any).updates.hold());
  await notice(2);
  await page.evaluate(() => {
    const w = window as any; document.dispatchEvent(new Event('change')); w.updates.close(); w.updates.close();
    w.release(); w.updates.update(); document.dispatchEvent(new Event('focusout')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow'));
  });
  await page.clock.runFor(10_000); expect(await reloads(page)).toBe(0);
  expect(await page.evaluate(() => (window as any).updates.updateAvailable)).toBe(false);
});

test('pin detection matches only a valid immutable route relative to this page base', async ({ page }) => {
  await page.goto(mock.origin); await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const result = await page.evaluate(origin => {
    const w = window as any, cfg = { base: origin + '/page/', publication: {} };
    return ['_publications/1/', '_publications/23/docs/help.html', 'docs/_publications/help.html', '_publications/0/', '_publications/01/', '_publications/not-a-version/', '_publications/9007199254740992/'].map(path => w.UpdatePolicy.explicitlyPinned(cfg, origin + '/page/' + path))
      .concat(w.UpdatePolicy.explicitlyPinned(cfg, origin + '/other/_publications/1/'));
  }, mock.origin);
  expect(result).toEqual([true, true, false, false, false, false, false, false]);
});

test('idle publication waiting installs no polling and programmatic saves require an explicit event or hold release', async ({ page }) => {
  const notice = await policy(page, '<textarea id="editor">saved</textarea>');
  await page.evaluate(() => {
    const w=window as any;
    const native=document.querySelector('#editor') as HTMLTextAreaElement;
    native.value='draft';w.safetyScans=0;
    const query=document.querySelectorAll.bind(document);
    document.querySelectorAll=((...args: Parameters<typeof query>)=>{w.safetyScans++;return query(...args);}) as typeof document.querySelectorAll;
  });
  await notice(2);
  const initial=await page.evaluate(()=>(window as any).safetyScans);
  await page.clock.runFor(60_000);
  expect(await page.evaluate(()=>(window as any).safetyScans)).toBe(initial);
  expect(await reloads(page)).toBe(0);
  await page.evaluate(()=>{const editor=document.querySelector('#editor') as HTMLTextAreaElement;editor.value='saved';});
  await page.clock.runFor(60_000);expect(await reloads(page)).toBe(0);
  await page.evaluate(()=>document.querySelector('#editor')!.dispatchEvent(new Event('input',{bubbles:true})));
  await page.clock.runFor(1);expect(await reloads(page)).toBe(1);
});

test('native form reset retries a waiting update after defaults are restored', async ({ page }) => {
  const notice=await policy(page,'<form><textarea id="editor">saved</textarea></form>');
  await page.evaluate(()=>(document.querySelector('#editor') as HTMLTextAreaElement).value='draft');
  await notice(2);expect(await reloads(page)).toBe(0);
  await page.evaluate(()=>(document.querySelector('form') as HTMLFormElement).reset());
  await page.clock.runFor(1);expect(await reloads(page)).toBe(1);
});

test('programmatic save under a hold releases only after inspectable defaults match', async ({ page }) => {
  const notice=await policy(page,'<textarea id="editor">saved</textarea>');
  await page.evaluate(()=>{const w=window as any;w.release=w.updates.hold();(document.querySelector('#editor') as HTMLTextAreaElement).value='programmatic draft';});
  await notice(2);await page.clock.runFor(60_000);expect(await reloads(page)).toBe(0);
  await page.evaluate(()=>{const editor=document.querySelector('#editor') as HTMLTextAreaElement;editor.defaultValue=editor.value;(window as any).release();});
  expect(await reloads(page)).toBe(1);
});

for (const held of [false,true]) test(`open-shadow native form reset waits for ${held?'explicit hold release':'another observed trigger'} without polling`,async({page})=>{
 const notice=await policy(page);
 await page.evaluate(held=>{
  const w=window as any,host=document.createElement('section');document.body.append(host);
  const shadow=host.attachShadow({mode:'open'});shadow.innerHTML='<form><textarea>saved</textarea></form>';
  w.shadowForm=shadow.querySelector('form');w.shadowEditor=shadow.querySelector('textarea');
  w.shadowResetAtDocument=0;document.addEventListener('reset',()=>w.shadowResetAtDocument++,true);
  if(held)w.release=w.updates.hold();w.shadowEditor.value='unsaved';
 },held);
 await notice(2);expect(await reloads(page)).toBe(0);
 await page.evaluate(()=>(window as any).shadowForm.reset());
 expect(await page.evaluate(()=>(window as any).shadowEditor.value)).toBe('saved');
 expect(await page.evaluate(()=>(window as any).shadowResetAtDocument)).toBe(0);
 await page.clock.runFor(60_000);expect(await reloads(page)).toBe(0);
 await page.evaluate(held=>{if(held)(window as any).release();else document.dispatchEvent(new Event('visibilitychange'));},held);
 expect(await reloads(page)).toBe(1);
});

test('live is the default: focus and app-set values never block, and no prompt is shown', async ({ page }) => {
  const notice = await policy(page, '<input id="search" value=""><textarea id="settings">saved</textarea><input id="slider" type="range" value="3">', false, null);
  expect(await page.evaluate(() => (window as any).updates.policy)).toBe('live');
  await mountUtility(page);
  await page.evaluate(() => {
    (document.querySelector('#settings') as HTMLTextAreaElement).value = 'loaded from app data';
    (document.querySelector('#slider') as HTMLInputElement).value = '9';
    (document.querySelector('#search') as HTMLInputElement).focus();
  });
  await notice(2);
  await expect.poll(() => reloads(page)).toBe(1);
  expect(await page.locator('tendril-utility').evaluate(host => (host.shadowRoot!.querySelector('[aria-label="Publication update"]') as HTMLElement).hidden)).toBe(true);
});

test('live waits only for text the person typed, then switches once it is sent or cleared', async ({ page }) => {
  const notice = await policy(page, '<textarea id="composer"></textarea>', false, 'live');
  await page.locator('#composer').pressSequentially('half a message');
  await notice(2); await page.clock.runFor(5000);
  expect(await reloads(page)).toBe(0);
  await page.locator('#composer').fill('');
  await expect.poll(() => reloads(page)).toBe(1);
});

test('the careful policy is chosen by authored metadata read after the head is parsed', async ({ page }) => {
  const notice = await policy(page, '<meta name="tendriller-updates" content="careful"><textarea id="settings">saved</textarea>', false, null);
  expect(await page.evaluate(() => (window as any).updates.policy)).toBe('careful');
  await page.evaluate(() => { (document.querySelector('#settings') as HTMLTextAreaElement).value = 'app value'; });
  await notice(2); await page.clock.runFor(5000);
  expect(await reloads(page)).toBe(0);
});
