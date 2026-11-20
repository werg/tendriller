import { test, expect, request, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { LOCAL_WORKER_HOST_RULES } from '../../scripts/e2e-network.mjs';
import { agent, claim, client, createPage, deletePage, localPageUrl, openClaimed, publish, publishFiles,
  requester, signInFixture, OWNER_TOKEN, OTHER_TOKEN, LOGOUT_TOKEN } from './local-helpers';

test('verified owner claims a page and executes its signed authored module', async ({ page, context }) => {
  const handle = await createPage();
  try {
    expect(handle.application.id).toMatch(/^[a-f0-9]{64}$/);
    expect(handle.token).toMatch(/^tk_/);
    await signInFixture(context); await claim(context, handle);
    const notified = page.waitForEvent('websocket', socket => socket.url().endsWith('/_tendril/publication-ready'))
      .then(socket => socket.waitForEvent('framereceived', frame => JSON.parse(String(frame.payload)).current === 1));
    const readinessRequests: string[] = [];
    page.on('request', request => {
      if (request.method() === 'HEAD' && request.url().endsWith('/_tendril/publication-ready')) readinessRequests.push(request.url());
    });
    await openClaimed(page, handle);
    await expect(page.getByRole('heading')).toHaveText(/is getting ready/);
    const release = await publishFiles(handle, {
      'index.html': { type: 'text/html', body: '<!doctype html><html><head><title>Signed page</title></head><body><h1 id="welcome"></h1><script type="module" src="./page.mjs"></script></body></html>' },
      'page.mjs': { type: 'text/javascript', body: 'document.querySelector("#welcome").textContent = "Hello, owner";' },
    });
    await notified;
    expect(readinessRequests).toHaveLength(0);
    await expect(page.locator('#welcome')).toHaveText('Hello, owner', { timeout: 25_000 });
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

test('Chromium reads authenticated per-page install metadata and launches the latest release', async () => {
  const handle = await createPage();
  const directory = await mkdtemp(join(tmpdir(), 'tendriller-install-'));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    // Use full Chrome's installability evaluator, not headless-shell's stub.
    // A dedicated persistent profile also avoids the intentional incognito error.
    context = await chromium.launchPersistentContext(directory, {
      channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: [`--host-resolver-rules=${LOCAL_WORKER_HOST_RULES}`],
    });
    const page = await context.newPage();
    await signInFixture(context); await claim(context, handle);
    await publish(handle, '<!doctype html><html><head><title>My mobile page</title></head><body><h1>First version</h1></body></html>');
    await openClaimed(page, handle);
    const base = localPageUrl(handle);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('crossorigin', 'use-credentials');
    const cdp = await context.newCDPSession(page);
    const result = await cdp.send('Page.getAppManifest');
    expect(result.errors).toEqual([]);
    const manifest = JSON.parse(result.data!);
    expect(manifest.id).toBe(new URL(base).pathname);
    expect(new URL(manifest.start_url, result.url).href).toBe(base);
    expect(manifest.scope).toBe(new URL(base).pathname);
    expect(manifest.display).toBe('standalone');
    // Real browser icon fetching/rendering catches auth, format and dimension errors
    // that inspecting manifest JSON alone cannot establish.
    expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
    expect((await cdp.send('Page.getManifestIcons')).primaryIcon).toBeTruthy();
    const icons: Record<string, { type: string; body: string | Uint8Array }> = {
      'index.html': { type: 'text/html', body: '<!doctype html><html><head><title>My mobile page</title></head><body><h1>Latest version</h1></body></html>' },
    };
    for (const format of ['png', 'webp']) {
      const type = `image/${format}`;
      const image = await page.evaluate(type => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 192;
        const draw = canvas.getContext('2d')!;
        draw.fillStyle = '#6a24b3';
        draw.fillRect(0, 0, 192, 192);
        return canvas.toDataURL(type);
      }, type);
      expect(image).toMatch(new RegExp(`^data:${type};base64,`));
      icons[`custom.${format}`] = { type, body: Buffer.from(image.split(',')[1], 'base64') };
    }
    await publishFiles(handle, icons);
    await page.goto(new URL(manifest.start_url, result.url).href);
    await expect(page.getByRole('heading', { name: 'Latest version', exact: true })).toBeVisible();

    // Each signed raster must pass Chromium's icon evaluator on its own.
    for (const format of ['png', 'webp']) {
      const customIcon = new URL(`custom.${format}`, page.url()).href;
      expect((await agent(handle, '', 'PATCH', { icon: customIcon })).status).toBe(200);
      await page.reload();
      const branded = await cdp.send('Page.getAppManifest');
      expect(JSON.parse(branded.data!).icons).toEqual([
        { src: customIcon, sizes: 'any', type: `image/${format}`, purpose: 'any' },
      ]);
      expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
      expect((await cdp.send('Page.getManifestIcons')).primaryIcon).toBeTruthy();
    }
    await cdp.detach();
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
    await deletePage(handle);
  }
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

test('browser forms request and approve guest access, report a page, and sign out', async ({ page, context, browser }) => {
  const handle = await createPage();
  const guest = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await signInFixture(context, LOGOUT_TOKEN);
    await openClaimed(page, handle);
    const invitation = await agent(handle, '/links', 'POST', { role: 'guest' });
    expect(invitation.status).toBe(201);
    await signInFixture(guest, OTHER_TOKEN);
    const visitor = await guest.newPage();
    await visitor.goto(localPageUrl({ ...handle, page_url: invitation.data.url }));
    await visitor.getByRole('button', { name: 'Request access' }).click();
    await expect(visitor.getByRole('heading', { name: 'Waiting for the owner' })).toBeVisible();
    await page.goto(new URL('_tendril/manage', localPageUrl(handle)).href);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Guest access approved.');
    await page.getByRole('link', { name: 'Report this page' }).click();
    await page.locator('textarea').fill('Synthetic browser form check');
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.locator('body')).toHaveText('Report received. Thank you.');
    await page.goto('https://service.localhost:8790/dashboard');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('https://service.localhost:8790/');
    expect((await context.cookies()).some(cookie => cookie.name === '__Host-tendriller')).toBe(false);
  } finally {
    await guest.close();
    await deletePage(handle);
  }
});

test('two browsers can open the same unclaimed page as its intended owner', async ({ context, browser }) => {
  const handle = await createPage();
  const second = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await Promise.all([signInFixture(context), signInFixture(second)]);
    const claims = await Promise.all([claim(context, handle), claim(second, handle)]);
    expect(claims.map(response => response.status())).toEqual([303, 303]);
    for (const device of [context, second]) {
      const response = await device.request.get(localPageUrl(handle), { maxRedirects: 0 });
      expect(response.status()).toBe(200);
    }
  } finally {
    await second.close();
    await deletePage(handle);
  }
});


test('broken unpaired publication gets an explicit update and retains browser pairing intent and local draft', async ({ page, context }) => {
  const handle = await createPage();
  try {
    await signInFixture(context); await claim(context, handle);
    // Exercise the maintained public profile, pairing-intent and draft consumers.
    // The broken Worker models a released app that cannot enroll this browser.
    const fixture = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'publication-notice-fixture.mjs', contents: `
      import { browserProfileId } from './docs/tutorial/helpers/browser-profile.mjs';
      import { createBrowserPairing } from './docs/tutorial/pairing-browser.mjs';
      import { createViewStore } from './collaboration/local.mjs';
      const configuration={applicationId:window.__TENDRIL__.application.id,page_url:window.tendril.identity.base};
      const profileId=browserProfileId(configuration.applicationId), viewKey=profileId+':view';
      const viewId=sessionStorage.getItem(viewKey)||crypto.randomUUID();sessionStorage.setItem(viewKey,viewId);
      const store=createViewStore({storage:localStorage,applicationId:configuration.applicationId,profileId,viewId});
      const pairing=createBrowserPairing({configuration,profileId,workerUrl:new URL('./pairing-worker.mjs',location.href),
        createWorker(){throw Error('BROKEN_V1_WORKER');}});
      const input=document.querySelector('textarea');input.value=store.readDraft('draft')||'';
      input.addEventListener('input',()=>store.writeDraft(input.value,'draft'));
      document.querySelector('button').onclick=async()=>{try{await pairing.request();}catch{document.querySelector('#pairing').textContent='Worker unavailable; original request retained';}};
      window.fixture={snapshot:()=>({profileId,viewId,request:pairing.read(),draft:store.readDraft('draft')})};
    ` }, alias: { '@tendriller/core/pairing': join(process.cwd(), 'dist/sdk/pairing.mjs') }, bundle: true,
      format: 'esm', platform: 'browser', write: false });
    const assets = (version: string) => ({
      'index.html': { type: 'text/html', body: '<!doctype html><title>Unpaired publication</title><h1>'+version+'</h1><label>Local draft<textarea></textarea></label><button>Connect this device</button><p id="pairing">Not paired</p><script type="module" src="./page.mjs"></script>' },
      'page.mjs': { type: 'text/javascript', body: fixture.outputFiles[0].text },
    });
    const first=await publishFiles(handle,assets('Broken unpaired v1'));
    const requests: string[]=[];let sentFrames=0;
    page.on('request',request=>{if(request.url().includes('/_tendril/'))requests.push(request.method()+' '+new URL(request.url()).pathname);});
    page.on('websocket',socket=>{if(socket.url().endsWith('/_tendril/publication-ready'))socket.on('framesent',()=>sentFrames++);});
    const initial=page.waitForEvent('websocket',socket=>socket.url().endsWith('/_tendril/publication-ready'))
      .then(socket=>socket.waitForEvent('framereceived',frame=>JSON.parse(String(frame.payload)).current===first.version));
    await openClaimed(page,handle);await initial;
    await expect(page.getByRole('heading',{name:'Broken unpaired v1'})).toBeVisible();
    await page.getByRole('textbox',{name:'Local draft'}).fill('Retain this unresolved local draft');
    await page.getByRole('button',{name:'Connect this device'}).click();
    await expect(page.locator('#pairing')).toHaveText('Worker unavailable; original request retained');
    const before=await page.evaluate(()=>(window as any).fixture.snapshot());
    expect(before.request.requestId).toBeTruthy();expect(before.request.pairingId).toBeUndefined();
    expect(await page.evaluate(()=>(window as any).tendril.application.available)).toBe(false);
    const pinned=page.url();const quietBaseline=requests.length;
    await publishFiles(handle,assets('Repaired unpaired v2'));
    const notice=page.getByRole('status',{name:'Publication update'});
    await expect(notice).toBeVisible();await expect(notice).toContainText('New version published');
    await expect(page.getByRole('textbox')).toHaveValue(before.draft);expect(page.url()).toBe(pinned);
    expect(await page.evaluate(()=>(window as any).fixture.snapshot())).toEqual(before);
    expect(requests.slice(quietBaseline)).toEqual([]);expect(sentFrames).toBe(0);
    const update=page.getByRole('link',{name:'Open update',exact:true});
    await expect(update).toHaveAttribute('href',localPageUrl(handle));
    await update.click();await expect(page.getByRole('heading',{name:'Repaired unpaired v2'})).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveValue(before.draft);
    expect(await page.evaluate(()=>(window as any).fixture.snapshot())).toEqual(before);
    await expect(page.getByRole('status',{name:'Publication update'})).toBeHidden();
    expect(requests.some(value=>value.includes('/peers/pairing'))).toBe(false);
  } finally { await deletePage(handle); }
});
