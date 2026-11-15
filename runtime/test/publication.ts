import type { Page } from '@playwright/test';

// A saved graph is ready only after the service worker commits its metadata.
// Use the publication operation's acknowledgement, without inspecting caches.
export async function savedForOffline(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', null, { timeout: 20000 });
  return page.evaluate(() => new Promise<string>((resolve, reject) => {
    const publication = (window as any).__TENDRIL__?.publication;
    if (!publication) { reject(new Error('The page has no publication manifest.')); return; }
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      channel.port1.close();
      if (data?.t !== 'publication' || data.id !== publication.id) reject(new Error('Publication acknowledgement identity mismatch.'));
      else if (data.status === 'ready') resolve(data.id);
      else reject(new Error(data.error?.message || 'The publication could not be saved for offline use.'));
    };
    channel.port1.onmessageerror = () => { channel.port1.close(); reject(new Error('Publication acknowledgement could not be decoded.')); };
    navigator.serviceWorker.controller!.postMessage({ t: 'publication', publication }, [channel.port2]);
  }));
}
