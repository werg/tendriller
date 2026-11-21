import { chromium } from '@playwright/test';
import { createServer } from 'node:net';
import { once } from 'node:events';

// A default Playwright context forces focus emulation on its own CDP session.
// Another session cannot undo it. Attach to an isolated default context with the
// documented noDefaults option instead; otherwise freeze/background tests can
// falsely run a continuously visible, unfrozen page.
export async function launchNetworkBrowser({ args = [], executablePath } = {}) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const owner = await chromium.launch({ headless: false, executablePath,
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    args: [...args, '--window-size=1440,1000', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`] });
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw Error('NETWORK_LAB_DEFAULT_CONTEXT_UNAVAILABLE');
    return { browser, context, async close() {
      try { await browser.close(); } finally { await owner.close(); }
    } };
  } catch (error) { await owner.close(); throw error; }
}
