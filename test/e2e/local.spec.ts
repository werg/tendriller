import { test, expect, request, chromium } from '@playwright/test';
import { join } from 'node:path';
import { build } from 'esbuild';
import { encodeRecord, signRecord } from '@chronolog/authority';
import { authorityRecord } from '../../dist/sdk/authority.mjs';
import { LOCAL_WORKER_HOST_RULES } from '../../scripts/e2e-network.mjs';
import { shortScratch } from './short-scratch';
import { agent, claim, client, createPage, deletePage, localPageUrl, openClaimed, publish, publishFiles,
  requester, selectedPublication, signInFixture, SERVICE, OWNER, OWNER_TOKEN, OTHER_TOKEN, LOGOUT_TOKEN } from './local-helpers';

test('verified owner claims a page and executes its signed authored module', async ({ page, context }) => {
  const handle = await createPage();
  try {
    expect(handle.application.id).toMatch(/^[a-f0-9]{64}$/);
    expect(handle.token).toMatch(/^ta_/);
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
    expect((await selectedPublication(handle))?.opId).toBe(release.opId);
    expect(page.url(), 'The address stays canonical, so a reload opens the latest release.').not.toContain('/_publications/');
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

test('the page shows the latest release: open tabs switch when idle, wait for unsaved input, and only an explicit release URL pins', async ({ page, context }) => {
  const handle = await createPage();
  try {
    await signInFixture(context); await claim(context, handle);
    const first = await publish(handle, '<h1 id="release">one</h1><input id="draft">');
    await openClaimed(page, handle);
    await expect(page.locator('#release')).toHaveText('one');
    const second = await publish(handle, '<h1 id="release">two</h1><input id="draft">');
    expect(second.version).toBe(first.version + 1);
    // An idle open tab switches by itself.
    await expect(page.locator('#release')).toHaveText('two', { timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).tendril.publication.pinned)).toBe(false);
    // Unsaved input defers the switch until it is no longer being edited.
    await page.locator('#draft').fill('unsaved');
    const third = await publish(handle, '<h1 id="release">three</h1><input id="draft">');
    await expect.poll(() => page.evaluate(() => (window as any).tendril.publication.updateAvailable), { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(1500);
    await expect(page.locator('#release')).toHaveText('two');
    await page.locator('#draft').fill('');
    await page.locator('#draft').blur();
    await expect(page.locator('#release')).toHaveText('three', { timeout: 15_000 });
    // A reload and a new tab open the latest release.
    await page.reload(); await expect(page.locator('#release')).toHaveText('three');
    const other = await context.newPage(); await other.goto(page.url());
    await expect(other.locator('#release')).toHaveText('three'); await other.close();
    // A phone tab frozen in the background while a release is published switches on resume.
    await page.setViewportSize({ width: 390, height: 844 });
    const lifecycle = await context.newCDPSession(page);
    await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });
    await publish(handle, '<h1 id="release">resumed</h1><input id="draft">');
    await new Promise(resolve => setTimeout(resolve, 3000));
    await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
    await expect(page.locator('#release')).toHaveText('resumed', { timeout: 20_000 });
    // Pinning is explicit: the immutable release URL stays on that retained release even as a newer one publishes.
    await page.goto(new URL(`_publications/${third.version}/`, localPageUrl(handle)).href);
    await expect(page.locator('#release')).toHaveText('three');
    expect(await page.evaluate(() => (window as any).tendril.publication.pinned)).toBe(true);
    await publish(handle, '<h1 id="release">four</h1><input id="draft">');
    await page.waitForTimeout(3000);
    await expect(page.locator('#release')).toHaveText('three');
    expect((await selectedPublication(handle, third.opId))?.opId).toEqual(third.opId);
  } finally { await deletePage(handle); }
});

test('publication switching preserves hidden form drafts, checkedness, selects and open-shadow input until reset', async ({ page, context }) => {
  const handle = await createPage();
  const form = '<meta name="tendriller-updates" content="careful"><form><input id="checked" type="checkbox" value="yes"><select id="selection"><option>A</option><option>B</option></select><textarea id="preview">original</textarea></form><div id="editor"></div>';
  try {
    await signInFixture(context); await claim(context, handle);
    await publish(handle, '<h1 id="release">draft release</h1>' + form);
    await openClaimed(page, handle);
    await page.locator('#checked').check(); await page.locator('#selection').selectOption({ label: 'B' });
    await page.locator('#preview').fill('unsaved preview');
    await page.evaluate(() => {
      (document.querySelector('#preview') as HTMLTextAreaElement).readOnly = true;
      const shadow = document.querySelector('#editor')!.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<textarea id="shadow">original</textarea>';
      (shadow.firstChild as HTMLTextAreaElement).value = 'unsaved shadow';
      (document.activeElement as HTMLElement)?.blur();
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await publish(handle, '<h1 id="release">next release</h1>' + form);
    await expect.poll(() => page.evaluate(() => (window as any).tendril.publication.updateAvailable)).toBe(true);
    await page.waitForTimeout(5200); // Include a periodic safe-point check while hidden.
    await expect(page.locator('#release')).toHaveText('draft release');
    await expect(page.locator('#checked')).toBeChecked(); await expect(page.locator('#selection')).toHaveValue('B');
    await expect(page.locator('#preview')).toHaveValue('unsaved preview'); await expect(page.locator('#shadow')).toHaveValue('unsaved shadow');
    await page.evaluate(() => {
      document.querySelector('form')!.reset();
      (document.querySelector('#editor')!.shadowRoot!.firstChild as HTMLTextAreaElement).value = 'original';
      document.dispatchEvent(new Event('change'));
    });
    await expect(page.locator('#release')).toHaveText('next release', { timeout: 15_000 });
  } finally { await deletePage(handle); }
});

test('nested live documents containing _publications stay live and pinned document updates preserve their path', async ({ page, context }) => {
  const handle = await createPage(), path = 'docs/_publications/help.html';
  const files = (label: string) => ({ 'index.html': { type: 'text/html', body: '<h1>Entry</h1>' },
    [path]: { type: 'text/html', body: '<h1 id="release">' + label + '</h1>' } });
  try {
    await signInFixture(context); await claim(context, handle);
    const first = await publishFiles(handle, files('nested one')); await openClaimed(page, handle);
    const live = new URL(path, localPageUrl(handle)).href; await page.goto(live);
    await expect(page.locator('#release')).toHaveText('nested one');
    expect(await page.evaluate(() => (window as any).tendril.publication.pinned)).toBe(false);
    await publishFiles(handle, files('nested two'));
    await expect(page.locator('#release')).toHaveText('nested two', { timeout: 15_000 }); expect(page.url()).toBe(live);
    const pinned = new URL('_publications/' + first.version + '/' + path, localPageUrl(handle)).href;
    await page.goto(pinned); await expect(page.locator('#release')).toHaveText('nested one');
    expect(await page.evaluate(() => (window as any).tendril.publication.pinned)).toBe(true);
    await publishFiles(handle, files('nested three'));
    await expect.poll(() => page.evaluate(() => (window as any).tendril.publication.updateAvailable)).toBe(true);
    await expect(page.getByRole('link', { name: 'Open update', exact: true })).toHaveAttribute('href', live);
    await page.getByRole('link', { name: 'Open update', exact: true }).click();
    await expect(page.locator('#release')).toHaveText('nested three'); expect(page.url()).toBe(live);
    await page.goto(pinned); await expect(page.locator('#release')).toHaveText('nested one');
    await page.evaluate(() => (window as any).tendril.publication.update());
    await expect(page.locator('#release')).toHaveText('nested three'); expect(page.url()).toBe(live);
  } finally { await deletePage(handle); }
});

test('Chromium reads authenticated per-page install metadata and launches the latest release', async () => {
  const handle = await createPage();
  const scratch = await shortScratch('tendriller-install-');
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    // Use full Chrome's installability evaluator, not headless-shell's stub.
    // A dedicated persistent profile also avoids the intentional incognito error. Chrome's singleton socket
    // path must stay short, so the profile and TMPDIR use a short alias of the real scratch directory.
    context = await chromium.launchPersistentContext(scratch.profile, {
      channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      env: { ...process.env, TMPDIR: scratch.tmp } as Record<string, string>,
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
    // that inspecting manifest JSON alone cannot establish. Poll briefly because the
    // background icon rasterizer can refresh the manifest href with `?icons=...`.
    await expect.poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
    await expect.poll(async () => Boolean((await cdp.send('Page.getManifestIcons')).primaryIcon)).toBe(true);

    const emoji = '🧑🏽‍🚀';
    expect((await agent(handle, '', 'PATCH', { icon: emoji })).status).toBe(200);
    await page.reload();
    const favicon = page.locator('link[rel="icon"]');
    const generatedIcon = `${new URL(base).pathname}_tendril/icon.svg`;
    const maskableIcon = { src: `${new URL(base).pathname}_tendril/icon-maskable.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' };
    await expect(favicon).toHaveAttribute('href', generatedIcon);
    await expect(favicon).toHaveAttribute('type', 'image/svg+xml');
    const rendered = await page.evaluate(async () => {
      const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
      const response = await fetch(icon.href, { cache: 'no-store' });
      const svg = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
      const image = new Image();
      image.src = icon.href;
      await image.decode();
      return { status: response.status, type: response.headers.get('Content-Type'),
        cache: response.headers.get('Cache-Control'), text: svg.querySelector('text')?.textContent,
        parseError: svg.querySelector('parsererror') !== null,
        width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(rendered).toMatchObject({ status: 200, type: 'image/svg+xml', cache: 'private, no-cache',
      text: emoji, parseError: false });
    expect(rendered.width).toBeGreaterThan(0);
    expect(rendered.height).toBe(rendered.width);
    // Android installs ignore SVG icons. The owner's page draws the emoji into
    // 512px PNGs once; the manifest then lists them first.
    await expect.poll(async () => {
      const current = await cdp.send('Page.getAppManifest');
      return current.errors.length === 0 ? JSON.parse(current.data!).icons.map((icon: { type: string; purpose: string; sizes: string }) => `${icon.type} ${icon.purpose} ${icon.sizes}`) : current.errors;
    }, { timeout: 15_000 }).toEqual(['image/png any 512x512', 'image/png maskable 512x512', 'image/svg+xml any any', 'image/svg+xml maskable any']);
    const emojiIcons = JSON.parse((await cdp.send('Page.getAppManifest')).data!).icons as { src: string }[];
    expect(emojiIcons.slice(2)).toEqual([{ src: generatedIcon, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, maskableIcon]);
    for (const icon of emojiIcons.slice(0, 2)) {
      const size = await page.evaluate(async url => {
        const response = await fetch(url, { cache: 'no-store' });
        const image = new Image(); image.src = URL.createObjectURL(await response.blob()); await image.decode();
        return { type: response.headers.get('Content-Type'), width: image.naturalWidth, height: image.naturalHeight };
      }, icon.src);
      expect(size).toEqual({ type: 'image/png', width: 512, height: 512 });
    }
    // iOS reads apple-touch-icon, not the manifest: the opaque drawn PNG.
    await page.reload();
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', emojiIcons[1]!.src);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('sizes', '512x512');
    const maskableSize = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, maskableIcon.src);
    expect(maskableSize.width).toBeGreaterThan(0);
    expect(maskableSize.height).toBe(maskableSize.width);
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
      await expect(favicon).toHaveAttribute('href', customIcon);
      await expect(favicon).toHaveAttribute('type', `image/${format}`);
      const branded = await cdp.send('Page.getAppManifest');
      // The published icon's real size, so Android uses it instead of drawing a letter.
      expect(JSON.parse(branded.data!).icons).toEqual([
        { src: customIcon, sizes: '192x192', type: `image/${format}`, purpose: 'any' },
      ]);
      expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
      expect((await cdp.send('Page.getManifestIcons')).primaryIcon).toBeTruthy();
      // iOS can use PNG; non-PNG custom favicons omit the generic Tendriller apple-touch-icon
      // so mobile browsers don't rank the generic brand PNG ahead of the page's own icon.
      if (format === 'png') {
        await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', customIcon);
      } else {
        await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(0);
      }
    }
    expect((await agent(handle, '', 'PATCH', { icon: null })).status).toBe(200);
    await page.reload();
    await expect(favicon).toHaveAttribute('href', generatedIcon);
    await expect(favicon).toHaveAttribute('type', 'image/svg+xml');
    await cdp.detach();
  } finally {
    await context?.close();
    await scratch.close();
    await deletePage(handle);
  }
});

test('sibling page origins of one agent isolate storage and cannot mutate each other through participant transport', async ({ context }) => {
  // One agent, one credential and one shared signing key, granted automatically to both pages it creates.
  const a = await createPage(), b = await createPage(OWNER, a);
  expect(b.agent.id).toBe(a.agent.id); expect(b.signer).toBe(a.signer);
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
  } finally { await deletePage(b, { revokeAgent: false }); await deletePage(a); }
});

test('host transport requires a token and rejects ordinary data actions in genuine signed participant requests', async () => {
  const handle = await createPage();
  try {
    // The current wire body is one canonical signed record (hex), signed by the agent's shared key.
    // Only control.sync is accepted by the blind host participant endpoint.
    const signed = async (action: string) => authorityRecord(encodeRecord(await signRecord(
      'chronolog/participant-sync/v2',
      { applicationId: handle.application.id, requestId: `filtered-${action}`, action },
      handle.signer,
    )));
    const denied = await (await requester()).post(`${handle.api}/peers/participant`, { data: await signed('control.sync') });
    expect(denied.status()).toBe(401);
    for (const action of ['database.submit', 'content.chunk', 'ephemeral.signal']) {
      const result = await agent(handle, '/peers/participant', 'POST', await signed(action));
      expect(result.status, action).toBe(400);
      expect(result.data.error.code, action).toBe('participant_fields_invalid');
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
    expect(selected.opId).toMatch(/^[a-f0-9]{64}$/);
    expect(await client(handle).peers.publication()).toEqual(selected);
    expect(await client(handle).peers.publication(selected.opId)).toEqual(selected);
  } finally { await authenticated.dispose(); await deletePage(handle); }
});

test('browser forms join guest invites directly, report a page, and sign out', async ({ page, context, browser }) => {
  const handle = await createPage();
  const guest = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await signInFixture(context, LOGOUT_TOKEN);
    await openClaimed(page, handle);
    const invitation = await agent(handle, '/links', 'POST', { role: 'guest' });
    expect(invitation.status).toBe(201);
    await signInFixture(guest, OTHER_TOKEN);
    const visitor = await guest.newPage();
    await claim(guest, { ...handle, page_url: invitation.data.url });
    await visitor.goto(localPageUrl({ ...handle, page_url: invitation.data.url }));
    await expect(visitor.getByRole('heading')).toHaveText(/is getting ready/);
    await page.goto(new URL('_tendril/manage', localPageUrl(handle)).href);
    await page.getByRole('link', { name: 'Report this page' }).click();
    await page.locator('textarea').fill('Synthetic browser form check');
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.locator('body')).toHaveText('Report received. Thank you.');
    await page.goto(`${SERVICE}/dashboard`);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(`${SERVICE}/`);
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


test('a publication whose app cannot initialize this browser\'s page data gets an explicit update and retains its original genesis and local draft', async ({ page, context }) => {
  const handle = await createPage();
  try {
    await signInFixture(context); await claim(context, handle);
    // Exercise the maintained public browser bootstrap, profile and draft consumers. The first browser creates
    // the page genesis, but its initialize request is lost (aborted before it leaves the browser), so the
    // released app cannot finish creating the page data.
    const fixture = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'publication-notice-fixture.mjs', contents: `
      import { browserProfileId } from './docs/tutorial/shared/helpers/browser-profile.mjs';
      import { bootstrapBrowser } from './docs/tutorial/shared/helpers/browser-bootstrap.mjs';
      import { createViewStore } from '@chronolog/peer-session/browser';
      import { createSigningIdentity, exportSigningIdentity, importSigningIdentity, decodeRecord } from '@chronolog/authority';
      import { decodeLogGenesis } from '@chronolog/peer-session';
      const configuration={applicationId:window.__TENDRIL__.application.id,page_url:window.tendril.identity.base};
      const profileId=browserProfileId(configuration.applicationId), viewKey=profileId+':view', identityKey=profileId+':identity', storeKey=profileId+':store:';
      const viewId=sessionStorage.getItem(viewKey)||crypto.randomUUID();sessionStorage.setItem(viewKey,viewId);
      const view=createViewStore({storage:localStorage,applicationId:configuration.applicationId,profileId,viewId});
      // One retained device: a resumed document reuses its identity and stored bootstrap record, never a new key.
      const saved=localStorage.getItem(identityKey);
      const identity=saved?await importSigningIdentity(JSON.parse(saved)):await createSigningIdentity();
      if(!saved)localStorage.setItem(identityKey,JSON.stringify(await exportSigningIdentity(identity)));
      const store={
        async get(key){const value=localStorage.getItem(storeKey+key);return value===null?null:Uint8Array.from(atob(value),c=>c.charCodeAt(0));},
        async put(key,bytes){let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000));localStorage.setItem(storeKey+key,btoa(s));},
      };
      const input=document.querySelector('textarea');input.value=view.readDraft('draft')||'';
      input.addEventListener('input',()=>view.writeDraft(input.value,'draft'));
      document.querySelector('button').onclick=async()=>{
        try{
          await bootstrapBrowser({configuration,device:{identity,store},imports:{},topics:{},signal:AbortSignal.timeout(20_000)});
        }
        catch{document.querySelector('#enrollment').textContent='Initialization unavailable; original genesis retained';}
      };
      window.fixture={async snapshot(){
        const raw=await store.get('tendriller/admission/genesis/'+configuration.applicationId),intent=raw&&decodeRecord(raw);
        const genesis=intent&&decodeLogGenesis(intent.genesisBytes);
        const rootMember=genesis?.initialTopics?.$permissions?.members?.[0]?.publicKey;
        return {profileId,viewId,device:identity.publicKey,draft:view.readDraft('draft'),
          bootstrap:intent&&{publicKey:rootMember,epochKey:Array.from(intent.epoch0Key)}};
      }};
    ` }, alias: { '@tendriller/core/peers': join(process.cwd(), 'dist/sdk/peers.mjs'),
      '@tendriller/core/authority': join(process.cwd(), 'dist/sdk/authority.mjs'),
      '@tendriller/core/admission': join(process.cwd(), 'dist/sdk/session/admission.mjs') }, bundle: true,
      format: 'esm', platform: 'browser', write: false });
    const assets = (version: string) => ({
      'index.html': { type: 'text/html', body: '<!doctype html><title>Uninitialized publication</title><meta name="tendriller-updates" content="careful"><h1>'+version+'</h1><label>Local draft<textarea></textarea></label><button>Connect this device</button><p id="enrollment">Not initialized</p><script type="module" src="./page.mjs"></script>' },
      'page.mjs': { type: 'text/javascript', body: fixture.outputFiles[0].text },
    });
    const first=await publishFiles(handle,assets('Uninitializable v1'));
    const requests: string[]=[];let sentFrames=0;
    page.on('request',request=>{if(request.url().includes('/_tendril/'))requests.push(request.method()+' '+new URL(request.url()).pathname);});
    page.on('websocket',socket=>{if(socket.url().endsWith('/_tendril/publication-ready'))socket.on('framesent',()=>sentFrames++);});
    await page.route('**/_tendril/peers/enrollment',route=>route.request().postDataJSON()?.action==='initialize'?route.abort('failed'):route.continue());
    const initial=page.waitForEvent('websocket',socket=>socket.url().endsWith('/_tendril/publication-ready'))
      .then(socket=>socket.waitForEvent('framereceived',frame=>JSON.parse(String(frame.payload)).current===first.version));
    await openClaimed(page,handle);await initial;
    await expect(page.getByRole('heading',{name:'Uninitializable v1'})).toBeVisible();
    await page.getByRole('textbox',{name:'Local draft'}).fill('Retain this unresolved local draft');
    await page.getByRole('button',{name:'Connect this device'}).click();
    await expect(page.locator('#enrollment')).toHaveText('Initialization unavailable; original genesis retained');
    const before=await page.evaluate(()=>(window as any).fixture.snapshot());
    // The exact genesis and its epoch key were durably retained before the first initialize request, signed by this device's own key.
    expect(before.bootstrap.publicKey).toBe(before.device);expect(before.bootstrap.epochKey).toHaveLength(32);
    expect(before.draft).toBe('Retain this unresolved local draft');
    expect(await page.evaluate(()=>(window as any).tendril.application.available)).toBe(false);
    const enrollmentRequests=()=>requests.filter(value=>value.includes('/peers/enrollment')).length;
    const enrollmentBefore=enrollmentRequests();expect(enrollmentBefore).toBeGreaterThan(0);
    const pinned=page.url();const quietBaseline=requests.length;
    await publishFiles(handle,assets('Repaired v2'));
    const notice=page.getByRole('status',{name:'Publication update'});
    await expect(notice).toBeVisible();await expect(notice).toContainText('New version published');
    await expect(page.getByRole('textbox')).toHaveValue(before.draft);expect(page.url()).toBe(pinned);
    expect(await page.evaluate(()=>(window as any).fixture.snapshot())).toEqual(before);
    expect(requests.slice(quietBaseline)).toEqual([]);expect(sentFrames).toBe(0);
    const update=page.getByRole('link',{name:'Open update',exact:true});
    await expect(update).toHaveAttribute('href',localPageUrl(handle));
    await update.click();await expect(page.getByRole('heading',{name:'Repaired v2'})).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveValue(before.draft);
    // The resumed document keeps the same device and original genesis; no update retries initialization or replaces it.
    expect(await page.evaluate(()=>(window as any).fixture.snapshot())).toEqual(before);
    expect(enrollmentRequests()).toBe(enrollmentBefore);
    await expect(page.getByRole('status',{name:'Publication update'})).toBeHidden();
  } finally { await deletePage(handle); }
});
