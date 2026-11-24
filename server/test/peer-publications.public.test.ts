import { env } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import {
  createPeerIdentity, signPublicationManifest, bytesDigest, participantGrant, generationStartRoot, verifyAuthorityBundle,
  type AuthorityBundle, type PeerIdentity, type SignedPublication, type SignedGeneration,
} from '@chronolog/peer-generation/control';
import { createTestPage } from './public-fixture';
import { apiJson, advance, req, signInAsOwner, create, inDO } from './helpers';
import { peerApi, peerApiJson, participantMessage } from './peer-exchange';
import { authenticateAgentToken } from '../src/access';
import { handlePeerParticipant } from '../src/peer-participant';
import { servedVersion } from '../src/files';
import { sha256Hex } from '../src/ids';
import { RESOURCE_LIMITS } from '../../contract/limits.mjs';

const definition = { id: 'code-release', version: '1', schema: null, commands: [], queries: [] } as const;
const applicationId = () => crypto.randomUUID().replaceAll('-', '').repeat(2);
function configuration(a: PeerIdentity, b: PeerIdentity) {
  return { historyId: 'code-history', executionManifestDigest: '12'.repeat(32), definition,
    schemaAdministrator: a.publicKey, epoch: 0, keyDigest: '34'.repeat(32),
    members: [{ grant: { ...participantGrant(a.publicKey, { publisher: true }), reader: false, writer: false,
      coordinator: false, recovery: false, dataRole: null } }, { grant: participantGrant(b.publicKey, { administrator: true }) }] };
}
async function release(authority: AuthorityBundle, author: PeerIdentity, operationId: string, previous: SignedPublication | null = null, text = 'version one') {
  const assets = [], files = [];
  for (const [path, type, code] of [['index.html', 'text/html', `<main>${text}</main><script type="module" src="./page.mjs"></script>`],
    ['page.mjs', 'text/javascript', `export const release = ${JSON.stringify(text)};`]]) {
    const data = new TextEncoder().encode(code), hash = await bytesDigest(data);
    files.push({ path, type, hash, size: data.length });
    assets.push({ hash, bytes: btoa(String.fromCharCode(...data)) });
  }
  const descriptor = authority.descriptor.payload;
  const publication = await signPublicationManifest({ applicationId: descriptor.applicationId, historyId: descriptor.historyId,
    profile: descriptor.profile, controlRevision: authority.controls.at(-1)!.payload.revision, author: author.publicKey, operationId,
    revision: previous === null ? 0 : previous.payload.revision + 1, previous: previous?.id ?? null,
    definitionDigest: descriptor.definitionDigest, executionManifestDigest: descriptor.executionManifestDigest,
    entry: 'index.html', files }, author);
  return { publication, assets };
}

it('projects signed page code atomically, retains exact old releases, and resumes after host restart', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const authority = await (await page.exchange('control/configure', configuration(a, b))).json() as AuthorityBundle;
  expect((await verifyAuthorityBundle(authority)).grant(a.publicKey)).toMatchObject({ publisher: true,
    administrator: false, reader: false, writer: false, coordinator: false, recovery: false, dataRole: null });
  expect((await verifyAuthorityBundle(authority)).grant(authority.descriptor.payload.controlPublicKey)?.publisher).toBe(false);
  expect(await (await page.exchange('publication/read')).json()).toBeNull();
  const first = await release(authority, a, 'release-one');
  const initial = await (await page.exchange('publication/publish', first)).json() as { publication: SignedPublication; version: number };
  expect(initial.publication).toEqual(first.publication); expect(initial.version).toBe(1);
  expect(await (await page.asset('page.mjs')).text()).toBe('export const release = "version one";');
  const second = await release(authority, a, 'release-two', first.publication, 'version two');
  expect((await page.exchange('publication/publish', second)).status).toBe(200);
  expect(await (await page.asset('page.mjs')).text()).toBe('export const release = "version two";');
  expect(await (await page.exchange('publication/publish', first)).json()).toEqual(initial);
  expect(await (await page.exchange('publication/read', { id: first.publication.id })).json()).toEqual(initial);
  expect(await (await page.asset('_publications/1/page.mjs')).text()).toBe('export const release = "version one";');
  await page.restart();
  expect(await (await page.exchange('publication/read')).json()).toEqual({ publication: second.publication, version: 2 });
  expect(await (await page.asset('page.mjs')).text()).toBe('export const release = "version two";');
  expect(await (await page.exchange('control/read')).json()).toEqual(authority);
});

it('revokes publishing at a control boundary while retaining exact earlier releases', async () => {
  const publisher = await createPeerIdentity(), administrator = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const initial = await (await page.exchange('control/configure', configuration(publisher, administrator))).json() as AuthorityBundle;
  const first = await release(initial, publisher, 'published-before-revocation');
  const retained = await (await page.exchange('publication/publish', first)).json();
  const created = await page.ownerExchange('control/administer', { transition: { transitionId: 'select-data-coordinator',
    expectedGeneration: null, coordinator: administrator.publicKey, controlRevision: 0, reason: 'create', base: null } });
  expect(created.status).toBe(200);
  const generation = await created.json() as SignedGeneration;
  const revoked = await page.ownerExchange('control/administer', {
    transition: { transitionId: 'revoke-publisher', expectedGeneration: generation.id, coordinator: administrator.publicKey,
      controlRevision: 1, reason: 'control-change', base: { point: { generation: generation.id, sequence: 0,
        root: await generationStartRoot(generation) }, receipt: null, bridge: [] } },
    control: { epoch: 0, keyDigest: '34'.repeat(32), recoveryFloor: null,
      grants: [participantGrant(administrator.publicKey, { administrator: true })] },
  });
  expect(revoked.status).toBe(200); await revoked.text();
  const current = await (await page.exchange('control/read')).json() as AuthorityBundle;
  expect((await page.exchange('publication/publish', await release(current, publisher, 'after-revocation', first.publication))).status).toBe(403);
  expect(await (await page.exchange('publication/publish', first)).json()).toEqual(retained);
  expect(await (await page.exchange('publication/read')).json()).toEqual(retained);
});

it('rejects administrators without publishing rights, changed retry identity, wrong bytes and stale release heads', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const authority = await (await page.exchange('control/configure', configuration(a, b))).json() as AuthorityBundle;
  expect((await page.exchange('publication/publish', await release(authority, b, 'non-publisher-admin'))).status).toBe(403);
  const first = await release(authority, a, 'release');
  const invalidBytes = { ...first, assets: first.assets.map((asset, index) => index ? asset : { ...asset, bytes: btoa('tampered') }) };
  expect((await page.exchange('publication/publish', invalidBytes)).status).toBe(400);
  expect(await (await page.exchange('publication/read')).json()).toBeNull();
  expect((await page.exchange('publication/publish', first)).status).toBe(200);
  expect((await page.exchange('publication/publish', await release(authority, a, 'release', null, 'changed intent'))).status).toBe(409);
  expect((await page.exchange('publication/publish', await release(authority, a, 'competing-first', null, 'stale'))).status).toBe(409);
  const guest = await page.participant();
  expect((await guest.exchange('publication/publish', await release(authority, a, 'foreign-account', first.publication))).status).toBe(403);
  expect((await page.api('POST', 'publications', {})).status).toBe(404);
  expect((await page.api('POST', 'publications/rollback', {})).status).toBe(404);
});

it('rejects all hosted data facets before control state or page content changes', async () => {
  const id = applicationId(), page = await createTestPage({ application: { id } });
  for (const [facet, action] of [['database', 'submit'], ['content', 'chunk'], ['ephemeral', 'signal']]) {
    const response = await page.api('POST', 'peers/participant', { protocol: 'chronolog-participant-v1', applicationId: id,
      requestId: 'blocked', facet, action, payload: { forbidden: 'ordinary application bytes' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'peer_participant_facet_forbidden' } });
  }
  for (const path of ['peers/application', 'peers/definition', 'peers/generations', 'peers/administration', 'peers/directory'])
    expect((await page.api('GET', path)).status).toBe(404);
});

it('selects one signed successor when code publishers race on the same release head', async () => {
  const publisher = await createPeerIdentity(), administrator = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const authority = await (await page.exchange('control/configure', configuration(publisher, administrator))).json() as AuthorityBundle;
  const candidates = await Promise.all(['left', 'right'].map(name => release(authority, publisher, `racing-${name}`, null, name)));
  const responses = await Promise.all(candidates.map(candidate => page.exchange('publication/publish', candidate)));
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = await responses.find(response => response.status === 200)!.json() as { publication: SignedPublication; version: number };
  expect(winner.version).toBe(1);
  expect(candidates.some(candidate => candidate.publication.id === winner.publication.id)).toBe(true);
  expect(await (await page.exchange('publication/read')).json()).toEqual(winner);
  await page.restart();
  expect(await (await page.exchange('publication/read')).json()).toEqual(winner);
});

it('rechecks account authorization after code upload before selecting a release', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity(), id = applicationId();
  const h = await create({ mode: 'dashboard', listener: false, application: { id } });
  const authority = await peerApiJson<AuthorityBundle>(h, 'control/configure', configuration(a, b));
  const publication = await release(authority, a, 'revoked-during-upload');
  await inDO(h.id, async t => {
    const principal = await authenticateAgentToken(t, h.token), original = t.env.FILES;
    let uploaded = false;
    t.env.FILES = new Proxy(original, { get(target, name) {
      if (name === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
        const result = await (original.put as any)(...args); uploaded = true; t.db.run('DELETE FROM tokens'); return result;
      };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      const request = new Request(`${h.api}/peers/participant`, { method: 'POST', body: JSON.stringify(participantMessage(id, 'publication/publish', publication)) });
      await expect(handlePeerParticipant(t, request, principal)).rejects.toMatchObject({ status: 403 });
      expect(uploaded).toBe(true); expect(t.db.get('peer_publication_head', null)).toBeNull();
      expect(t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM versions')!.n).toBe(0);
    } finally { t.env.FILES = original; }
  });
});

it('cleanup retains selected and historical signed releases and unsigned recovery is unavailable', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const h = await create({ mode: 'dashboard', listener: false, application: { id: applicationId() } });
  const authority = await peerApiJson<AuthorityBundle>(h, 'control/configure', configuration(a, b));
  const first = await release(authority, a, 'stable');
  await peerApiJson(h, 'publication/publish', first);
  const next = await release(authority, a, 'next', first.publication, 'new code');
  await peerApiJson(h, 'publication/publish', next);
  await inDO(h.id, t => {
    expect(t.db.get('current', 0)).toBe(2); expect(servedVersion(t)).toBe(2);
    t.skew += 31 * 86400_000;
    return t.cleanup();
  });
  expect(await inDO(h.id, t => ({ current: servedVersion(t), versions: t.db.all('SELECT version FROM versions ORDER BY version'),
    files: t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM version_files')!.n }))).toEqual({ current: 2, versions: [{ version: 1 }, { version: 2 }], files: 4 });
});


it('publishes a complete signed app before claim and adopts its existing keys and publication on owner sign-in', async () => {
  const ownerEmail = 'ready-before-claim@example.com';
  const h = await create({ claim: false, owner: ownerEmail, application: { id: applicationId() } });
  const author = await createPeerIdentity(), coordinator = await createPeerIdentity();
  const input = configuration(author, coordinator);
  const authority = await peerApiJson<AuthorityBundle>(h, 'control/configure', input);
  const prepared = await release(authority, author, 'prepared-before-claim', null, 'Already deployed before sign-in');
  // Real SQL engines exceed the former unclaimed-only 1 MiB limit. Prepare
  // the complete signed graph now; sign-in must never be a deployment gate.
  const wasm = new Uint8Array(2 * 1024 * 1024);
  wasm.set([0, 97, 115, 109, 1, 0, 0, 0]);
  const wasmHash = await bytesDigest(wasm);
  let binary = '';
  for (let offset = 0; offset < wasm.length; offset += 32768)
    binary += String.fromCharCode(...wasm.subarray(offset, offset + 32768));
  prepared.publication = await signPublicationManifest({ ...prepared.publication.payload,
    files: [...prepared.publication.payload.files, { path: 'engine/sqlite3.wasm', type: 'application/wasm', hash: wasmHash, size: wasm.length }]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) }, author);
  prepared.assets.push({ hash: wasmHash, bytes: btoa(binary) });
  const service = await apiJson(h, 'GET', 'service');
  expect(service.limits.resources.file_bytes).toBe(RESOURCE_LIMITS.file_bytes);
  expect(service.limits.resources).not.toHaveProperty('unclaimed_file_bytes');
  const receipt = await peerApiJson(h, 'publication/publish', prepared);
  expect(receipt.publication.id).toBe(prepared.publication.id);
  expect((await apiJson(h, 'GET', '')).owner_account_id).toBeNull();
  expect(await inDO(h.id, t => ({ lifetime: t.db.get('lifetime', 'ad_hoc'), expires: t.expiresAt() })))
    .toMatchObject({ lifetime: 'ad_hoc', expires: expect.any(Number) });
  expect((await req(h.page_url, { anonymous: true, redirect: 'manual' })).status).toBe(302);
  await expect(signPublicationManifest({ ...prepared.publication.payload,
    operationId: 'oversized-before-claim', revision: 1, previous: prepared.publication.id,
    files: prepared.publication.payload.files.map(file => file.path === 'engine/sqlite3.wasm'
      ? { ...file, size: RESOURCE_LIMITS.file_bytes + 1 } : file) }, author))
    .rejects.toMatchObject({ code: 'PEER_INTEGER_INVALID' });
  expect(await inDO(h.id, t => {
    try { t.checkLocalStorage(RESOURCE_LIMITS.page_bytes); return null; }
    catch (error) { return (error as { code: string }).code; }
  })).toBe('quota');
  await evictDurableObject(env.TENDRIL.get(env.TENDRIL.idFromName(h.id)));
  expect(await peerApiJson(h, 'publication/read')).toEqual(receipt);
  const accountId = 'prepared-owner-' + crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)').bind(accountId, ownerEmail, Date.now()).run();
  const cookie = await signInAsOwner(h, accountId, ownerEmail);
  const page = await req(h.page_url, { anonymous: true, headers: { Cookie: cookie } });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('Already deployed before sign-in');
  const servedEngine = await req(h.page_url + 'engine/sqlite3.wasm', { anonymous: true, headers: { Cookie: cookie } });
  expect(servedEngine.status).toBe(200);
  expect(await bytesDigest(new Uint8Array(await servedEngine.arrayBuffer()))).toBe(wasmHash);
  expect(await peerApiJson(h, 'publication/publish', prepared)).toEqual(receipt);
  expect((await peerApiJson<AuthorityBundle>(h, 'control/configure', input)).descriptor).toEqual(authority.descriptor);
  expect(await inDO(h.id, t => ({ owner: t.db.get('owner_account', null), lifetime: t.db.get('lifetime', 'ad_hoc'), expires: t.expiresAt(),
    accounts: t.db.get<{ accountId: string }[]>('peer_generation_accounts', []).map(item => item.accountId) })))
    .toEqual({ owner: accountId, lifetime: 'resident', expires: null, accounts: [accountId, accountId, accountId] });
});

it('retains unclaimed expiry, intended-owner checks and account resident quotas for prepared applications', async () => {
  const ownerEmail = 'prepared-quota@example.com';
  const h = await create({ claim: false, owner: ownerEmail, application: { id: applicationId() } });
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const authority = await peerApiJson<AuthorityBundle>(h, 'control/configure', configuration(a, b));
  const prepared = await release(authority, a, 'prepared-quota');
  const receipt = await peerApiJson(h, 'publication/publish', prepared);
  const wrong = 'wrong-' + crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)').bind(wrong, 'other@example.com', Date.now()).run();
  await expect(signInAsOwner(h, wrong, 'other@example.com')).rejects.toThrow('403');
  const account = 'full-' + crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)').bind(account, ownerEmail, Date.now()).run();
  for (let i = 0; i < 5; i++) await env.ACCOUNTS.prepare("INSERT INTO tendrils(id,owner_account,created_at,lifetime) VALUES(?,?,?,'resident')")
    .bind(crypto.randomUUID(), account, Date.now()).run();
  await expect(signInAsOwner(h, account, ownerEmail)).rejects.toThrow('429');
  const cookie = crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)')
    .bind(await sha256Hex(cookie), account, Date.now(), Date.now() + 60_000).run();
  const claimPage = await req('/auth/page?' + new URLSearchParams({ tendril: h.id, key: new URL(h.page_url).pathname.split('/')[2] }),
    { headers: { Cookie: '__Host-tendriller=' + cookie, Accept: 'text/html' } });
  expect(claimPage.status).toBe(429);
  expect(claimPage.headers.get('Content-Type')).toContain('text/html');
  const content = await claimPage.text();
  expect(content).toContain('Your account is at its page limit');
  expect(content).toContain('5 resident pages');
  expect(content).toContain('href="/dashboard"');
  expect(content).toContain('Your prepared app has not been claimed');
  expect((await apiJson(h, 'GET', '')).owner_account_id).toBeNull();
  expect(await peerApiJson(h, 'publication/read')).toEqual(receipt);
  await advance(h.id, 24 * 60 * 60 * 1000 + 1);
  expect((await peerApi(h, 'control/read')).status).toBe(410);
});
