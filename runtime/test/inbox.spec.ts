import {test, expect, type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';

// Serve the maintained card and modules unchanged. Only the standard MCP Apps
// parent and activity socket are fixtures; no legacy adapter or fake DOM.
const inbox = new URL('../../server/inbox/', import.meta.url);
async function card(page: Page, handshake: 'allow'|'deny'|'timeout' = 'allow', holdMessage = false) {
  const errors: string[] = [], sockets: string[] = [], closed: number[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('wss://activity.test/**', socket => {
    sockets.push(socket.url());
    socket.onClose(() => closed.push(1));
  });
  await page.route('https://inbox.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/host') return route.fulfill({contentType: 'text/html', body: `<!doctype html><title>MCP Apps host</title>
<script>
window.messages = [];
window.sendToCard = message => document.querySelector('iframe').contentWindow.postMessage(message, location.origin);
addEventListener('message', event => {
  if (event.source !== document.querySelector('iframe').contentWindow || event.origin !== location.origin) return;
  const message = event.data; window.messages.push(message);
  if (message.method === 'ui/initialize' && ${JSON.stringify(handshake)} !== 'timeout') {
    window.sendToCard({jsonrpc:'2.0', id:message.id, ...(${JSON.stringify(handshake)} === 'deny'
      ? {error:{code:-32000,message:'Host policy denied initialization'}}
      : {result:{protocolVersion:'2026-01-26',hostCapabilities:{message:{text:{}}}}})});
  }
  if (message.method === 'ui/message' && !${JSON.stringify(holdMessage)}) window.sendToCard({jsonrpc:'2.0',id:message.id,result:{}});
});
</script><iframe title="Application inbox" src="/card"></iframe>`});
    if (path === '/card') return route.fulfill({contentType: 'text/html', body:
      readFileSync(new URL('template.html', inbox), 'utf8').replace('<!-- APP -->', '<script type="module" src="/app.mjs"></script>')});
    if (path === '/app.mjs' || path === '/bridge.mjs') return route.fulfill({contentType: 'text/javascript', body:
      readFileSync(new URL(path.slice(1), inbox), 'utf8')});
    return route.abort();
  });
  await page.goto('https://inbox.test/host');
  const frame = page.frameLocator('iframe');
  await expect.poll(() => page.evaluate(() => (window as any).messages.filter((m: any) => m.method === 'ui/initialize').length)).toBe(1);
  return {frame, errors, sockets, closed};
}
async function result(page: Page) {
  await page.evaluate(() => (window as any).sendToCard({jsonrpc:'2.0', method:'ui/notifications/tool-result', params:{
    structuredContent:{applicationId:'ab'.repeat(32),pageId:'abcdefghijkl',label:'Reviewed application'},
    _meta:{origin:'https://activity.test',activity:{proof:'fixture.'+'a'.repeat(43),exp:Date.now()+60_000}},
  }}));
}
async function messageCount(page: Page) {
  return page.evaluate(() => (window as any).messages.filter((m: any) => m.method === 'ui/message').length);
}

test('standard MCP Apps card initializes without sending a message and follows up only on a click', async ({page}) => {
  const {frame, errors, sockets} = await card(page);
  await expect.poll(() => page.evaluate(() => (window as any).messages.some((m: any) => m.method === 'ui/notifications/initialized'))).toBe(true);
  await expect(frame.getByRole('button')).toBeDisabled();
  expect(await messageCount(page)).toBe(0);
  expect(sockets).toHaveLength(0);
  await result(page);
  await expect(frame.getByRole('heading')).toHaveText('Reviewed application');
  await expect(frame.getByRole('status')).toHaveText('Watching for activity while this card is open.');
  await expect(frame.getByRole('button')).toBeEnabled();
  expect(await messageCount(page)).toBe(0);
  await frame.getByRole('button', {name:'Check inbox in this chat'}).click();
  await expect(frame.getByRole('status')).toHaveText('Inbox request sent to this chat.');
  expect(await messageCount(page)).toBe(1);
  const message = await page.evaluate(() => (window as any).messages.find((m: any) => m.method === 'ui/message'));
  expect(message.params.role).toBe('user');
  expect(message.params.content).toEqual([{type:'text',text:expect.stringContaining('read_application_events for applicationId '+'ab'.repeat(32))}]);
  expect(errors).toEqual([]);
});

for (const handshake of ['deny','timeout'] as const) test(`${handshake} initialization gives an actionable fallback without sending a message`, async ({page}) => {
  if (handshake === 'timeout') await page.clock.install();
  const {frame, errors, sockets} = await card(page, handshake);
  if (handshake === 'timeout') await page.clock.fastForward(10_001);
  await expect(frame.getByRole('status')).not.toHaveText('Connecting…');
  await expect(frame.getByRole('status')).toContainText(/ask the chat|check the inbox directly/i);
  await expect(frame.getByRole('button')).toBeDisabled();
  // Late tool results cannot reopen activity after failed initialization.
  await result(page);
  expect(await messageCount(page)).toBe(0);
  expect(sockets).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('standard resource teardown acknowledges the host and closes the active activity socket', async ({page}) => {
  const {frame, errors, sockets, closed} = await card(page);
  await expect.poll(() => page.evaluate(() => (window as any).messages.some((m: any) => m.method === 'ui/notifications/initialized'))).toBe(true);
  await result(page);
  await expect(frame.getByRole('status')).toHaveText('Watching for activity while this card is open.');
  expect(sockets).toHaveLength(1);
  await page.evaluate(() => (window as any).sendToCard({jsonrpc:'2.0',id:'teardown-1',method:'ui/resource-teardown',params:{}}));
  await expect(frame.locator('#send')).toBeDisabled();
  await expect.poll(() => closed.length).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).messages.some((m: any) => m.id === 'teardown-1' && m.result))).toBeTruthy();
  await result(page);
  expect(sockets).toHaveLength(1);
  expect(await messageCount(page)).toBe(0);
  expect(errors).toEqual([]);
});


test('teardown while a follow-up is pending keeps the retained card disabled', async ({page}) => {
  const {frame, errors, sockets, closed} = await card(page, 'allow', true);
  await expect.poll(() => page.evaluate(() => (window as any).messages.some((m: any) => m.method === 'ui/notifications/initialized'))).toBe(true);
  await result(page);
  await expect(frame.getByRole('status')).toHaveText('Watching for activity while this card is open.');
  await frame.getByRole('button').click();
  await expect.poll(() => messageCount(page)).toBe(1);
  await expect(frame.getByRole('button')).toBeDisabled();
  await page.evaluate(() => (window as any).sendToCard({jsonrpc:'2.0',id:'pending-teardown',method:'ui/resource-teardown',params:{}}));
  await expect.poll(() => closed.length).toBe(1);
  // close() rejects the pending send; wait for its catch/finally to finish,
  // rather than accepting the temporary disabled state during submission.
  await expect(frame.getByRole('status')).toHaveText('The chat did not confirm receipt. Check the conversation before trying again.');
  await expect(frame.getByRole('button')).toBeDisabled();
  // A late host reply cannot revive a closed bridge or trigger another send.
  await page.evaluate(() => {
    const host = window as any;
    const pending = host.messages.find((message: any) => message.method === 'ui/message');
    host.sendToCard({jsonrpc:'2.0',id:pending.id,result:{}});
  });
  expect(sockets).toHaveLength(1);
  expect(await messageCount(page)).toBe(1);
  expect(errors).toEqual([]);
});
