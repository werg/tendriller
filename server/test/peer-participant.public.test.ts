import { expect, it } from 'vitest';
import { createPeerIdentity, participantGrant, bytesDigest, signPublicationManifest, verifyPublicationManifest, verifyAuthorityBundle,
  type PeerIdentity, type AuthorityBundle, type SignedPublication } from '@chronolog/peer-generation/control';
import { createParticipantRequest, PEER_PARTICIPANT_POLICY } from '../../contract/participant.mjs';
import { api, create, inDO, peerApi, peerJson, peerRequest, req } from './helpers';
import { authenticateAgentToken } from '../src/access';
import { handleParticipant } from '../src/peer-participant';
import { createTestPage } from './public-fixture';
import type { Tendril } from '../src/tendril';
import { createVersion, storeContent, reportHealth, failVersion, servedVersion, servePageFile } from '../src/files';

const definition = { id: 'signed-page', version: '1', schema: null, commands: [], queries: [] } as const;
async function setup() {
  const signer = await createPeerIdentity(), reader = await createPeerIdentity();
  const applicationId = crypto.randomUUID().replaceAll('-', '').repeat(2);
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId } });
  const response = await page.peer('control', 'configure', { historyId: 'signed-publication-history',
    executionManifestDigest: '12'.repeat(32), definition, schemaAdministrator: signer.publicKey,
    epoch: 0, keyDigest: '34'.repeat(32), members: [{ grant: participantGrant(signer.publicKey, { administrator: true }) },
      { grant: participantGrant(reader.publicKey) }] });
  expect(response.status).toBe(200);
  const authority = await response.json() as AuthorityBundle;
  return { page, signer, reader, authority, applicationId };
}
async function release(authority: AuthorityBundle, signer: PeerIdentity, revision: number, previous: string | null, suffix = '') {
  const marker = `signed-${revision}-${suffix}`, files = [], assets = [];
  for (const [path, type, text] of [
    ['index.html', 'text/html', `<!doctype html><html><head></head><body>${marker}<script type="module" src="./page.mjs"></script></body></html>`],
    ['page.mjs', 'text/javascript', `export const marker = '${marker}';\n`],
  ]) {
    const bytes = new TextEncoder().encode(text), hash = await bytesDigest(bytes);
    files.push({ path, type, size: bytes.length, hash }); assets.push({ hash, bytes: btoa(text) });
  }
  const descriptor = authority.descriptor.payload;
  const publication = await signPublicationManifest({ applicationId: descriptor.applicationId, historyId: descriptor.historyId,
    profile: descriptor.profile, controlRevision: authority.controls.at(-1)!.payload.revision, author: signer.publicKey,
    operationId: `release-${revision}-${suffix}-${signer.publicKey}`, revision, previous,
    definitionDigest: descriptor.definitionDigest, executionManifestDigest: descriptor.executionManifestDigest, entry: 'index.html', files }, signer);
  return { publication, assets, marker };
}
type Receipt = { publication: SignedPublication; version: number };
async function selected(page: Awaited<ReturnType<typeof createTestPage>>) {
  const response = await page.peer('publication', 'read'); expect(response.status).toBe(200); return await response.json() as Receipt | null;
}

it('routes only scoped control interests, rejects data facets before writes, and removes redundant HTTP control routes', async () => {
  const id = '19'.repeat(32), h = await create({ application: { kind: 'peer', id }, mode: 'dashboard', listener: false });
  const read = createParticipantRequest({ applicationId: id, facet: 'discovery', action: 'read', payload: {} });
  const response = await api(h, 'POST', 'peers/participant', read);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...read, payload: { applicationId: id, peers: [] } });
  expect((await api(h, 'POST', 'peers/participant', { ...read, applicationId: '29'.repeat(32) })).status).toBe(409);
  for (const [facet, action] of [['database', 'submit'], ['content', 'chunk'], ['ephemeral', 'signal']] as const) {
    const denied = createParticipantRequest({ applicationId: id, facet, action, payload: {} }, PEER_PARTICIPANT_POLICY);
    const result = await api(h, 'POST', 'peers/participant', denied);
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ error: { code: 'peer_participant_facet_forbidden' } });
  }
  for (const path of ['peers/application', 'peers/definition', 'peers/generations', 'peers/administration', 'peers/directory'])
    expect((await api(h, 'GET', path)).status).toBe(404);
  expect(await inDO(h.id, t => ({ controls: t.db.all('SELECT key FROM membership_records'),
    records: t.db.one('SELECT COUNT(*) AS n FROM record_log_entries'), versions: t.db.all('SELECT version FROM versions') })))
    .toEqual({ controls: [], records: { n: 0 }, versions: [] });
});

it('publishes exact signed bytes atomically, survives lost replies and restart, and keeps immutable prior code', async () => {
  const { page, signer, reader, authority } = await setup();
  expect(await selected(page)).toBeNull();
  const first = await release(authority, signer, 0, null), publish = (value: { publication: SignedPublication; assets: unknown }) =>
    page.peer('publication', 'publish', { publication: value.publication, assets: value.assets });
  const accepted = await publish(first); expect(accepted.status).toBe(200);
  const original = await accepted.json() as Receipt;
  await verifyPublicationManifest(original.publication, await verifyAuthorityBundle(authority));
  expect(await (await publish(first)).json()).toEqual(original);
  expect(await (await page.api('GET', `publications/${original.version}`)).json()).toMatchObject({ version: original.version });
  const next = await release(authority, signer, 1, first.publication.id);
  const damaged = structuredClone(next), code = atob(damaged.assets[1].bytes);
  damaged.assets[1].bytes = btoa((code[0] === 'x' ? 'y' : 'x') + code.slice(1));
  const mismatch = await publish(damaged);
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({ error: { code: 'peer_publication_asset_mismatch' } });
  const forbidden = await release(authority, reader, 1, first.publication.id);
  expect((await publish(forbidden)).status).toBe(403);
  const guest = await page.participant();
  expect((await guest.peer('publication', 'publish', { publication: next.publication, assets: next.assets })).status).toBe(403);
  const badPath = await signPublicationManifest({ ...next.publication.payload,
    files: [{ ...next.publication.payload.files[1], path: '_tendril/injected.mjs' }, next.publication.payload.files[0]] }, signer);
  expect((await publish({ publication: badPath, assets: next.assets })).status).toBe(400);
  expect(await selected(page)).toEqual(original);
  const updated = await publish(next); expect(updated.status).toBe(200);
  const second = await updated.json() as Receipt;
  expect(second.version).toBeGreaterThan(original.version);
  expect((await publish(await release(authority, signer, 1, first.publication.id, 'stale'))).status).toBe(409);
  await page.restart();
  expect(await selected(page)).toEqual(second);
  expect(await (await publish(next)).json()).toEqual(second);
  expect(await (await page.peer('control', 'read')).json()).toEqual(authority);
  // Serving is the real host's code path, not a mock manifest lookup.
  const info = await (await page.api('GET', '')).json() as { page_url: string };
  const servedCode = new Uint8Array(await (await req(info.page_url + 'page.mjs')).arrayBuffer());
  expect(await bytesDigest(servedCode)).toBe(next.publication.payload.files[1].hash);
  expect(await (await req(info.page_url)).text()).toContain(next.marker);
  const priorCode = new Uint8Array(await (await req(info.page_url + `_publications/${original.version}/page.mjs`)).arrayBuffer());
  expect(await bytesDigest(priorCode)).toBe(first.publication.payload.files[1].hash);
  const files = (await (await page.api('GET', `publications/${second.version}`)).json() as { files: { path: string; type: string; blob_id: string }[] }).files;
  const state = await (await page.api('GET', 'publications')).json() as { head_revision: number };
  expect((await page.api('POST', 'publications', { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: state.head_revision,
    entry: 'index.html', files: files.map(({ path, type, blob_id }) => ({ path, type, blob_id })) })).status).toBe(409);
  expect(await selected(page)).toEqual(second);
});

it('exposes counted owner-page reads of current and prior signed assets after restart', async () => {
  const { page, signer, authority } = await setup();
  const first = await release(authority, signer, 0, null, 'public-asset');
  const accepted = await page.peer('publication', 'publish', { publication: first.publication, assets: first.assets });
  expect(accepted.status).toBe(200);
  const original = await accepted.json() as Receipt;
  const next = await release(authority, signer, 1, first.publication.id, 'public-asset');
  expect((await page.peer('publication', 'publish', { publication: next.publication, assets: next.assets })).status).toBe(200);
  await page.restart();
  const before = page.hostTraffic;
  const current = await page.asset('page.mjs'); expect(current.status).toBe(200);
  expect(await bytesDigest(new Uint8Array(await current.arrayBuffer()))).toBe(next.publication.payload.files[1].hash);
  const html = await page.asset(''); expect(html.status).toBe(200);
  expect(await html.text()).toContain(next.marker);
  const prior = await page.asset(`_publications/${original.version}/page.mjs`); expect(prior.status).toBe(200);
  expect(await bytesDigest(new Uint8Array(await prior.arrayBuffer()))).toBe(first.publication.payload.files[1].hash);
  expect(page.hostTraffic).toEqual({ ...before, httpRequests: before.httpRequests + 3 });
  await expect(page.asset('../page.mjs')).rejects.toThrow('Invalid canonical shared file path');
  expect(page.hostTraffic).toEqual({ ...before, httpRequests: before.httpRequests + 3 });
});

async function handleSetup() {
  const signer = await createPeerIdentity(), id = crypto.randomUUID().replaceAll('-', '').repeat(2);
  const h = await create({ application: { kind: 'peer', id }, mode: 'dashboard', listener: false });
  const authority = await peerJson<AuthorityBundle>(h, 'control', 'configure', { historyId: 'failure-history', executionManifestDigest: '12'.repeat(32),
    definition, schemaAdministrator: signer.publicKey, epoch: 0, keyDigest: '34'.repeat(32), members: [{ publicKey: signer.publicKey, administrator: true }] });
  const first = await release(authority, signer, 0, null);
  const accepted = await peerJson<Receipt>(h, 'publication', 'publish', { publication: first.publication, assets: first.assets });
  return { h, authority, signer, first, accepted };
}
const durableState = (t: Tendril) => ({ latest: t.db.get('latest', 0), current: t.db.get('current', 0), mapping: t.db.get('peer_publication_versions', []),
  records: t.db.all<{ key: string; value: ArrayBuffer }>("SELECT key,value FROM membership_records WHERE key LIKE 'peer-generation/publications/%'")
    .map(row => ({ key: row.key, bytes: [...new Uint8Array(row.value)] })), versions: t.db.all('SELECT version FROM versions ORDER BY version') });

for (const phase of ['storage', 'commit', 'revocation'] as const) it(`does not select signed code when ${phase} fails during preparation`, async () => {
  const { h, signer, authority, first, accepted } = await handleSetup(), next = await release(authority, signer, 1, first.publication.id, phase);
  const input = { publication: next.publication, assets: next.assets };
  await inDO(h.id, async t => {
    const principal = await authenticateAgentToken(t, h.token), before = durableState(t), bucket = t.env.FILES, set = t.db.set;
    let injected = false;
    if (phase === 'commit') t.db.set = (key, value) => {
      if (key === 'peer_publication_versions') { injected = true; throw new Error('Injected publication commit failure'); }
      return set.call(t.db, key, value);
    };
    else t.env.FILES = new Proxy(bucket, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
        injected = true;
        if (phase === 'storage') throw new Error('Injected publication storage failure');
        const stored = await target.put(...args); t.db.run('DELETE FROM tokens'); return stored;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      const work = handleParticipant(t, peerRequest(h.application.id, 'publication', 'publish', input), principal);
      if (phase === 'revocation') await expect(work).rejects.toMatchObject({ status: 403 });
      else await expect(work).rejects.toThrow(`Injected publication ${phase} failure`);
      expect(injected).toBe(true);
      expect(durableState(t)).toEqual(before);
    } finally { t.env.FILES = bucket; t.db.set = set; }
  });
  if (phase !== 'revocation') {
    const retry = await peerJson<Receipt>(h, 'publication', 'publish', input);
    expect(retry.publication).toEqual(next.publication); expect(retry.version).toBe(accepted.version + 1);
    expect(await peerJson(h, 'publication', 'read')).toEqual(retry);
  }
});

it('fences an unsigned publication prepared before generation configuration commits', async () => {
  const signer = await createPeerIdentity(), id = '39'.repeat(32);
  const h = await create({ application: { kind: 'peer', id }, mode: 'dashboard', listener: false });
  await inDO(h.id, async t => {
    const principal = await authenticateAgentToken(t, h.token);
    const content = await storeContent(t, new TextEncoder().encode('<head></head>unsigned').slice().buffer, 'text/html');
    await createVersion(t, new Map([['index.html', { path: 'index.html', type: 'text/html', ...content }]]), null, 'fixture');
    await expect(createVersion(t, new Map([['index.html', { path: 'index.html', type: 'text/html', ...content }]]), null, 'fixture', {
      async beforeCommit() {
        const configured = await handleParticipant(t, peerRequest(id, 'control', 'configure', {
          historyId: 'race-history', executionManifestDigest: '12'.repeat(32), definition, schemaAdministrator: signer.publicKey,
          epoch: 0, keyDigest: '34'.repeat(32), members: [{ publicKey: signer.publicKey, administrator: true }],
        }), principal);
        expect(configured.status).toBe(200);
      },
    })).rejects.toMatchObject({ status: 409, code: 'peer_signed_publication_required' });
    expect(t.db.get('peer_generation_configuration', null)).not.toBeNull();
    expect(t.db.get('latest', 0)).toBe(1);
    expect(t.db.all('SELECT version FROM versions')).toEqual([{ version: 1 }]);
    expect(servedVersion(t)).toBe(0);
    await expect(servePageFile(t, new Request(h.page_url), '/', '_publications/1/index.html', 'owner', t.db.get('owner_account', '')))
      .rejects.toMatchObject({ status: 404 });
  });
});

it('retains scoped signed chain metadata when old hosted files expire without retargeting an exact retry', async () => {
  const { h, authority, signer, first, accepted } = await handleSetup();
  const next = await release(authority, signer, 1, first.publication.id, 'retained-head');
  const head = await peerJson<Receipt>(h, 'publication', 'publish', { publication: next.publication, assets: next.assets });
  // Model the existing bounded file-retention policy independently of signed metadata retention.
  await inDO(h.id, t => t.transaction(() => {
    t.db.run('DELETE FROM publication_blobs WHERE version=?', accepted.version);
    t.db.run('DELETE FROM version_files WHERE version=?', accepted.version);
    t.db.run('DELETE FROM versions WHERE version=?', accepted.version);
  }));
  expect(await peerJson(h, 'publication', 'read', { id: first.publication.id })).toEqual(accepted);
  expect(await peerJson(h, 'publication', 'read')).toEqual(head);
  expect((await peerApi(h, 'publication', 'read', { id: 'ff'.repeat(32) })).status).toBe(404);
  expect((await peerApi(h, 'publication', 'read', { id: 'not-an-id' })).status).toBe(400);
  const retry = await peerApi(h, 'publication', 'publish', { publication: first.publication, assets: first.assets });
  expect(retry.status).toBe(410);
  expect(await retry.json()).toMatchObject({ error: { code: 'peer_publication_unavailable' } });
  expect((await req(h.page_url + `_publications/${accepted.version}/page.mjs`)).status).toBe(404);
  expect(await peerJson(h, 'publication', 'read')).toEqual(head);
});

it('reports failed or restricted signed code without selecting older healthy or low-risk assets', async () => {
  const { h, authority, signer, first, accepted } = await handleSetup();
  await inDO(h.id, t => reportHealth(t, accepted.version, true, [], null));
  const next = await release(authority, signer, 1, first.publication.id, 'selected-code');
  const head = await peerJson<Receipt>(h, 'publication', 'publish', { publication: next.publication, assets: next.assets });
  const revision = await inDO(h.id, t => t.db.get('publication_head_revision', 0));
  await inDO(h.id, t => {
    reportHealth(t, head.version, false, ['page failed'], null);
    failVersion(t, head.version, ['repeat report']);
    expect(t.db.get('current', 0)).toBe(head.version);
    expect(t.db.get('healthy', 0)).toBe(accepted.version);
    expect(t.db.get('publication_head_revision', 0)).toBe(revision);
    expect(servedVersion(t)).toBe(head.version);
  });
  expect(await peerJson(h, 'publication', 'read')).toEqual(head);
  const code = await req(h.page_url + 'page.mjs');
  expect(code.headers.get('X-Tendril-Publication')).toBe(String(head.version));
  expect(await bytesDigest(new Uint8Array(await code.arrayBuffer()))).toBe(next.publication.payload.files[1].hash);
  const rollback = await api(h, 'POST', 'publications/rollback', { cid: crypto.randomUUID(), expected_generations: {},
    expected_head_revision: revision, version: accepted.version });
  expect(rollback.status).toBe(409);
  expect(await rollback.json()).toMatchObject({ error: { code: 'peer_signed_publication_required' } });
  await inDO(h.id, async t => {
    t.db.run('UPDATE versions SET risk_score=9 WHERE version=?', head.version);
    await expect(servePageFile(t, new Request(h.page_url + 'page.mjs'), '/', 'page.mjs', 'guest', null))
      .rejects.toMatchObject({ status: 403, code: 'publication_restricted' });
    expect(servedVersion(t)).toBe(head.version);
    expect(t.db.get('publication_head_revision', 0)).toBe(revision);
  });
  expect(await peerJson(h, 'publication', 'read')).toEqual(head);
});
