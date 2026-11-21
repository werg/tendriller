import { readReviewAccess, authorizeReview } from '../review/access.mjs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { publicationAddress } from './observer-data.mjs';

// Also bounds injected callbacks that do not themselves honor AbortSignal. Late
// results/rejections are consumed, and can never install a credential after close.
function abortable(task, signal) {
  return new Promise((resolve, reject) => {
    const clear = () => signal.removeEventListener('abort', abort);
    const abort = () => { clear(); reject(signal.reason ?? Error('Cancelled')); };
    Promise.resolve(task).then(value => { clear(); resolve(value); }, error => { clear(); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

export function ownerUrl(origin, value, publishedPageUrl) {
  const url = new URL(value);
  let ownPage = false;
  if (publishedPageUrl) {
    try { publicationAddress(value, publishedPageUrl); ownPage = true; } catch {}
    if (value === publishedPageUrl + '_tendril/manage') ownPage = true;
  }
  if (url.origin !== origin && !ownPage || url.username || url.password || url.hash) throw Error('Owner navigation must use the exact service origin without credentials or fragments, or the observer-validated published page');
  return url.href;
}

/** Headless owner acts only on explicit, exact owner instructions, never model-generated scripts. */
export class Owner {
  constructor({ context, access, record = () => {}, authorize = authorizeReview }) { Object.assign(this, { context, access, record, authorize }); this.actions = []; this.pages = []; }
  async login() {
    this.page = await this.context.newPage();
    await this.page.goto(this.access.loginUrl);
    await this.page.locator('input[name="token"]').fill(this.access.code);
    await this.page.getByRole('button', { name: 'Open test account', exact: true }).click();
    await this.page.waitForURL(this.access.origin + '/dashboard');
    this.record({ action: 'login', at: new Date().toISOString() });
  }
  async act(input, { publishedPageUrl } = {}) {
    const page = this.page;
    if (!page) throw Error('Owner browser unavailable; use an external host adapter');
    const { action } = input;
    if (action === 'navigate') await page.goto(ownerUrl(this.access.origin, input.url, publishedPageUrl));
    else if (action === 'open-details') {
      const summary = page.locator('summary').filter({ hasText: input.name });
      if (await summary.count() !== 1 || (await summary.innerText()).trim() !== input.name) throw Error('Select one exact visible details summary');
      if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
    }
    else if (action === 'open-link') {
      const href = await page.getByRole('link', { name: input.name, exact: true }).getAttribute('href');
      if (!href) throw Error('The selected link has no URL');
      const url = ownerUrl(this.access.origin, new URL(href, page.url()).href, publishedPageUrl);
      const next = await this.context.newPage();
      try { await next.goto(url); } catch (error) { await next.close(); throw error; }
      this.pages.push(page); this.page = next;
    } else if (action === 'return-page') {
      if (!this.pages.length) throw Error('No retained app page');
      this.page = this.pages.pop(); await page.close();
    } else if (action === 'wait') {
      const timeout = input.timeoutMs ?? 15000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000 || !['visible', 'enabled', 'text'].includes(input.condition)) throw Error('Use a bounded visible, enabled or text condition');
      await page.waitForFunction(({ selector, condition, value }) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        return condition === 'enabled' ? !element.disabled : condition === 'text' ? element.textContent.includes(value) : Boolean(element.getClientRects().length);
      }, { selector: input.selector, condition: input.condition, value: input.value ?? '' }, { timeout });
    }
    else if (action === 'reload') await page.reload();
    else if (action === 'reopen') {
      const url = ownerUrl(this.access.origin, page.url(), publishedPageUrl);
      await page.close(); this.page = await this.context.newPage(); await this.page.goto(url);
    } else if (action === 'review') {
      // The evaluator must compare the exact visible fingerprint, rights and prefix
      // before requesting this action. No "check every checkbox" shortcut.
      if (!input.expected || !['fingerprint', 'rights', 'retainedPrefix'].every(key => typeof input.expected[key] === 'string' && input.expected[key].trim()) ||
        !Array.isArray(input.permissions) || typeof input.button !== 'string')
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
    if (action === 'inspect') result.view = await this.page.evaluate(() => ({
      fields: Object.fromEntries([...document.querySelectorAll('dt')].map(node => [node.textContent.trim(), node.nextElementSibling?.textContent.trim()])),
      links: [...document.querySelectorAll('a[href]')].map(node => ({ name: node.textContent.trim(), href: node.href })),
      inputs: [...document.querySelectorAll('input:not([type="hidden"]):not([type="password"]),textarea')].filter(node => node.name !== 'token').map(node => ({
        id: node.id, name: node.name, label: [...node.labels ?? []].map(label => label.textContent.trim()).join(' '), value: node.value, disabled: node.disabled,
      })),
      proposals: [...document.querySelectorAll('pre')].map(node => node.textContent),
    }));
    this.actions.push({ action, url: result.url, at: result.at });
    this.record({ input, ...result }); return result;
  }
  async freshToken({ signal = AbortSignal.timeout(45000) } = {}) {
    signal.throwIfAborted();
    let page, closing;
    const close = () => closing ??= page ? abortable(Promise.resolve().then(() => page.close()), AbortSignal.timeout(3000)).catch(() => {}) : Promise.resolve();
    const abort = () => { if (page) void close(); };
    signal.addEventListener('abort', abort, { once: true });
    // Capture only this OAuth page, so cancellation never closes the owner's app
    // or an unrelated page. Every HTTP exchange also has its own finite deadline.
    const context = {
      newPage: async () => {
        signal.throwIfAborted(); page = await this.context.newPage();
        if (signal.aborted) { await close(); signal.throwIfAborted(); }
        return page;
      },
      request: Object.fromEntries(['get', 'post'].map(method => [method, (url, options) => {
        signal.throwIfAborted(); return this.context.request[method](url, { ...options, timeout: 15000 });
      }])),
    };
    try {
      const result = await abortable(this.authorize(context, this.access), signal);
      signal.throwIfAborted(); return result.token;
    } finally {
      signal.removeEventListener('abort', abort); if (page) await close();
    }
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
export async function mcpBridge({ origin, token: initialToken, freshToken, fetch: fetcher = globalThis.fetch,
  requestTimeoutMs = 60000, renewalTimeoutMs = 30000 }) {
  let token = initialToken, generation = 0, renewal, closing;
  const lifetime = new AbortController();
  const install = value => {
    lifetime.signal.throwIfAborted();
    if (typeof value !== 'string' || !value) throw Error('OAuth credential unavailable');
    token = value; generation++;
  };
  const renew = async (rejectedGeneration, signal) => {
    if (generation !== rejectedGeneration) return; // A delayed 401 used an older credential.
    if (!renewal) {
      const controller = new AbortController(), flight = { controller, waiters: 0 };
      const renewalSignal = AbortSignal.any([lifetime.signal, controller.signal, AbortSignal.timeout(renewalTimeoutMs)]);
      flight.promise = abortable(Promise.resolve().then(() => {
        renewalSignal.throwIfAborted(); return freshToken({ signal: renewalSignal });
      }), renewalSignal).then(value => {
        renewalSignal.throwIfAborted();
        if (generation === rejectedGeneration) install(value);
      }).finally(() => { if (renewal === flight) renewal = undefined; });
      renewal = flight;
    }
    const flight = renewal; flight.waiters++;
    try { await abortable(flight.promise, signal); }
    finally {
      flight.waiters--;
      if (!flight.waiters) flight.controller.abort();
    }
  };
  const path = '/' + randomBytes(24).toString('hex');
  const server = createServer(async (req, res) => {
    if (req.url !== path || !['GET', 'POST', 'DELETE'].includes(req.method)) { res.writeHead(404).end(); return; }
    const cancelled = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, cancelled.signal, AbortSignal.timeout(requestTimeoutMs)]);
    const disconnect = () => { if (!res.writableFinished) cancelled.abort(); };
    req.once('aborted', disconnect); res.once('close', disconnect);
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw Error('MCP request too large'); chunks.push(chunk); }
      const headers = {};
      for (const key of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (req.headers[key]) headers[key] = req.headers[key];
      const body = req.method === 'POST' ? Buffer.concat(chunks) : undefined;
      const dispatch = () => {
        signal.throwIfAborted();
        return abortable(fetcher(origin + '/mcp', { method: req.method,
          headers: { ...headers, authorization: 'Bearer ' + token }, redirect: 'error',
          ...(body === undefined ? {} : { body }), signal }), signal);
      };
      const sentGeneration = generation;
      let response = await dispatch();
      // This service authenticates before MCP dispatch: only an HTTP 401 permits
      // one exact replay. A tool error, 403, or second 401 is never retried.
      if (response.status === 401 && freshToken) {
        void response.body?.cancel().catch(() => {});
        await renew(sentGeneration, signal);
        response = await dispatch();
      }
      res.writeHead(response.status, Object.fromEntries(['content-type', 'mcp-session-id', 'www-authenticate']
        .filter(k => response.headers.has(k)).map(k => [k, response.headers.get(k)])));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res, { signal }); else res.end();
    } catch {
      if (!res.destroyed) { if (!res.headersSent) res.writeHead(502); res.end(); }
    } finally { req.removeListener('aborted', disconnect); res.removeListener('close', disconnect); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}${path}`, refresh: install,
    close: () => closing ??= (async () => {
      lifetime.abort();
      const pending = renewal?.promise;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      if (pending) await pending.catch(() => {});
    })() };
}
