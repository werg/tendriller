import { describe, it, expect } from 'vitest';
import { createSigningIdentity, epochKeyCommitment, encodeRecord, decodeRecord, signEnrollmentRequest, signPublicationManifest, verifyAuthorityBundle, recordDigest, signParticipantRequest, signFinalityStatement, finalityPolicyDigest } from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import { createTestPage } from './public-fixture';
import { create, api, req, inDO, ownerHeaders } from './helpers';
const appId = '51'.repeat(32), executionManifestDigest = '73'.repeat(32);
async function body(response: Response): Promise<any> { const value = await response.json(); if (!response.ok) throw Error(`${response.status}: ${JSON.stringify(value)}`); return value; }
async function prepare(page: Awaited<ReturnType<typeof createTestPage>>, suppliedPublisher?: Awaited<ReturnType<typeof createSigningIdentity>>) {
  const publisher = suppliedPublisher ?? await createSigningIdentity();
  const configuration = { executionManifestDigest, executionProfile: 'events', publisherKeys: [publisher.publicKey] };
  const metadata = await body(await page.api('POST', 'application', configuration));
  return { configuration, metadata, publisher };
}
async function enroll(send: (method: string, path: string, input?: unknown) => Promise<Response>, identity: Awaited<ReturnType<typeof createSigningIdentity>>, applicationId: string, epochKeyDigest: string) {
  const challenge = await body(await send('POST', 'peers/enrollment', { action: 'challenge', publicKey: identity.publicKey }));
  const proof = await signEnrollmentRequest({ applicationId, publicKey: identity.publicKey, challenge: challenge.challenge, epoch: 0, epochKeyDigest }, identity);
  return body(await send('POST', 'peers/enrollment', { action: 'enroll', proof: authorityRecord(encodeRecord(proof)) }));
}
describe('browser-first authored-operation authority', () => {
  it('prepares and publishes signed UI before the first data browser key is known', async () => {
    const page = await createTestPage({ application: { id: appId } }), { metadata, publisher } = await prepare(page);
    expect(metadata.authority).toBeNull();
    const bytes = new TextEncoder().encode('<!doctype html><html><title>Browser first</title><body>Ready</body></html>');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    const publication = await signPublicationManifest({ applicationId: appId, membershipId: metadata.publicationAuthority.grantId, author: publisher.publicKey, operationId: 'pre-owner-publication', revision: 0, previous: null, executionManifestDigest, entry: 'index.html', files: [{ path: 'index.html', hash, size: bytes.length, type: 'text/html' }] }, publisher);
    const receipt = await body(await page.api('POST', 'peers/publication', { action: 'publish', publication, assets: [{ hash, bytes: btoa(String.fromCharCode(...bytes)) }] }));
    expect(receipt.publication.id).toBe(publication.id);
    expect((await body(await page.api('GET', 'application'))).authority).toBeNull();
    await page.restart();
    expect((await body(await page.api('POST', 'peers/publication', { action: 'read' }))).publication.id).toBe(publication.id);
    const authored = await page.asset();
    expect(authored.status).toBe(200);
    expect(authored.headers.get('Content-Type')).toContain('text/html');
    expect(authored.headers.get('Content-Security-Policy')).toBeNull();
    expect(await authored.text()).toContain('Browser first');
  });
  it('a prepared application reports configured, is not downgradable to ad hoc while an unprepared one is', async () => {
    const page = await createTestPage({ application: { id: appId } });
    expect((await body(await page.api('GET', ''))).configured).toBe(false);
    expect((await page.api('PATCH', '', { lifetime: 'resident' })).status).toBe(200);
    expect((await page.api('PATCH', '', { lifetime: 'ad_hoc' })).status).toBe(200);
    await prepare(page);
    expect((await body(await page.api('GET', ''))).configured).toBe(true);
    const downgrade = await page.api('PATCH', '', { lifetime: 'ad_hoc' });
    expect(downgrade.status).toBe(409);
    expect((await downgrade.json() as any).error.code).toBe('application_requires_resident');
  });
  it('requires browser account+origin and binds the initial root and epoch commitment, without a native process', async () => {
    const handle = await create({ application: { id: appId } }), publisher = await createSigningIdentity(), browser = await createSigningIdentity();
    await body(await api(handle, 'POST', 'application', { executionManifestDigest, executionProfile: 'events', publisherKeys: [publisher.publicKey] }));
    expect((await api(handle, 'POST', 'peers/enrollment', { action: 'challenge', publicKey: browser.publicKey })).status).toBe(403);
    const endpoint = `${handle.page_url}_tendril/peers/enrollment`, headers = ownerHeaders(handle.page_url);
    expect((await req(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'challenge', publicKey: browser.publicKey }) })).status).toBe(403);
    const send = (method: string, path: string, input?: unknown) => req(`${handle.page_url}_tendril/${path}`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const epochKey = crypto.getRandomValues(new Uint8Array(32)), commitment = await epochKeyCommitment(appId, 0, epochKey);
    const metadata = await enroll(send, browser, appId, commitment), bundle = decodeRecord<any>(authorityRecordBytes(metadata.authority));
    await verifyAuthorityBundle(bundle);
    expect(bundle.descriptor.payload.rootPrincipal).toBe(browser.publicKey);
    expect(bundle.descriptor.payload.finalityPolicy.kind).toBe('none');
    expect(bundle.memberships[0].payload.epochKeyDigest).toBe(commitment);
    expect(bundle.memberships[0].payload.members).toEqual([{ publicKey: browser.publicKey, reader: true, writer: true, administrator: true, publisher: false, finalizer: false }]);
    const stored = await inDO(handle.id, t => t.db.get<any>('application_authority', null));
    expect(stored).toEqual(metadata.authority);
    expect(new TextDecoder().decode(encodeRecord(bundle))).not.toContain('"epochKey":');
  });
  it('requires recipient key proof and explicit owner grants; exact grant retry cannot broaden rights', async () => {
    const page = await createTestPage({ application: { id: appId } }); await prepare(page);
    const owner = await createSigningIdentity(), guest = await createSigningIdentity(), key = crypto.getRandomValues(new Uint8Array(32)), commitment = await epochKeyCommitment(appId, 0, key);
    const first = await enroll(page.ownerApi, owner, appId, commitment), bundle = decodeRecord<any>(authorityRecordBytes(first.authority));
    const participant = await page.participant(); await enroll(participant.api, guest, appId, commitment);
    const grant = { requestId: 'reviewed-recipient', expectedMembershipId: await recordDigest(bundle.memberships[0]), authorTimeAfterMs: '0', grant: { publicKey: guest.publicKey, reader: true, writer: true, administrator: false, publisher: false, finalizer: false } };
    expect((await participant.api('POST', 'peers/enrollment', { action: 'grant', ...grant })).status).toBe(403);
    const accepted = await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'grant', ...grant }));
    const updated = decodeRecord<any>(authorityRecordBytes(accepted.authority)); await verifyAuthorityBundle(updated);
    expect(updated.memberships[1].payload.members.find((member: any) => member.publicKey === guest.publicKey)?.administrator).toBe(false);
    expect((await page.ownerApi('POST', 'peers/enrollment', { action: 'grant', ...grant })).status).toBe(200);
    expect((await page.ownerApi('POST', 'peers/enrollment', { action: 'grant', ...grant, grant: { ...grant.grant, administrator: true } })).status).toBe(409);
  });
});

it('rejects invalid finality before freezing configuration and accepts canonical fractional tool bounds idempotently', async () => {
  const page = await createTestPage({ application: { id: appId } }), publisher = await createSigningIdentity();
  const configuration = { executionManifestDigest, executionProfile: 'events', publisherKeys: [publisher.publicKey] };
  for (const requestedFinality of [null, { kind: 'browser-signed-frontier', extra: true }, authorityRecord(encodeRecord({ kind: 'fixed-validator', validators: [], threshold: 0, scopes: [] }))]) {
    expect((await page.api('POST', 'application', { ...configuration, requestedFinality })).status).toBe(400);
    expect((await body(await page.api('GET', 'application'))).configuration).toBeNull();
  }
  const tools = { id: 'fractional-tools', version: '1', commands: [{ name: 'measure', description: 'A bounded fractional input', input: { type: 'number', minimum: 0.25, maximum: 1.75 } }], queries: [] };
  const first = await body(await page.api('POST', 'application', { ...configuration, tools }));
  const retry = await body(await page.api('POST', 'application', { tools, publisherKeys: configuration.publisherKeys, executionProfile: 'events', executionManifestDigest }));
  expect(retry.publicationAuthority).toEqual(first.publicationAuthority);
  expect(retry.configuration.tools.commands[0].input.minimum).toBe(0.25);
  expect((await page.api('POST', 'application', { ...configuration, tools: { ...tools, commands: [{ ...tools.commands[0], input: { type: 'number', minimum: 0.5, maximum: 1.75 } }] } })).status).toBe(409);
});
it('returns structured 400 for malformed canonical records at untrusted request boundaries', async () => {
  const page = await createTestPage({ application: { id: appId } }), publisher = await createSigningIdentity();
  const response = await page.api('POST', 'application', { executionManifestDigest, executionProfile: 'events', publisherKeys: [publisher.publicKey], requestedFinality: { record: '00' } });
  expect(response.status, 'malformed requested finality is client input, not internal corruption').toBe(400);
  await prepare(page, publisher);
  const owner = await createSigningIdentity(); await enroll(page.ownerApi, owner, appId, await epochKeyCommitment(appId, 0, crypto.getRandomValues(new Uint8Array(32))));
  for (const [path, input] of [['peers/enrollment', { action: 'enroll', proof: { record: '00' } }], ['peers/enrollment', { action: 'membership', bundle: { record: '00' } }], ['peers/participant', { record: '00' }]] as const) {
    const response = await page.ownerApi('POST', path, input);
    expect(response.status, path).toBe(400);
    expect((await response.json<any>()).error.code).toBe('authority_record_invalid');
  }
});

it('does not relabel persisted authority corruption as malformed caller input', async () => {
  const handle = await create({ application: { id: appId } }), publisher = await createSigningIdentity(), owner = await createSigningIdentity();
  await body(await api(handle, 'POST', 'application', { executionManifestDigest, executionProfile: 'events', publisherKeys: [publisher.publicKey] }));
  const send = (method: string, path: string, input?: unknown) => req(`${handle.page_url}_tendril/${path}`, { method, headers: { ...ownerHeaders(handle.page_url), 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  await enroll(send, owner, appId, await epochKeyCommitment(appId, 0, crypto.getRandomValues(new Uint8Array(32))));
  await inDO(handle.id, t => t.db.set('application_authority', { record: '00' }));
  // This action must verify persisted authority before inspecting the new bundle.
  const response = await send('POST', 'peers/enrollment', { action: 'membership', bundle: { record: '7b7d' } });
  expect(response.status).toBe(500);
  expect((await response.json<any>()).error.code).not.toBe('authority_record_invalid');
});

it('admits only signed control actions, never raw or encoded application programs', async () => {
  const page = await createTestPage({ application: { id: appId } }); await prepare(page);
  const owner = await createSigningIdentity(), key = crypto.getRandomValues(new Uint8Array(32));
  await enroll(page.ownerApi, owner, appId, await epochKeyCommitment(appId, 0, key));
  const read = await signParticipantRequest({ applicationId: appId, requestId: 'read-authority', action: 'authority.read' }, owner);
  const response = await body(await page.ownerApi('POST', 'peers/participant', authorityRecord(encodeRecord(read))));
  expect(decodeRecord<any>(authorityRecordBytes(response)).authority.descriptor.payload.applicationId).toBe(appId);
  expect((await page.ownerApi('POST', 'peers/participant', { program: 'host-must-not-execute-this' })).status).toBe(400);
  const forbidden = await signParticipantRequest({ applicationId: appId, requestId: 'forbidden-data', action: 'data.submit' as any }, owner);
  expect((await page.ownerApi('POST', 'peers/participant', authorityRecord(encodeRecord(forbidden)))).status).toBe(403);
  const extra = await signParticipantRequest({ applicationId: appId, requestId: 'smuggled-program', action: 'authority.read', program: 'not a control field' } as any, owner);
  expect((await page.ownerApi('POST', 'peers/participant', authorityRecord(encodeRecord(extra)))).status).toBe(400);
});
it('verifies full historical authority when reading finality, deduplicates evidence and rejects a revoked finalizer', async () => {
  const page = await createTestPage({ application: { id: appId } }), publisher = await createSigningIdentity(), owner = await createSigningIdentity();
  await body(await page.api('POST', 'application', { executionManifestDigest, executionProfile: 'events', publisherKeys: [publisher.publicKey], requestedFinality: { kind: 'browser-signed-frontier' } }));
  const metadata = await enroll(page.ownerApi, owner, appId, await epochKeyCommitment(appId, 0, crypto.getRandomValues(new Uint8Array(32))));
  const bundle = decodeRecord<any>(authorityRecordBytes(metadata.authority)), descriptor = bundle.descriptor.payload;
  const head = await recordDigest(bundle.memberships[0]); let requests = 0;
  const exchange = async (action: 'finality.read' | 'finality.publish', proof?: any) => {
    const request = await signParticipantRequest({ applicationId: appId, requestId: `finality-${requests++}`, action, ...(proof ? { proof } : {}) }, owner);
    return page.ownerApi('POST', 'peers/participant', authorityRecord(encodeRecord(request)));
  };
  for (const scope of [descriptor.finalityPolicy.scopes[0].id, head]) {
    const statement = { applicationId: appId, policyDigest: await finalityPolicyDigest(descriptor.finalityPolicy), authorityHead: head, scope, sequence: 0, previous: null, inclusions: [], closedThroughMs: 10n, blockers: [] };
    const proof = { statement, signatures: [await signFinalityStatement(statement, owner)] };
    expect((await exchange('finality.publish', proof)).status).toBe(200);
    expect((await exchange('finality.publish', proof)).status).toBe(200);
  }
  const first = decodeRecord<any>(authorityRecordBytes(await body(await exchange('finality.read'))));
  expect(first.proofs).toHaveLength(2);
  await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'grant', requestId: 'revoke-finalizer', expectedMembershipId: head, authorTimeAfterMs: '11', grant: { publicKey: owner.publicKey, reader: true, writer: true, administrator: true, publisher: false, finalizer: false } }));
  const statement = { ...first.proofs[0].statement, sequence: 1, previous: await recordDigest(first.proofs[0].statement), closedThroughMs: 12n };
  expect((await exchange('finality.publish', { statement, signatures: [await signFinalityStatement(statement, owner)] })).status).toBe(403);
  const retained = decodeRecord<any>(authorityRecordBytes(await body(await exchange('finality.read'))));
  expect(retained.proofs).toEqual(first.proofs);
});
