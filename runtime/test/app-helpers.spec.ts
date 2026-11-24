import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

// Exercise real DOM, keyboard, pointer and storage behavior without speech models
// or microphone permissions. Voice/audio qualification remains a separate gate.
const voiceAdapter = `
export function createVoice(runtime, handlers) {
  const fixture = window.voiceFixture = { starts: 0, finishes: 0, cancels: 0, disposed: false, deferCapture: false, pendingCapture: null,
    completeCapture() { this.pendingCapture?.(); this.pendingCapture = null; },
    output(active, completed = false) { speaking = active; handlers.status({kind:'output',state:'idle',speaking:active,completed}); },
    transcript(text) { handlers.transcript(text); } };
  let listening = false, speaking = false, muted = true;
  let captureEpoch = 0;
  return {
    get listening() { return listening; }, get speaking() { return speaking; },
    get muted() { return muted; }, language() {},
    async startCapture() {
      fixture.starts++; const token = ++captureEpoch;
      if (fixture.deferCapture) {
        handlers.status({kind:'capture',state:'working'});
        await new Promise(resolve => { fixture.pendingCapture = resolve; });
      }
      if (token !== captureEpoch) return false;
      listening = true; handlers.status({kind:'capture',state:'recording'}); return true;
    },
    finishCapture() { fixture.finishes++; listening = false; handlers.status({kind:'capture',state:'idle'}); },
    cancelCapture() { fixture.cancels++; captureEpoch++; listening = false; handlers.status({kind:'capture',state:'idle'}); },
    stop() { captureEpoch++; listening = false; handlers.status({kind:'capture',state:'idle'}); fixture.output(false, false); }, mute() { muted = true; fixture.output(false, false); },
    async enableOutput() { muted = false; return true; }, speak() { fixture.output(true); },
    dispose() { fixture.disposed = true; listening = false; },
  };
}`;
let origin: string, server: Server;
test.beforeAll(async () => {
  const chat = await build({
    entryPoints: [new URL('../src/voice/chat.ts', import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'browser', write: false,
    plugins: [{ name: 'voice-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/index$/ }, args => args.importer.endsWith('/voice/chat.ts') ? { path: 'voice-fixture', namespace: 'voice-fixture' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'voice-fixture' }, () => ({ contents: voiceAdapter, loader: 'js' }));
    } }],
  });
  const dashboard = await build({ entryPoints: [new URL('../../docs/tutorial/ui/dashboard.mjs', import.meta.url).pathname], bundle: true, format: 'esm', write: false });
  server = createServer((request, response) => {
    if (request.url === '/chat.js' || request.url === '/dashboard.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end((request.url === '/chat.js' ? chat : dashboard).outputFiles[0].text); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Application helper qualification</title>
      <style>body{margin:0}main{min-width:0}</style><main id="dashboard"></main>
      <script type="module">
        import {mountAgentChat} from '/chat.js';
        import {mountDashboardShell,mountMetricCard,mountFeedListCard,mountFeedbackCard} from '/dashboard.js';
        window.sent=[];window.feedback=[];window.actions=[];window.failSend=false;
        const listeners = new Map();
        window.wakeFixture={requests:0,releases:0,unavailable:true};
        window.runtime={identity:{page:'test-page'},sensors:{async wakeLock(){
          window.wakeFixture.requests++;
          if(window.wakeFixture.unavailable)throw Error('Wake lock unavailable');
          return {async release(){window.wakeFixture.releases++}};
        }},on(type,fn){let set=listeners.get(type);if(!set)listeners.set(type,set=new Set());set.add(fn);return()=>set.delete(fn)}};
        window.emitRuntime=(type,value)=>{for(const fn of listeners.get(type)||[])fn(value)};
        window.chat=mountAgentChat(window.runtime,{title:'Test assistant',voiceOutput:new URL(location.href).searchParams.has('speech')?'browser':false,
          onSend:async input=>{if(window.failSend)throw Error('Delivery unavailable');window.sent.push(input)},
          onAction:action=>{if(window.failAction)throw Error('Action unavailable');window.actions.push(action)}});
        window.dashboard=mountDashboardShell(document.querySelector('main'),{title:'Operations'});
        window.metric=mountMetricCard(window.dashboard.grid,{title:'Temperature',unit:'°C',onAskAgent:()=>window.chat.setContext({label:'Temperature',data:{sensor:'room'}})});
        window.activity=mountFeedListCard(window.dashboard.grid,{title:'Alerts'});
        const autoFeedback=new URL(location.href).searchParams.has('autoFeedback');
        window.feedbackCard=mountFeedbackCard(window.dashboard.grid,{
          ...(autoFeedback?{allowNote:false,choices:[{label:'Proceed',value:0},{label:'Pause',value:false}]}:{}),
          onSubmit:input=>{window.feedback.push(input);if(autoFeedback)return new Promise((resolve,reject)=>{
            window.finishFeedback=resolve;window.failFeedback=()=>reject(Error('Feedback unavailable'));
          })}
        });
        window.ready=true;
      </script></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No fixture server address');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (!server) return;
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections(); await closed;
});
test.beforeEach(async ({ page }) => {
  await page.goto(origin); await page.waitForFunction(() => (window as any).ready);
});

test('keyboard sends context, failed sends retain draft, and reload restores unsent text', async ({ page }) => {
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await page.getByRole('button', { name: 'Test assistant', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeFocused();
  await input.fill('Explain this reading'); await input.press('Enter');
  expect(await page.evaluate(() => (window as any).sent)).toEqual([{text:'Explain this reading',via:'text',context:{sensor:'room'}}]);
  await page.evaluate(() => { (window as any).failSend = true; });
  await input.fill('Keep this request'); await input.press('Enter');
  await expect(page.getByText('Delivery unavailable', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Keep this request');
  await page.reload();
  await page.getByRole('button', { name: 'Test assistant', exact: true }).click();
  await expect(input).toHaveValue('Keep this request');
  await input.fill('Unsent draft'); await page.reload();
  await page.getByRole('button', { name: 'Test assistant', exact: true }).click();
  await expect(input).toHaveValue('Unsent draft');
});

test('hold release finishes one recording without click restarting it; reviewed voice stays editable', async ({ page }) => {
  await page.getByRole('button', { name: 'Test assistant', exact: true }).click();
  const mic = page.getByRole('button', { name: 'Tap to speak or hold to talk' });
  await mic.hover(); await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as any).voiceFixture.starts)).toBe(1);
  await page.mouse.up();
  expect(await page.evaluate(() => ({starts:(window as any).voiceFixture.starts,finishes:(window as any).voiceFixture.finishes}))).toEqual({starts:1,finishes:1});
  await page.getByRole('checkbox', { name: 'Send voice immediately' }).uncheck();
  await page.evaluate(() => (window as any).voiceFixture.transcript('Review this transcript'));
  await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue('Review this transcript');
  expect(await page.evaluate(() => (window as any).sent)).toEqual([]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect(await page.evaluate(() => (window as any).sent)).toEqual([{text:'Review this transcript',via:'text'}]);
});

test('releasing a held microphone during preparation cancels the pending recording', async ({ page }) => {
  await page.getByRole('button', { name: 'Test assistant', exact: true }).click();
  await page.evaluate(() => { (window as any).voiceFixture.deferCapture = true; });
  await page.getByRole('button', { name: 'Tap to speak or hold to talk' }).hover();
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as any).voiceFixture.starts)).toBe(1);
  await page.mouse.up();
  await page.evaluate(() => (window as any).voiceFixture.completeCapture());
  expect(await page.evaluate(() => ({starts:(window as any).voiceFixture.starts,cancels:(window as any).voiceFixture.cancels,listening:(window as any).chat.voice.listening}))).toEqual({starts:1,cancels:1,listening:false});
});

test('hands-free only rearms on natural completion, never Stop, barge-in or Stop sensors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/?speech`); await page.waitForFunction(() => (window as any).ready);
  await page.clock.install();
  await page.getByRole('button', { name: 'Test assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Hands-free', exact: true }).click();
  await page.evaluate(() => (window as any).voiceFixture.output(true));
  await page.getByRole('button', { name: 'Stop speaking', exact: true }).click();
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toBe(0);
  await page.evaluate(() => (window as any).voiceFixture.output(true));
  await page.getByRole('button', { name: 'Tap to speak or hold to talk' }).click();
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toBe(1);
  await page.getByRole('button', { name: 'Finish recording', exact: true }).click();
  await page.evaluate(() => { const f=(window as any).voiceFixture;f.output(true);f.output(false,true); });
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toBe(2);
  await page.getByRole('button', { name: 'Finish recording', exact: true }).click();
  await page.evaluate(() => { const w=window as any;w.voiceFixture.output(true);w.voiceFixture.output(false,true);w.emitRuntime('sensors_stopped',{}); });
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toBe(2);
  // A fresh reply supersedes the prior reply's pending follow-up capture.
  await page.evaluate(() => { const f=(window as any).voiceFixture;f.output(true);f.output(false,true);f.output(true); });
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toBe(2);
  await page.evaluate(() => (window as any).voiceFixture.output(false,true));
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as any).voiceFixture.starts)).toBe(3);
  // Unavailable wake locks are best-effort; they must not break conversation controls.
  expect(await page.evaluate(() => (window as any).wakeFixture.requests)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('hands-free releases its available wake lock when the dock closes', async ({ page }) => {
  await page.goto(`${origin}/?speech`); await page.waitForFunction(() => (window as any).ready);
  await page.evaluate(() => { (window as any).wakeFixture.unavailable = false; });
  await page.getByRole('button', { name: 'Test assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Hands-free', exact: true }).click();
  expect(await page.evaluate(() => (window as any).wakeFixture.requests)).toBe(1);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).wakeFixture.releases)).toBe(1);
});

test('Escape stops recording, closes the dock and restores keyboard focus', async ({ page }) => {
  const launcher = page.getByRole('button', { name: 'Test assistant', exact: true });
  await launcher.click();
  const mic = page.getByRole('button', { name: 'Tap to speak or hold to talk' });
  await mic.click();
  await expect(page.getByRole('button', { name: 'Finish recording', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Test assistant', exact: true })).toBeHidden();
  await expect(launcher).toBeFocused();
  expect(await page.evaluate(() => (window as any).chat.voice.listening)).toBe(false);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeFocused();
});

test('feedback serializes async submissions, preserves failures and accepts falsy choice values', async ({ page }) => {
  await page.goto(`${origin}/?autoFeedback`); await page.waitForFunction(() => (window as any).ready);
  const proceed = page.getByRole('button', { name: 'Proceed', exact: true });
  const pause = page.getByRole('button', { name: 'Pause', exact: true });
  await proceed.click();
  await expect(proceed).toBeDisabled(); await expect(pause).toBeDisabled();
  await pause.dispatchEvent('click');
  expect(await page.evaluate(() => (window as any).feedback)).toEqual([{choice:0,note:''}]);
  await page.evaluate(() => (window as any).failFeedback());
  await expect(page.getByRole('status')).toHaveText('Feedback unavailable');
  await expect(proceed).toHaveAttribute('aria-pressed', 'true');
  await expect(proceed).toBeEnabled();
  await proceed.click(); await page.evaluate(() => (window as any).finishFeedback());
  await expect(page.getByRole('status')).toHaveText('Feedback sent.');
  await pause.click(); await page.evaluate(() => (window as any).finishFeedback());
  await expect(page.getByRole('status')).toHaveText('Feedback sent.');
  expect(await page.evaluate(() => (window as any).feedback)).toEqual([{choice:0,note:''},{choice:0,note:''},{choice:false,note:''}]);
});

test('dashboard empty/live/error views, feedback, long chat content and disposal', async ({ page }, testInfo) => {
  await expect(page.getByText('No items yet.', { exact: true })).toBeVisible();
  await expect(page.locator('.td-metric-value')).toHaveText('—');
  await page.screenshot({path:testInfo.outputPath('empty.png'),fullPage:true});
  await page.evaluate(() => {
    const w = window as any;
    w.metric.update({value:23,history:[18,20,23],detail:'Room sensor'});
    w.activity.update([{title:'Window open',detail:'Check the north room',badge:'Warning',tone:'warn'}]);
    w.chat.setMessages([{id:'reply',role:'agent',text:'LongContent'.repeat(150),actions:[{id:'inspect',label:'Inspect sensor'}]}]);
    w.chat.setStreamingReply('Checking the sensor…');
  });
  await expect(page.locator('.td-metric-value')).toHaveText('23');
  await expect(page.getByText('Window open', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Investigate', exact: true }).click();
  await page.locator('.td-note').fill('Please check');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(page.getByText('Feedback sent.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).feedback)).toEqual([{choice:'Investigate',note:'Please check'}]);
  await page.getByRole('button', { name: 'Test assistant', exact: true }).click();
  await expect(page.getByText('Checking the sensor…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect sensor', exact: true }).click();
  expect(await page.evaluate(() => (window as any).actions)).toEqual([{messageId:'reply',actionId:'inspect',label:'Inspect sensor'}]);
  await page.evaluate(() => { (window as any).failAction = true; });
  await page.getByRole('button', { name: 'Inspect sensor', exact: true }).click();
  await expect(page.getByText('Action unavailable', { exact: true })).toBeVisible();
  const shell = await page.getByRole('region', {name:'Test assistant',exact:true}).boundingBox();
  expect(shell).toBeTruthy(); expect(shell!.x).toBeGreaterThanOrEqual(0);
  expect(shell!.x + shell!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('live.png'),fullPage:true});
  await page.evaluate(() => (window as any).metric.setError('Sensor unavailable'));
  await expect(page.getByText('Sensor unavailable', {exact:true})).toBeVisible();
  await page.evaluate(() => { const w=window as any;w.chat.dispose();w.metric.close();w.activity.close();w.feedbackCard.close();w.dashboard.close(); });
  await expect(page.locator('tendril-agent-chat')).toHaveCount(0);
  await expect(page.locator('.td-shell')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).voiceFixture.disposed)).toBe(true);
});
