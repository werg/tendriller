import { test, expect, request } from '@playwright/test';
import { agent, claim, client, createPage, deletePage, localPageUrl, openClaimed, publish, publishFiles,
  requester, signInFixture, OWNER_TOKEN, OTHER_TOKEN } from './local-helpers';

test('verified owner claims a page and executes its signed authored module', async ({ page, context }) => {
  const handle = await createPage();
  try {
    expect(handle.application.id).toMatch(/^[a-f0-9]{64}$/);
    expect(handle.token).toMatch(/^tk_/);
    await signInFixture(context); await claim(context, handle);
    const release = await publishFiles(handle, {
      'index.html': { type: 'text/html', body: '<!doctype html><html><head><title>Signed page</title></head><body><h1 id="welcome"></h1><script type="module" src="./page.mjs"></script></body></html>' },
      'page.mjs': { type: 'text/javascript', body: 'document.querySelector("#welcome").textContent = "Hello, owner";' },
    });
    await openClaimed(page, handle);
    await expect(page.locator('#welcome')).toHaveText('Hello, owner');
    expect(await page.evaluate(() => (window as any).tendril.identity.page)).toBe(handle.id);
    expect(await page.evaluate(() => (window as any).__TENDRIL__.application)).toEqual(handle.application);
    expect((await client(handle).peers.publication())?.publication.id).toBe(release.publication.id);
    expect(page.url()).toContain(`/_publications/${release.version}/`);
    expect(page.url()).not.toContain('/auth/page');
  } finally { await deletePage(handle); }
});

test('a different verified account cannot claim the owner invitation', async ({ context }) => {
  const handle = await createPage();
  try {
    await signInFixture(context, OTHER_TOKEN);
    expect((await claim(context, handle)).status()).toBe(403);
  } finally { await deletePage(handle); }
});

test('each signed release serves one immutable graph and canonical navigation selects the next', async ({ page, context }) => {
  const handle = await createPage();
  try {
    await signInFixture(context); await claim(context, handle);
    const first = await publish(handle, '<h1 id="release">one</h1>');
    await openClaimed(page, handle); const originalUrl = page.url();
    await expect(page.locator('#release')).toHaveText('one');
    const second = await publish(handle, '<h1 id="release">two</h1>');
    expect(second.version).toBe(first.version + 1);
    await expect(page.locator('#release')).toHaveText('one');
    await page.goto(localPageUrl(handle));
    await expect(page.locator('#release')).toHaveText('two');
    await page.goto(originalUrl);
    await expect(page.locator('#release')).toHaveText('one');
    expect((await client(handle).peers.publication(first.publication.id))?.publication).toEqual(first.publication);
  } finally { await deletePage(handle); }
});

test('sibling page origins isolate storage and cannot mutate each other through participant transport', async ({ context }) => {
  const a = await createPage(), b = await createPage();
  try {
    await signInFixture(context); await claim(context, a); await claim(context, b);
    await publish(a, '<h1>Origin A</h1>'); await publish(b, '<h1>Origin B</h1>');
    const pa = await context.newPage(), pb = await context.newPage();
    await openClaimed(pa, a); await openClaimed(pb, b);
    expect(new URL(pa.url()).origin).not.toBe(new URL(pb.url()).origin);
    await pa.evaluate(() => localStorage.setItem('origin-proof', 'a'));
    expect(await pb.evaluate(() => localStorage.getItem('origin-proof'))).toBeNull();
    const endpoint = `${localPageUrl(b)}_tendril/peers/participant`;
    const blocked = pa.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
    await pa.evaluate(async ({ endpoint, applicationId }) => {
      await fetch(endpoint, { method: 'POST', mode: 'no-cors', credentials: 'include', body: JSON.stringify({
        protocol: 'chronolog-participant-v1', applicationId, requestId: 'cross-origin', facet: 'publication', action: 'read', payload: {},
      }) }).catch(() => {});
    }, { endpoint, applicationId: b.application.id });
    expect((await blocked).status()).toBe(403);
  } finally { await Promise.all([deletePage(a), deletePage(b)]); }
});

test('host transport requires a token and rejects ordinary data facets', async () => {
  const handle = await createPage();
  try {
    const request = { protocol: 'chronolog-participant-v1', applicationId: handle.application.id,
      requestId: 'filtered', facet: 'database', action: 'submit', payload: {} };
    const denied = await (await requester()).post(`${handle.api}/peers/participant`, { data: request });
    expect(denied.status()).toBe(401);
    for (const [facet, action] of [['database', 'submit'], ['content', 'chunk'], ['ephemeral', 'signal']]) {
      const result = await agent(handle, '/peers/participant', 'POST', { ...request, facet, action });
      expect(result.status).toBe(403);
      expect(result.data.error.code).toBe('peer_participant_facet_forbidden');
    }
  } finally { await deletePage(handle); }
});


test('signed publication HTTP delivery preserves authored bytes and exact retry identity', async () => {
  const handle = await createPage();
  const authenticated = await request.newContext({ ignoreHTTPSErrors: true, storageState: { origins: [], cookies: [{
    name: '__Host-tendriller', value: OWNER_TOKEN, domain: 'service.localhost', path: '/', secure: true,
    httpOnly: true, sameSite: 'Lax', expires: -1,
  }] } });
  try {
    await claim({ request: authenticated }, handle);
    const files = { 'index.html': { type: 'text/html', body: '<!doctype html><title>Exact code</title><script type="module" src="./page.mjs"></script>' },
      'page.mjs': { type: 'text/javascript', body: 'export const release = "signed actual host";' } };
    const selected = await publishFiles(handle, files);
    const code = await authenticated.get(`${localPageUrl(handle)}page.mjs`);
    expect(code.status()).toBe(200); expect(await code.text()).toBe(files['page.mjs'].body);
    const assets = selected.publication.payload.files.map(file => ({ hash: file.hash,
      bytes: Buffer.from(files[file.path as keyof typeof files].body).toString('base64') }));
    expect(await client(handle).peers.publish(selected.publication, assets)).toEqual(selected);
    expect(await client(handle).peers.publication()).toEqual(selected);
  } finally { await authenticated.dispose(); await deletePage(handle); }
});
