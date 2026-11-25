import { LOCAL_WORKER_SERVICE } from '../../scripts/e2e-network.mjs';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('the mounted inbox shows socket activity and prompts its host only after a click', async ({ page }) => {
  const bundle = await readFile('server/public/application-inbox.html', 'utf8');
  const origin = LOCAL_WORKER_SERVICE;
  const appId = 'a'.repeat(64);
  const grant = { proof: 'sample.' + 'a'.repeat(43), exp: Date.now() + 60_000 };
  await page.route(origin + '/inbox-test', route => route.fulfill({
    contentType: 'text/html', body: '<iframe src="/inbox-preview" title="Inbox"></iframe>',
  }));
  await page.route(origin + '/inbox-preview', route => route.fulfill({ contentType: 'text/html', body: bundle }));
  await page.addInitScript(({ appId, origin, grant }) => {
    if (window === window.top) {
      const prompts: unknown[] = [];
      Object.assign(window, { prompts });
      window.addEventListener('message', event => {
        const source = event.source as Window;
        if (event.data?.method === 'ui/initialize') source.postMessage({ jsonrpc: '2.0', id: event.data.id,
          result: { protocolVersion: '2026-01-26', hostCapabilities: { message: { text: {} } } },
        }, origin);
        if (event.data?.method === 'ui/notifications/initialized') source.postMessage({
          jsonrpc: '2.0', method: 'ui/notifications/tool-result',
          params: { structuredContent: { applicationId: appId, pageId: 'a'.repeat(12), label: 'Lab notebook' },
            _meta: { activity: grant, origin } },
        }, origin);
        if (event.data?.method === 'ui/message') {
          prompts.push(event.data.params);
          source.postMessage({ jsonrpc: '2.0', id: event.data.id, result: { isError: prompts.length > 1 } }, origin);
        }
      });
    } else {
      class TestSocket extends EventTarget {
        constructor(url: URL, protocols: string[]) {
          super();
          Object.assign(window, { activityTransport: { url: url.href, protocols, socket: this } });
          queueMicrotask(() => this.dispatchEvent(new Event('open')));
        }
        close() { this.dispatchEvent(new Event('close')); }
      }
      Object.assign(window, { WebSocket: TestSocket });
    }
  }, { appId, origin, grant });
  await page.goto('/inbox-test');
  const card = page.frameLocator('iframe');
  await expect(card.getByRole('heading')).toHaveText('Lab notebook');
  await expect(card.getByRole('status')).toHaveText(/Watching for activity/);
  const frame = page.frames().find(candidate => candidate !== page.mainFrame())!;
  const url = await frame.evaluate(() => {
    const transport = (window as any).activityTransport;
    transport.socket.dispatchEvent(new MessageEvent('message', { data: '{"type":"changed"}' }));
    return transport.url as string;
  });
  expect(url).toBe(`${origin.replace('https:', 'wss:')}/api/assistant/pages/aaaaaaaaaaaa/activity`);
  await expect(card.getByRole('status')).toHaveText(/New application activity/);
  expect(await page.evaluate(() => (window as any).prompts)).toEqual([]);
  await card.getByRole('button', { name: 'Check inbox in this chat' }).click();
  await expect(card.getByRole('status')).toHaveText('Inbox request sent to this chat.');
  const prompts = await page.evaluate(() => (window as any).prompts);
  expect(prompts).toHaveLength(1);
  expect(prompts[0].content[0].text).toContain('read_application_events');
  expect(prompts[0].content[0].text).not.toContain(grant.proof);
  await card.getByRole('button', { name: 'Check inbox in this chat' }).click();
  await expect(card.getByRole('status')).toHaveText(/did not confirm receipt/);
  expect(await page.evaluate(() => (window as any).prompts.length)).toBe(2);
});
