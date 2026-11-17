import { expect, it } from 'vitest';
import {
  createPeerIdentity, peerDigest, participantGrant, verifyReleaseState,
  type AuthorityBundle, type ReleaseState, type SignedReleaseActivation, type SignedReleasePolicy,
} from '@chronolog/peer-generation/control';
import { RELEASE_SOCKET_PROTOCOL } from '../../contract/releases.mjs';
import { api, apiJson, create, inDO, req, uploadBlobJson } from './helpers';
import { createTestPage } from './public-fixture';
import { activateRelease, publishRelease, releaseApplicationId, releaseManifest, releasePolicy, releaseRequest } from './release-helpers';
import { authenticateAgentToken } from '../src/access';
import { deleteUnreferencedContent, fileKey } from '../src/content';
import { handlePeerReleases, verifiedReleaseObject } from '../src/peer-releases';
import { sha256Hex } from '../src/ids';
import { failVersion, reportHealth } from '../src/files';

const configuration = (signer: { publicKey: string }) => ({ historyId: 'release-test-history',
  executionManifestDigest: '12'.repeat(32), schemaAdministrator: signer.publicKey,
  definition: { id: 'release-test', version: '1', schema: null, commands: [], queries: [] },
  epoch: 0, keyDigest: '56'.repeat(32), members: [{ grant: participantGrant(signer.publicKey, { administrator: true }) }],
});
const boot = (html: string) => JSON.parse(/window\.__TENDRIL__=(.*?);<\/script>/.exec(html)![1]);

it('publishes exact signed page bytes before data configuration and serves a separate trusted bootstrap', async () => {
  const applicationId = releaseApplicationId(), signer = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId }, mode: 'dashboard', listener: false });
  const policy = await releasePolicy(h, [signer]);
  const first = await publishRelease(h, applicationId, signer, {
    'index.html': '<head></head><script src="app.js"></script><main>Signed page</main>',
    'app.js': 'export const release = "A";', 'docs/index.html': '<head></head>Nested document',
  });
  const selected = await activateRelease(h, applicationId, signer, first.id);
  const state = await apiJson<ReleaseState>(h, 'GET', 'peers/releases');
  await verifyReleaseState(state, { applicationId, controlPublicKey: state.controlPublicKey });
  expect(state.policies).toEqual([policy]); expect(state.activations).toEqual([selected.activation]);
  const response = await req(h.page_url), html = await response.text(), config = boot(html);
  expect(html).toContain('<main>Signed page</main>');
  expect(config.publication.id).toBe(first.id); expect(config.peerRelease).toEqual({ state, manifest: first.manifest });
  expect(config.publication.base).toContain(`_publications/${first.id}/`);
  const authored = first.contents.find(value => value.asset.path === 'index.html')!;
  const raw = await api(h, 'GET', `peers/releases/content/${authored.asset.digest}`);
  expect(new Uint8Array(await raw.arrayBuffer())).toEqual(authored.bytes);
  expect(await (await req(h.page_url + `_publications/${first.id}/app.js`)).text()).toBe('export const release = "A";');
  const nested = await (await req(h.page_url + `_publications/${first.id}/docs/`)).text();
  expect(nested).toContain(`<base href="${config.publication.base}docs/">`);
  const authority = await apiJson<AuthorityBundle>(h, 'PUT', 'peers/application', configuration(signer));
  expect(authority.descriptor.payload.controlPublicKey).toBe(state.controlPublicKey);
  const obsolete = await releaseRequest(applicationId, signer, first.id, selected.activation.id);
  expect((await api(h, 'POST', 'peers/releases/activations', obsolete)).status).toBe(409);
  expect((await api(h, 'PATCH', '', { lifetime: 'ad_hoc' })).status).toBe(409);
  expect(await apiJson(h, 'GET', 'peers/releases')).toEqual(state);
  await inDO(h.id, t => {
    expect(() => failVersion(t, 1, ['broken'])).toThrow();
    expect(() => reportHealth(t, 1, false, [], 'device')).toThrow();
  });
  expect(await inDO(h.id, t => ({ data: t.db.one('SELECT COUNT(*) AS n FROM application_changes'),
    envelopes: t.db.one('SELECT COUNT(*) AS n FROM record_log_entries'), devices: t.db.one('SELECT COUNT(*) AS n FROM devices') })))
    .toEqual({ data: { n: 0 }, envelopes: { n: 0 }, devices: { n: 0 } });
});

it('retains the old selection across incomplete content, CAS conflicts and lost replies, including after publisher revocation', async () => {
  const applicationId = releaseApplicationId(), signer = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId } });
  const policy = await (await page.api('PUT', 'peers/releases/policy', { requestId: 'policy', expectedPolicy: null,
    publishers: [{ publicKey: signer.publicKey }] })).json() as SignedReleasePolicy;
  const first = await releaseManifest(applicationId, signer, { 'index.html': '<head></head>First' });
  const second = await releaseManifest(applicationId, signer, { 'index.html': '<head></head>Second', 'app.js': 'second()' });
  for (const value of first.contents) expect((await page.api('PUT', `peers/releases/content/${value.asset.digest}`, value.bytes)).status).toBe(200);
  expect((await page.api('POST', 'peers/releases/manifests', first.manifest)).status).toBe(200);
  const request = await releaseRequest(applicationId, signer, first.id, null, 0, 'first');
  const activation = await (await page.api('POST', 'peers/releases/activations', request)).json() as SignedReleaseActivation;
  expect((await page.api('POST', 'peers/releases/manifests', second.manifest)).status).toBe(409);
  expect((await (await page.api('GET', 'peers/releases')).json() as ReleaseState).activations).toEqual([activation]);
  await page.restart();
  expect(await (await page.api('POST', 'peers/releases/activations', request)).json()).toEqual(activation);
  for (const value of second.contents) expect((await page.api('PUT', `peers/releases/content/${value.asset.digest}`, value.bytes)).status).toBe(200);
  expect((await page.api('POST', 'peers/releases/manifests', second.manifest)).status).toBe(200);
  const requests = await Promise.all(['race-a', 'race-b'].map(id => releaseRequest(applicationId, signer, second.id, activation.id, 0, id)));
  const replies = await Promise.all(requests.map(value => page.api('POST', 'peers/releases/activations', value)));
  expect(replies.map(value => value.status).sort()).toEqual([200, 409]);
  const active = await replies.find(value => value.ok)!.json() as SignedReleaseActivation;
  expect(await (await page.fetchPage(`_publications/${first.id}/index.html`)).text()).toContain('First');
  expect(await (await page.fetchPage()).text()).toContain('Second');
  const rollback = await releaseRequest(applicationId, signer, first.id, active.id, 0, 'explicit-old-release');
  const restored = await (await page.api('POST', 'peers/releases/activations', rollback)).json() as SignedReleaseActivation;
  expect(restored.payload.releaseId).toBe(first.id);
  expect((await page.api('PUT', 'peers/releases/policy', { requestId: 'freeze', expectedPolicy: await peerDigest(policy), publishers: [] })).status).toBe(200);
  expect(await (await page.api('POST', 'peers/releases/activations', rollback)).json()).toEqual(restored);
  expect((await page.api('POST', 'peers/releases/activations', await releaseRequest(applicationId, signer, second.id, restored.id, 1))).status).toBe(403);
  expect((await page.api('POST', 'peers/releases/activations', await releaseRequest(applicationId, signer, second.id, null, 0, 'first'))).status).toBe(409);
  expect((await page.api('PATCH', '', { lifetime: 'ad_hoc' })).status).toBe(409);
});

it('requires separate account-bound publisher authority and explicit release-content admission', async () => {
  const applicationId = releaseApplicationId(), publisher = await createPeerIdentity(), dataWriter = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId }, listener: false });
  await apiJson(h, 'PUT', 'peers/application', configuration(dataWriter));
  await releasePolicy(h, [publisher]);
  const draft = await releaseManifest(applicationId, dataWriter, { 'index.html': '<head></head>Data authority is separate' });
  expect((await api(h, 'POST', 'peers/releases/manifests', draft.manifest)).status).toBe(403);
  const privateBytes = '<head></head>Private blob';
  await uploadBlobJson(h, privateBytes, { type: 'text/html' });
  const secret = await releaseManifest(applicationId, publisher, { 'index.html': privateBytes });
  expect((await api(h, 'GET', `peers/releases/content/${await sha256Hex(privateBytes)}`)).status).toBe(404);
  expect((await api(h, 'POST', 'peers/releases/manifests', secret.manifest)).status).toBe(409);
  expect((await api(h, 'PUT', `peers/releases/content/${secret.contents[0].asset.digest}`, 'wrong bytes')).status).toBe(422);
  expect((await api(h, 'POST', 'peers/releases/manifests', { ciphertext: 'private', epoch: 0 })).status).toBe(403);
  for (const [method, path, body] of [['GET', 'publications', undefined], ['POST', 'publications', {}], ['POST', 'publications/1/select', {}]] as const)
    expect((await api(h, method, path, body)).status).toBe(409);

  const guestApplicationId = releaseApplicationId();
  const page = await createTestPage({ application: { kind: 'peer', id: guestApplicationId } });
  const guest = await page.participant();
  expect((await guest.api('PUT', 'peers/releases/policy', { requestId: 'guest', expectedPolicy: null, publishers: [] })).status).toBe(403);
  const configured = await page.api('PUT', 'peers/releases/policy', { requestId: 'owner', expectedPolicy: null,
    publishers: [{ publicKey: publisher.publicKey }] });
  expect(configured.status).toBe(200);
  const ownerPolicy = await configured.json() as SignedReleasePolicy;
  expect((await guest.api('POST', 'peers/releases/manifests', secret.manifest)).status).toBe(403);
  const guestKey = await createPeerIdentity();
  const admitted = await page.api('PUT', 'peers/releases/policy', { requestId: 'admit-guest', expectedPolicy: await peerDigest(ownerPolicy),
    publishers: [{ publicKey: guestKey.publicKey, accountId: guest.account }] });
  expect(admitted.status).toBe(200);
  const guestPolicy = await admitted.json() as SignedReleasePolicy;
  const guestRelease = await releaseManifest(guestApplicationId, guestKey, { 'index.html': '<head></head>Guest publisher' }, 1);
  for (const value of guestRelease.contents) expect((await guest.api('PUT', `peers/releases/content/${value.asset.digest}`, value.bytes,
    { headers: { 'Content-Type': value.asset.mediaType } })).status).toBe(200);
  expect((await guest.api('POST', 'peers/releases/manifests', guestRelease.manifest)).status).toBe(200);
  const guestRequest = await releaseRequest(guestApplicationId, guestKey, guestRelease.id, null, 1);
  expect((await page.api('POST', 'peers/releases/activations', guestRequest)).status).toBe(403);
  expect((await guest.api('POST', 'peers/releases/activations', guestRequest)).status).toBe(200);
  expect((await page.api('PUT', 'peers/releases/policy', { requestId: 'rebind-key', expectedPolicy: await peerDigest(guestPolicy),
    publishers: [{ publicKey: guestKey.publicKey }] })).status).toBe(409);
});

it('allows revocation during streamed verification and preserves each request commit identity', async () => {
  const applicationId = releaseApplicationId(), signer = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId }, listener: false });
  const policy = await releasePolicy(h, [signer]);
  const draft = await releaseManifest(applicationId, signer, { 'index.html': '<head></head>Pending verification' });
  for (const value of draft.contents) await apiJson(h, 'PUT', `peers/releases/content/${value.asset.digest}`, value.bytes);
  await inDO(h.id, async t => {
    const principal = await authenticateAgentToken(t, h.token), original = t.env.FILES;
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { resume = resolve; });
    t.env.FILES = new Proxy(original, { get(target, name) {
      if (name === 'get') return async (...args: Parameters<R2Bucket['get']>) => { enter(); await held; return original.get(...args); };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const call = (path: string, method: string, body: unknown) => handlePeerReleases(t,
      new Request('https://example.test/' + path, { method, body: JSON.stringify(body) }), path, principal);
    const publication = call('peers/releases/manifests', 'POST', draft.manifest);
    try {
      await entered;
      const revoked = await call('peers/releases/policy', 'PUT', { requestId: 'revoke-in-flight', expectedPolicy: await peerDigest(policy), publishers: [] });
      expect(revoked.status).toBe(200);
      resume();
      await expect(publication).rejects.toMatchObject({ status: 409, code: 'release_policy_changed' });
      expect(t.db.all('SELECT * FROM page_release_publications')).toEqual([]);
    } finally { resume(); t.env.FILES = original; await publication.catch(() => {}); }
  });
  const state = await apiJson<ReleaseState>(h, 'GET', 'peers/releases');
  expect(state.policies).toHaveLength(2); expect(state.activations).toEqual([]);
});

it('fails closed if an initialized durable release head disappears and retains accepted content during collection', async () => {
  const applicationId = releaseApplicationId(), signer = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId }, listener: false });
  const policy = await releasePolicy(h, [signer]);
  const first = await publishRelease(h, applicationId, signer, { 'index.html': '<head></head>Retained' });
  await activateRelease(h, applicationId, signer, first.id);
  await inDO(h.id, async t => {
    t.skew += 2 * 86400_000;
    await deleteUnreferencedContent(t, first.contents[0].asset.digest);
    expect(await t.env.FILES.head(fileKey(t, first.contents[0].asset.digest))).not.toBeNull();
    t.db.run('DELETE FROM membership_records WHERE key=?', `chronolog-release/${applicationId}/head`);
  });
  expect((await api(h, 'GET', 'peers/releases')).status).toBe(503);
  expect((await api(h, 'PUT', 'peers/releases/policy', { requestId: 'silent-reset', expectedPolicy: await peerDigest(policy), publishers: [] })).status).toBe(503);
  expect((await req(h.page_url)).status).toBe(503);
});

it('rechecks the authenticated publisher after asynchronous content verification before storing the manifest', async () => {
  const applicationId = releaseApplicationId(), signer = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId }, listener: false });
  await releasePolicy(h, [signer]);
  const draft = await releaseManifest(applicationId, signer, { 'index.html': '<head></head>Revoked actor' });
  for (const value of draft.contents) await apiJson(h, 'PUT', `peers/releases/content/${value.asset.digest}`, value.bytes);
  await inDO(h.id, async t => {
    const principal = await authenticateAgentToken(t, h.token), original = t.env.FILES;
    t.env.FILES = new Proxy(original, { get(target, name) {
      if (name === 'get') return async (...args: Parameters<R2Bucket['get']>) => {
        const value = await original.get(...args); t.db.run('DELETE FROM tokens'); return value;
      };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await expect(handlePeerReleases(t, new Request('https://example.test/peers/releases/manifests', {
        method: 'POST', body: JSON.stringify(draft.manifest),
      }), 'peers/releases/manifests', principal)).rejects.toMatchObject({ status: 403 });
      expect(t.db.all('SELECT * FROM page_release_publications')).toEqual([]);
      expect(t.db.one('SELECT key FROM membership_records WHERE key=?', `chronolog-release/${applicationId}/manifest/${draft.id}`)).toBeNull();
    } finally { t.env.FILES = original; }
  });
});

it('offers a receive-only release watch with signed selection notices and rechecks socket access', async () => {
  const applicationId = releaseApplicationId(), signer = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId }, listener: false });
  await releasePolicy(h, [signer]);
  const first = await publishRelease(h, applicationId, signer, { 'index.html': '<head></head>Watched' });
  const response = await api(h, 'GET', 'peers/releases/socket', undefined, { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RELEASE_SOCKET_PROTOCOL });
  expect(response.status).toBe(101);
  const socket = response.webSocket!; socket.accept();
  const notice = new Promise(resolve => socket.addEventListener('message', event => resolve(JSON.parse(event.data as string)), { once: true }));
  const selected = await activateRelease(h, applicationId, signer, first.id);
  expect(await notice).toEqual(selected.activation);
  const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));
  socket.send(JSON.stringify({ ciphertext: 'private application payload', epoch: 0 }));
  expect(await closed).toBe(1008);
  const second = await api(h, 'GET', 'peers/releases/socket', undefined, { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RELEASE_SOCKET_PROTOCOL });
  const revoked = second.webSocket!;
  const initial = new Promise(resolve => revoked.addEventListener('message', event => resolve(JSON.parse(event.data as string)), { once: true }));
  const accessClosed = new Promise<number>(resolve => revoked.addEventListener('close', event => resolve(event.code), { once: true }));
  revoked.accept(); expect(await initial).toEqual(selected.activation);
  await inDO(h.id, t => { t.db.run('DELETE FROM tokens'); });
  const next = await releaseRequest(applicationId, signer, first.id, selected.activation.id);
  const owner = await req(h.page_url + '_tendril/peers/releases/activations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
  });
  expect(owner.status).toBe(200); expect(await accessClosed).toBe(4003);
  expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM record_log_entries'))).toEqual({ n: 0 });
});

it('rejects corrupt or missing active assets before exposing bytes, including a storage change after verification', async () => {
  const applicationId = releaseApplicationId(), signer = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId }, listener: false });
  await releasePolicy(h, [signer]);
  const first = await publishRelease(h, applicationId, signer, { 'index.html': '<head></head>Original', 'app.js': 'original()' });
  await activateRelease(h, applicationId, signer, first.id);
  const html = first.contents.find(value => value.asset.path === 'index.html')!;
  const script = first.contents.find(value => value.asset.path === 'app.js')!;
  await inDO(h.id, async t => {
    await t.env.FILES.put(fileKey(t, html.asset.digest), new Uint8Array(html.asset.bytes).fill(120));
    await t.env.FILES.delete(fileKey(t, script.asset.digest));
  });
  expect((await req(h.page_url)).status).toBe(503);
  expect((await api(h, 'GET', `peers/releases/content/${html.asset.digest}`)).status).toBe(503);
  expect((await req(h.page_url + `_publications/${first.id}/app.js`)).status).toBe(503);
  await inDO(h.id, async t => {
    const original = t.env.FILES;
    await original.put(fileKey(t, html.asset.digest), html.bytes);
    t.env.FILES = new Proxy(original, { get(target, name) {
      if (name === 'get') return async (key: string, options?: R2GetOptions) => {
        if (options?.onlyIf) await original.put(key, html.bytes);
        return original.get(key, options);
      };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try { await expect(verifiedReleaseObject(t, html.asset)).rejects.toMatchObject({ status: 503, code: 'release_content_changed' }); }
    finally { t.env.FILES = original; }
  });
});

it('uses the same signed release operations through public MCP without hosting a signer', async () => {
  const applicationId = releaseApplicationId(), signer = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId }, listener: false });
  const call = async (name: string, args: unknown = {}) => {
    const reply = await apiJson(h, 'POST', 'mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    expect(reply.error).toBeUndefined(); expect(reply.result.isError).not.toBe(true);
    return reply.result.structuredContent;
  };
  await call('configure_release_publishers', { configuration: { requestId: 'mcp-policy', expectedPolicy: null, publishers: [{ publicKey: signer.publicKey }] } });
  const text = '<head></head>MCP signed release', draft = await releaseManifest(applicationId, signer, { 'index.html': text });
  expect(await call('upload_release_text', { digest: draft.contents[0].asset.digest, text, mediaType: 'text/html' }))
    .toEqual({ digest: draft.contents[0].asset.digest, bytes: draft.contents[0].asset.bytes });
  expect(await call('publish_release', { manifest: draft.manifest })).toEqual({ id: draft.id, manifest: draft.manifest });
  const request = await releaseRequest(applicationId, signer, draft.id);
  const selected = await call('activate_release', { request });
  expect((await call('release_state')).activations).toEqual([selected]);
  expect(await (await req(h.page_url)).text()).toContain('MCP signed release');
});
