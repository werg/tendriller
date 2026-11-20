import { readReviewAccess, authorizeReview } from '../review/access.mjs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';

export function ownerUrl(origin, value) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.hash) throw Error('Owner navigation must use the exact service origin without credentials or fragments');
  return url.href;
}

/** Headless owner acts only on explicit, exact owner instructions, never model-generated scripts. */
export class Owner {
  constructor({ context, access, record = () => {} }) { Object.assign(this, { context, access, record }); }
  async login() {
    this.page = await this.context.newPage();
    await this.page.goto(this.access.loginUrl);
    await this.page.locator('input[name="token"]').fill(this.access.code);
    await this.page.getByRole('button', { name: 'Open test account', exact: true }).click();
    await this.page.waitForURL(this.access.origin + '/dashboard');
    this.record({ action: 'login', at: new Date().toISOString() });
  }
  async act(input) {
    const page = this.page;
    if (!page) throw Error('Owner browser unavailable; use an external host adapter');
    const { action } = input;
    if (action === 'navigate') await page.goto(ownerUrl(this.access.origin, input.url));
    else if (action === 'reload') await page.reload();
    else if (action === 'reopen') {
      const url = ownerUrl(this.access.origin, page.url());
      await page.close(); this.page = await this.context.newPage(); await this.page.goto(url);
    } else if (action === 'review') {
      // The evaluator must compare the exact visible fingerprint, rights and prefix
      // before requesting this action. No "check every checkbox" shortcut.
      if (!input.expected || !['fingerprint', 'rights', 'retainedPrefix'].every(key => typeof input.expected[key] === 'string' && input.expected[key].trim()) ||
        !Array.isArray(input.permissions) || !input.permissions.length || typeof input.button !== 'string')
        throw Error('Review needs exact visible fingerprint, rights, retained prefix and selected permission labels');
      for (const text of Object.values(input.expected)) await page.getByText(text, { exact: true }).waitFor();
      for (const label of input.permissions) await page.getByRole('checkbox', { name: label, exact: true }).check();
      await page.getByRole('button', { name: input.button, exact: true }).click();
    } else if (action === 'fill') {
      if (typeof input.label !== 'string' || typeof input.value !== 'string') throw Error('Fill requires label and value');
      await page.getByLabel(input.label, { exact: true }).fill(input.value);
    } else if (action === 'click') await page.getByRole(input.role ?? 'button', { name: input.name, exact: true }).click();
    else if (action !== 'inspect') throw Error('Unsupported owner action');
    const result = { action, url: this.page.url(), text: await this.page.locator('body').innerText(), at: new Date().toISOString() };
    this.record({ input, ...result }); return result;
  }
  async freshToken() {
    const { token, page } = await authorizeReview(this.context, this.access);
    await page.close(); return token;
  }
}

export async function createOwner({ accessPath, chromium, record, executablePath }) {
  const access = readReviewAccess(accessPath);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(20000);
    const owner = new Owner({ context, access, record });
    await owner.login(); return { owner, close: () => browser.close(), version: browser.version() };
  } catch (error) { await browser.close(); throw error; }
}

/** Transport-only proxy: genuine selected-origin catalog/results, no invented tools.
 * Bearer credentials stay in this process, outside the model's shell environment.
 */
export async function mcpBridge({ origin, token: initialToken, fetch: fetcher = globalThis.fetch }) {
  let token = initialToken;
  const path = '/' + randomBytes(24).toString('hex');
  const server = createServer(async (req, res) => {
    if (req.url !== path || !['GET', 'POST', 'DELETE'].includes(req.method)) { res.writeHead(404).end(); return; }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw Error('MCP request too large'); chunks.push(chunk); }
      const headers = { authorization: 'Bearer ' + token };
      for (const key of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (req.headers[key]) headers[key] = req.headers[key];
      const response = await fetcher(origin + '/mcp', { method: req.method, headers, redirect: 'error',
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(60000) });
      res.writeHead(response.status, Object.fromEntries(['content-type', 'mcp-session-id'].filter(k => response.headers.has(k)).map(k => [k, response.headers.get(k)])));
      if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}${path}`, refresh: value => { token = value; },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
