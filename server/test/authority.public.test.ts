import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  createSigningIdentity, epochKeyCommitment, encodeRecord, decodeRecord, signEnrollmentRequest, signPublicationManifest, verifyAuthorityBundle,
  recordDigest, signParticipantRequest, signFinalityStatement, finalityPolicyDigest, signAppDescriptor, signMembership, verifyHostAttestation,
  signRecord, bytesToHex, type AuthorityBundle, type Membership, type SignedHostAttestation, type SigningIdentity, type FinalityPolicy, type PageInvite,
} from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import { createTestPage } from './public-fixture';
import { create, api, req, inDO, ownerHeaders, base64urlKey, testWrapKey, joinAccountAgent, grantAgent, BASE } from './helpers';
import { requireHostAttestationIdentity } from '../src/host-attestation';

const appId = '51'.repeat(32), executionManifestDigest = '73'.repeat(32);
const hostKey = JSON.parse(env.HOST_ATTESTATION_KEY!).publicKey as string;
type Send = (method: string, path: string, input?: unknown) => Promise<Response>;
type Page = Awaited<ReturnType<typeof createTestPage>>;
interface Device { identity: SigningIdentity; wrapKey: string }
const rec = (value: unknown) => authorityRecord(encodeRecord(value));
const dec = <T = any>(value: unknown): T => decodeRecord<T>(authorityRecordBytes(value));
async function body(response: Response): Promise<any> { const value = await response.json(); if (!response.ok) throw Error(`${response.status}: ${JSON.stringify(value)}`); return value; }
async function failure(response: Response): Promise<{ status: number; code: string }> { return { status: response.status, code: ((await response.json()) as any).error?.code }; }
const device = async (): Promise<Device> => ({ identity: await createSigningIdentity(), wrapKey: testWrapKey() });
const enrollment = (send: Send) => (input: unknown) => send('POST', 'peers/enrollment', input);

async function prepare(send: Send, suppliedPublisher?: SigningIdentity, extra: Record<string, unknown> = {}) {
  const publisher = suppliedPublisher ?? await createSigningIdentity();
  const configuration = { executionManifestDigest, executionProfile: 'events', publisherKeys: [publisher.publicKey], ...extra };
  return { configuration, metadata: await body(await send('POST', 'application', configuration)), publisher };
}
/** Challenge + key proof, as a browser device does. Returns the raw enroll response. */
async function enrollRaw(send: Send, member: Device, invite?: { inviteId: string; secret: string }, alter?: (challenge: string) => string): Promise<Response> {
  const challenge = await body(await send('POST', 'peers/enrollment', { action: 'challenge', publicKey: member.identity.publicKey }));
  const proof = await signEnrollmentRequest({ applicationId: appId, publicKey: member.identity.publicKey, wrapKey: member.wrapKey, challenge: alter ? alter(challenge.challenge) : challenge.challenge }, member.identity);
  return send('POST', 'peers/enrollment', { action: 'enroll', proof: rec(proof), ...(invite ? { invite } : {}) });
}
async function enroll(send: Send, member: Device, invite?: { inviteId: string; secret: string }): Promise<SignedHostAttestation> {
  return dec<SignedHostAttestation>((await body(await enrollRaw(send, member, invite))).attestation);
}
interface GenesisOptions { accounts: string[]; hostKey?: string; signer?: SigningIdentity; finalityPolicy?: FinalityPolicy; finalizer?: boolean; mode?: 'attested' | 'strict' }
async function genesis(root: Device, options: GenesisOptions): Promise<AuthorityBundle> {
  const signer = options.signer ?? root.identity, finalityPolicy = options.finalityPolicy ?? { kind: 'none' };
  const descriptor = await signAppDescriptor({ applicationId: appId, rootPrincipal: root.identity.publicKey, authorityPublicKey: signer.publicKey, executionManifestDigest, finalityPolicy }, signer);
  const membership = await signMembership({ applicationId: appId, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0,
    epochKeyDigest: await epochKeyCommitment(appId, 0, crypto.getRandomValues(new Uint8Array(32))),
    members: [{ publicKey: root.identity.publicKey, wrapKey: root.wrapKey, reader: true, writer: true, administrator: true, publisher: false, finalizer: options.finalizer ?? false }],
    admission: { mode: options.mode ?? 'attested', hostKey: options.hostKey ?? hostKey, accounts: options.accounts, grant: { reader: true, writer: true, administrator: true } }, admitted: [], invites: [] }, signer);
  return { descriptor, memberships: [membership] };
}
/** One member-signed revision on top of the bundle's head. */
async function extend(bundle: AuthorityBundle, signer: SigningIdentity, change: (prior: Membership) => Partial<Membership>, at?: bigint): Promise<AuthorityBundle> {
  const head = bundle.memberships.at(-1)!, prior = head.payload, floor = prior.authorTimeAfterMs + 1n;
  const next = await signMembership({ ...prior, revision: prior.revision + 1, previous: await recordDigest(head), admitted: [],
    authorTimeAfterMs: at !== undefined && at > floor ? at : floor, ...change(prior) }, signer);
  return { descriptor: bundle.descriptor, memberships: [...bundle.memberships, next] };
}
/** An attested (or invited) admission exactly as any reader member may sign it. */
function admit(bundle: AuthorityBundle, signer: SigningIdentity, attestation: SignedHostAttestation, grant = { reader: true, writer: true, administrator: true }, via: 'attested' | 'invited' = 'attested') {
  return extend(bundle, signer, prior => ({
    members: [...prior.members, { publicKey: attestation.payload.publicKey, wrapKey: attestation.payload.wrapKey, ...grant, publisher: false, finalizer: false }],
    admitted: [{ publicKey: attestation.payload.publicKey, via, attestation }],
  }), attestation.payload.issuedAt);
}
async function invite(bundle: AuthorityBundle, root: SigningIdentity, binding: PageInvite['binding'], extra: Partial<PageInvite> = {}) {
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32))), inviteId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const secretDigest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(secret.match(/../g)!, byte => parseInt(byte, 16)))));
  const entry: PageInvite = { inviteId, role: 'writer', binding, expiresAt: BigInt(Date.now() + 86_400_000), secretDigest, revoked: false, ...extra };
  return { bundle: await extend(bundle, root, prior => ({ invites: [...prior.invites, entry] })), redemption: { inviteId, secret } };
}
/** A prepared, claimed page whose owner browser device is the genesis root. */
async function ownerRooted(page: Page, options: Partial<GenesisOptions> = {}) {
  const root = await device(), metadata = await body(await page.ownerApi('GET', 'application'));
  const bundle = await genesis(root, { accounts: metadata.admissionAccounts, ...options });
  await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'initialize', bundle: rec(bundle) }));
  return { root, bundle };
}

describe('host attestation key and published metadata', () => {
  it('publishes the attestation key in discovery, the service descriptor and application metadata', async () => {
    const known = await body(await req(`${BASE}/.well-known/tendriller.json`, { anonymous: true }));
    expect(known.attestationKey).toBe(hostKey);
    expect((await body(await req(`${BASE}/api/service`, { anonymous: true }))).attestationKey).toBe(hostKey);
    const readiness = await body(await req(`${BASE}/api/readiness`, { anonymous: true }));
    expect(readiness.attestation).toMatchObject({ available: true, key: hostKey, code: null });
    const page = await createTestPage({ application: { id: appId } });
    const metadata = await body(await page.api('GET', 'application'));
    expect(metadata.hostAttestationKey).toBe(hostKey);
    expect(metadata).not.toHaveProperty('provisioningRequired');
    const owner = await inDO((await body(await page.api('GET', ''))).id, t => t.db.get<string>('owner_account', ''));
    expect(metadata.admissionAccounts).toEqual([owner, expect.stringMatching(/^email:owner-.*@example\.com$/)]);
    const unclaimed = await create({ claim: false, application: { id: appId } });
    expect((await body(await api(unclaimed, 'GET', 'application'))).admissionAccounts).toEqual([`email:${await inDO(unclaimed.id, t => t.db.get<string>('intended_owner', ''))}`]);
  });
  it('fails closed with attestation_unconfigured without a valid secret', async () => {
    for (const secret of [undefined, '{}', JSON.stringify({ publicKey: '00'.repeat(32), privateKey: JSON.parse(env.HOST_ATTESTATION_KEY!).privateKey })])
      await expect(requireHostAttestationIdentity({ ...env, HOST_ATTESTATION_KEY: secret } as typeof env)).rejects.toMatchObject({ status: 503, code: 'attestation_unconfigured' });
  });
});

describe('browser device enrollment', () => {
  it('signs exactly the attested fields with the published key, before any authority exists', async () => {
    const page = await createTestPage({ application: { id: appId } }); await prepare(page.ownerApi);
    const member = await device(), signed = await enroll(page.ownerApi, member);
    const pageId = (await body(await page.api('GET', ''))).id as string;
    const owner = await inDO(pageId, t => t.db.get<string>('owner_account', ''));
    const payload = await verifyHostAttestation(signed, { hostKey, applicationId: appId, pageId });
    expect(signed.signer).toBe(hostKey);
    expect(Object.keys(payload).sort()).toEqual(['accountId', 'applicationId', 'email', 'expiresAt', 'inviteId', 'issuedAt', 'label', 'nonce', 'pageId', 'publicKey', 'subject', 'wrapKey']);
    expect(payload).toMatchObject({ subject: 'device', pageId, applicationId: appId, accountId: owner, publicKey: member.identity.publicKey, wrapKey: member.wrapKey, label: 'Browser device', inviteId: null });
    expect(payload.email).toMatch(/^owner-.*@example\.com$/);
    expect(payload.expiresAt - payload.issuedAt).toBe(3_600_000n);
    expect(payload.nonce).toMatch(/^[0-9a-f]{64}$/);
    for (const forged of [{ ...payload, accountId: 'someone-else' }, { ...payload, wrapKey: testWrapKey() }, { ...payload, expiresAt: payload.expiresAt + 1n }])
      await expect(verifyHostAttestation({ ...signed, payload: forged }, { hostKey, applicationId: appId })).rejects.toThrow();
    const admissions = await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'admissions' }));
    expect(admissions.pending.map((record: unknown) => dec<SignedHostAttestation>(record).payload).filter((item: any) => item.subject === 'device').map((item: any) => item.publicKey)).toEqual([member.identity.publicKey]);
    expect(admissions.wrapped).toEqual({});
    expect((await body(await page.ownerApi('GET', 'application'))).authority).toBeNull();
  });
  it('rejects unauthenticated, display, wrong-origin and challenge-mismatched enrollment; agents cannot enroll browser keys', async () => {
    const handle = await create({ application: { id: appId } }); await prepare((method, path, input) => api(handle, method, path, input));
    const member = await device(), endpoint = `${handle.page_url}_tendril/peers/enrollment`, json = { 'Content-Type': 'application/json' };
    const challenge = { action: 'challenge', publicKey: member.identity.publicKey };
    expect((await req(endpoint, { method: 'POST', anonymous: true, headers: { ...json, Origin: new URL(handle.page_url).origin }, body: JSON.stringify(challenge) })).status).toBe(401);
    expect((await req(endpoint, { method: 'POST', headers: { ...ownerHeaders(handle.page_url), ...json, Origin: 'https://evil.example' }, body: JSON.stringify(challenge) })).status).toBe(403);
    const display = await inDO(handle.id, async t => t.renderLink(await t.createLink('display', 'wall', null)));
    const displayed = await req(`${display.url}_tendril/peers/enrollment`, { method: 'POST', anonymous: true, headers: { ...json, Origin: new URL(display.url).origin }, body: JSON.stringify(challenge) });
    expect(displayed.status).toBe(403);
    expect((await api(handle, 'POST', 'peers/enrollment', challenge)).status).toBe(403);
    const send: Send = (method, path, input) => req(`${handle.page_url}_tendril/${path}`, { method, headers: { ...ownerHeaders(handle.page_url), ...json }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    expect(await failure(await enrollRaw(send, member, undefined, value => value + 'x'))).toEqual({ status: 403, code: 'enrollment_challenge_invalid' });
    // A proof bound to another key's challenge is not this key's proof.
    const other = await device(), otherChallenge = await body(await send('POST', 'peers/enrollment', { action: 'challenge', publicKey: other.identity.publicKey }));
    const crossed = await signEnrollmentRequest({ applicationId: appId, publicKey: member.identity.publicKey, wrapKey: member.wrapKey, challenge: otherChallenge.challenge }, member.identity);
    expect(await failure(await send('POST', 'peers/enrollment', { action: 'enroll', proof: rec(crossed) }))).toEqual({ status: 403, code: 'enrollment_challenge_invalid' });
    expect((await enrollRaw(send, member)).status).toBe(200);
    expect(await inDO(handle.id, t => t.db.get('application_device_accounts', null))).toBeNull();
  });
});

describe('genesis initialization', () => {
  it('stores a member-signed genesis from the owner browser and rejects every unpinned variant', async () => {
    const page = await createTestPage({ application: { id: appId } }); await prepare(page.ownerApi);
    const root = await device(), metadata = await body(await page.ownerApi('GET', 'application')), accounts = metadata.admissionAccounts;
    const initialize = (bundle: AuthorityBundle, send: Send = page.ownerApi) => send('POST', 'peers/enrollment', { action: 'initialize', bundle: rec(bundle) });
    const outsider = await createSigningIdentity();
    expect(await failure(await initialize(await genesis(root, { accounts, hostKey: outsider.publicKey })))).toEqual({ status: 400, code: 'admission_host_key_mismatch' });
    expect(await failure(await initialize(await genesis(root, { accounts: ['email:someone@example.com'] })))).toEqual({ status: 400, code: 'admission_accounts_mismatch' });
    expect(await failure(await initialize(await genesis(root, { accounts, signer: outsider })))).toEqual({ status: 400, code: 'authority_root_mismatch' });
    expect(await failure(await initialize(await genesis(root, { accounts, finalityPolicy: { kind: 'signed-frontier', signer: root.identity.publicKey, scopes: [{ id: '01'.repeat(32), authorTimeAfterMs: -1n }] } })))).toEqual({ status: 400, code: 'authority_finality_mismatch' });
    const guest = await page.participant();
    expect(await failure(await initialize(await genesis(root, { accounts }), guest.api))).toEqual({ status: 403, code: 'owner_required' });
    const bundle = await genesis(root, { accounts: [...accounts, 'email:extra@example.com'] });
    const stored = await body(await initialize(bundle));
    await verifyAuthorityBundle(dec(stored.authority));
    expect(dec(stored.authority)).toEqual(bundle);
    expect((await body(await initialize(bundle))).authority).toEqual(stored.authority);
    expect(await failure(await initialize(await genesis(root, { accounts })))).toEqual({ status: 409, code: 'application_initialized' });
    // The host has no authority identity; every stored signature is a member's.
    expect(await inDO((await body(await page.api('GET', ''))).id, t => t.db.one("SELECT 1 FROM participant_records WHERE key='authority/identity'"))).toBeNull();
    expect([dec<AuthorityBundle>(stored.authority).descriptor.signer, ...dec<AuthorityBundle>(stored.authority).memberships.map(item => item.signer)]).toEqual([root.identity.publicKey, root.identity.publicKey]);
  });
  it('lets only the agent whose registered key is the root initialize, including before claim', async () => {
    const agent = await device();
    const handle = await create({ claim: false, application: { id: appId }, agentKeys: { publicKey: base64urlKey(agent.identity.publicKey), wrapKey: agent.wrapKey } });
    const send: Send = (method, path, input) => api(handle, method, path, input);
    const unprepared = await genesis(agent, { accounts: (await body(await send('GET', 'application'))).admissionAccounts });
    expect(await failure(await send('POST', 'peers/enrollment', { action: 'initialize', bundle: rec(unprepared) }))).toEqual({ status: 409, code: 'application_unprepared' });
    await prepare(send);
    const accounts = (await body(await send('GET', 'application'))).admissionAccounts as string[];
    expect(accounts).toEqual([expect.stringMatching(/^email:owner-/)]);
    const stranger = await device();
    expect(await failure(await send('POST', 'peers/enrollment', { action: 'initialize', bundle: rec(await genesis(stranger, { accounts })) }))).toEqual({ status: 403, code: 'initializer_root_required' });
    const root = await genesis(agent, { accounts });
    expect((await body(await send('POST', 'peers/enrollment', { action: 'initialize', bundle: rec(root) }))).authority).toEqual(rec(root));
  });
});

describe('agent attestation', () => {
  it('attests the creator and newly granted agents automatically, and on enroll-agent', async () => {
    const creatorKeys = await device();
    const handle = await create({ application: { id: appId }, agentKeys: { publicKey: base64urlKey(creatorKeys.identity.publicKey), wrapKey: creatorKeys.wrapKey } });
    const send: Send = (method, path, input) => api(handle, method, path, input);
    const pending = async () => (await body(await send('POST', 'peers/enrollment', { action: 'admissions' }))).pending.map((record: unknown) => dec<SignedHostAttestation>(record).payload);
    const owner = handle.account!;
    expect(await pending()).toEqual([expect.objectContaining({ subject: 'agent', accountId: owner, publicKey: creatorKeys.identity.publicKey, wrapKey: creatorKeys.wrapKey, label: '@maintainer', inviteId: null })]);
    const enrolled = await body(await send('POST', 'peers/enrollment', { action: 'enroll-agent' }));
    const signed = dec<SignedHostAttestation>(enrolled.attestation);
    expect(await verifyHostAttestation(signed, { hostKey, applicationId: appId, pageId: handle.id })).toMatchObject({ subject: 'agent', accountId: owner, email: expect.stringMatching(/^owner-/) });
    const helperKeys = await device();
    const helper = await joinAccountAgent(handle, 'helper', '', { publicKey: base64urlKey(helperKeys.identity.publicKey), wrapKey: helperKeys.wrapKey });
    await grantAgent(handle, helper);
    expect((await pending()).map((item: any) => [item.publicKey, item.label])).toEqual(expect.arrayContaining([[helperKeys.identity.publicKey, '@helper'], [creatorKeys.identity.publicKey, '@maintainer']]));
    // A browser cannot request agent evidence.
    expect(await failure(await req(`${handle.page_url}_tendril/peers/enrollment`, { method: 'POST', headers: { ...ownerHeaders(handle.page_url), 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'enroll-agent' }) })))
      .toEqual({ status: 403, code: 'agent_required' });
  });
  it('binds an unclaimed page agent to the intended owner placeholder', async () => {
    const handle = await create({ claim: false, application: { id: appId } });
    const { attestation } = await body(await api(handle, 'POST', 'peers/enrollment', { action: 'enroll-agent' }));
    expect(dec<SignedHostAttestation>(attestation).payload).toMatchObject({ accountId: `pending:${handle.id}`, email: expect.stringMatching(/^owner-.*@example\.com$/) });
  });
  it('requires a wrap key at every registration path', async () => {
    const response = await req('/api/agents', { method: 'POST', anonymous: true, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.18.40.1' },
      body: JSON.stringify({ owner: 'wrap-owner@example.com', handle: 'nowrap', publicKey: base64urlKey('ab'.repeat(32)) }) });
    expect(await failure(response)).toEqual({ status: 400, code: 'invalid_wrap_key' });
  });
});

describe('membership extension', () => {
  it('admits attested devices by any reader, rejects host-unsignable revisions and stale heads, and prunes pending evidence', async () => {
    const page = await createTestPage({ application: { id: appId } }); await prepare(page.ownerApi);
    const { root, bundle } = await ownerRooted(page);
    const membership = (value: AuthorityBundle) => page.ownerApi('POST', 'peers/enrollment', { action: 'membership', bundle: rec(value) });
    const laptop = await device(), laptopEvidence = await enroll(page.ownerApi, laptop);
    // The root administrator may choose any grant: the laptop joins as a non-administrator editor.
    const one = await admit(bundle, root.identity, laptopEvidence, { reader: true, writer: true, administrator: false });
    await body(await membership(one));
    expect((await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'admissions' }))).pending.filter((record: unknown) => dec<SignedHostAttestation>(record).payload.publicKey === laptop.identity.publicKey)).toEqual([]);
    // A non-administrator reader may append another attested device with exactly the policy grant (administrator by default)...
    const phone = await device(), phoneEvidence = await enroll(page.ownerApi, phone);
    expect(one.memberships.at(-1)!.payload.admission.grant).toEqual({ reader: true, writer: true, administrator: true });
    const two = await admit(one, laptop.identity, phoneEvidence);
    // ...but not any other grant, and a non-member signer can never extend the chain.
    expect((await membership(await admit(one, laptop.identity, phoneEvidence, { reader: true, writer: true, administrator: false }))).status).toBe(403);
    expect((await membership(await admit(one, laptop.identity, phoneEvidence, { reader: true, writer: false, administrator: true }))).status).toBe(403);
    const stranger = await createSigningIdentity();
    expect((await membership(await extend(one, stranger, prior => ({ members: [...prior.members, { publicKey: stranger.publicKey, wrapKey: testWrapKey(), reader: true, writer: true, administrator: true, publisher: false, finalizer: false }] })))).status).toBe(403);
    const forged = await extend(one, root.identity, prior => ({ members: prior.members.map(member => ({ ...member, writer: false })) }));
    const tampered = { ...forged, memberships: [...forged.memberships.slice(0, -1), { ...forged.memberships.at(-1)!, payload: { ...forged.memberships.at(-1)!.payload, members: [...forged.memberships.at(-1)!.payload.members, { publicKey: stranger.publicKey, wrapKey: null, reader: true, writer: true, administrator: true, publisher: false, finalizer: false }] } }] };
    expect((await membership(tampered)).status).toBe(403);
    expect(await failure(await membership(await extend(two, root.identity, () => ({}))))).toEqual({ status: 400, code: 'membership_extension_required' });
    await body(await membership(two));
    expect(await failure(await membership(forged))).toEqual({ status: 409, code: 'membership_head_changed' });
    const stored = dec<AuthorityBundle>((await body(await page.ownerApi('GET', 'application'))).authority);
    expect(stored.memberships.map(item => item.signer)).toEqual([root.identity.publicKey, root.identity.publicKey, laptop.identity.publicKey]);
    expect(stored.memberships.flatMap(item => item.signer)).not.toContain(hostKey);
  });
});

describe('invites', () => {
  async function invited(binding: PageInvite['binding'], extra: Partial<PageInvite> = {}) {
    const page = await createTestPage({ application: { id: appId } }); await prepare(page.ownerApi);
    const { root, bundle } = await ownerRooted(page);
    const issued = await invite(bundle, root.identity, binding, extra);
    await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'membership', bundle: rec(issued.bundle) }));
    return { page, root, ...issued };
  }
  it('redeems an open invite once per account, idempotently for that account, and the redeemer can be admitted by any reader', async () => {
    const { page, root, bundle, redemption } = await invited({ kind: 'open' });
    const guest = await page.participant(), other = await page.participant(), first = await device();
    const evidence = await enroll(guest.api, first, redemption);
    expect(evidence.payload).toMatchObject({ accountId: guest.account, inviteId: redemption.inviteId, email: `${guest.account}@example.test` });
    expect((await enroll(guest.api, await device(), redemption)).payload.inviteId).toBe(redemption.inviteId);
    expect(await failure(await enrollRaw(other.api, await device(), redemption))).toEqual({ status: 409, code: 'invite_redeemed' });
    const admitted = await admit(bundle, root.identity, evidence, { reader: true, writer: true, administrator: false }, 'invited');
    await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'membership', bundle: rec(admitted) }));
  });
  it('rejects a bad secret, another email, an exhausted public invite, and expired or revoked invites', async () => {
    const bound = await invited({ kind: 'email', email: 'invitee@example.com' });
    const guest = await bound.page.participant();
    expect(await failure(await enrollRaw(guest.api, await device(), { ...bound.redemption, secret: 'ff'.repeat(32) }))).toEqual({ status: 403, code: 'invite_secret_invalid' });
    expect(await failure(await enrollRaw(guest.api, await device(), bound.redemption))).toEqual({ status: 403, code: 'invite_email_mismatch' });
    expect(await failure(await enrollRaw(guest.api, await device(), { inviteId: 'ab'.repeat(16), secret: 'ab'.repeat(32) }))).toEqual({ status: 404, code: 'invite_unknown' });
    const open = await invited({ kind: 'public', max: 2 });
    for (let index = 0; index < 2; index++) await enroll((await open.page.participant()).api, await device(), open.redemption);
    expect(await failure(await enrollRaw((await open.page.participant()).api, await device(), open.redemption))).toEqual({ status: 409, code: 'invite_exhausted' });
    const expiring = await invited({ kind: 'open' }, { expiresAt: BigInt(Date.now() + 60_000) });
    await expiring.page.advance(120_000);
    expect(await failure(await enrollRaw((await expiring.page.participant()).api, await device(), expiring.redemption))).toEqual({ status: 410, code: 'invite_expired' });
    const revoked = await invited({ kind: 'open' }, { revoked: true });
    expect(await failure(await enrollRaw((await revoked.page.participant()).api, await device(), revoked.redemption))).toEqual({ status: 410, code: 'invite_revoked' });
  });
  it('accepts an email-bound invite for the account that verified that address', async () => {
    const page = await createTestPage({ application: { id: appId } }); await prepare(page.ownerApi);
    const { root, bundle } = await ownerRooted(page), guest = await page.participant();
    const issued = await invite(bundle, root.identity, { kind: 'email', email: `${guest.account}@example.test` });
    await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'membership', bundle: rec(issued.bundle) }));
    expect((await enroll(guest.api, await device(), issued.redemption)).payload.email).toBe(`${guest.account}@example.test`);
  });
});

describe('key wraps', () => {
  it('accepts wraps only between reader members at the signed wrap key, keeps four per recipient and reports coverage', async () => {
    const page = await createTestPage({ application: { id: appId } }); await prepare(page.ownerApi);
    const { root, bundle } = await ownerRooted(page);
    const laptop = await device(), one = await admit(bundle, root.identity, await enroll(page.ownerApi, laptop));
    await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'membership', bundle: rec(one) }));
    const wrap = async (signer: SigningIdentity, recipient: string, wrapKey: string, epochs: number[]) => rec(await signRecord('key-wrap', {
      applicationId: appId, descriptorId: await recordDigest(one.descriptor), membershipId: await recordDigest(one.memberships.at(-1)), recipient, wrapKey, epochs,
      authority: one, encrypted: { encapsulatedKey: new Uint8Array(32), ciphertext: new Uint8Array(48) } }, signer));
    const send = (value: unknown) => page.ownerApi('POST', 'peers/enrollment', { action: 'wrap', wrap: value });
    const stranger = await device();
    expect(await failure(await send(await wrap(stranger.identity, laptop.identity.publicKey, laptop.wrapKey, [0])))).toEqual({ status: 403, code: 'key_wrap_member_required' });
    expect(await failure(await send(await wrap(root.identity, stranger.identity.publicKey, stranger.wrapKey, [0])))).toEqual({ status: 403, code: 'key_wrap_member_required' });
    expect(await failure(await send(await wrap(root.identity, laptop.identity.publicKey, stranger.wrapKey, [0])))).toEqual({ status: 409, code: 'key_wrap_recipient_mismatch' });
    const forged = dec(await wrap(root.identity, laptop.identity.publicKey, laptop.wrapKey, [0]));
    expect((await send(rec({ ...forged, payload: { ...forged.payload, epochs: [0, 1] } }))).status).toBe(403);
    for (const epochs of [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3, 4]]) await body(await send(await wrap(root.identity, laptop.identity.publicKey, laptop.wrapKey, epochs)));
    const delivered = await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'wraps', recipient: laptop.identity.publicKey }));
    expect(delivered.wraps.map((record: unknown) => Math.max(...dec(record).payload.epochs))).toEqual([4, 3, 2, 1]);
    expect((await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'admissions' }))).wrapped).toEqual({ [laptop.identity.publicKey]: 4 });
    expect((await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'wraps', recipient: root.identity.publicKey }))).wraps).toEqual([]);
    // Removing a member drops its mailbox.
    const removed = await extend(one, root.identity, prior => ({ members: prior.members.filter(member => member.publicKey !== laptop.identity.publicKey), epoch: 1,
      epochKeyDigest: '00'.repeat(32) }));
    await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'membership', bundle: rec(removed) }));
    expect((await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'wraps', recipient: laptop.identity.publicKey }))).wraps).toEqual([]);
  });
});

describe('publication and participant control', () => {
  it('prepares and publishes signed UI before any data key is known', async () => {
    const page = await createTestPage({ application: { id: appId } }), { metadata, publisher } = await prepare(page.api);
    expect(metadata.authority).toBeNull();
    const bytes = new TextEncoder().encode('<!doctype html><html><title>Browser first</title><body>Ready</body></html>');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    const publication = await signPublicationManifest({ applicationId: appId, membershipId: metadata.publicationAuthority.grantId, author: publisher.publicKey, operationId: 'pre-owner-publication', revision: 0, previous: null, executionManifestDigest, entry: 'index.html', files: [{ path: 'index.html', hash, size: bytes.length, type: 'text/html' }] }, publisher);
    const receipt = await body(await page.api('POST', 'peers/publication', { action: 'publish', publication, assets: [{ hash, bytes: btoa(String.fromCharCode(...bytes)) }] }));
    expect(receipt.publication.id).toBe(publication.id);
    await page.restart();
    expect((await body(await page.api('POST', 'peers/publication', { action: 'read' }))).publication.id).toBe(publication.id);
    const authored = await page.asset();
    expect(authored.status).toBe(200);
    expect(await authored.text()).toContain('Browser first');
  });
  it('a prepared application reports configured, is not downgradable to ad hoc while an unprepared one is', async () => {
    const page = await createTestPage({ application: { id: appId } });
    expect((await body(await page.api('GET', ''))).configured).toBe(false);
    expect((await page.api('PATCH', '', { lifetime: 'resident' })).status).toBe(200);
    expect((await page.api('PATCH', '', { lifetime: 'ad_hoc' })).status).toBe(200);
    await prepare(page.api);
    expect((await body(await page.api('GET', ''))).configured).toBe(true);
    expect(await failure(await page.api('PATCH', '', { lifetime: 'ad_hoc' }))).toEqual({ status: 409, code: 'application_requires_resident' });
  });
  it('admits only signed control actions from members, never raw or encoded application programs', async () => {
    const page = await createTestPage({ application: { id: appId } }); await prepare(page.api);
    const { root } = await ownerRooted(page);
    const read = await signParticipantRequest({ applicationId: appId, requestId: 'read-authority', action: 'authority.read' }, root.identity);
    expect(dec(await body(await page.ownerApi('POST', 'peers/participant', rec(read)))).authority.descriptor.payload.applicationId).toBe(appId);
    const outsider = await signParticipantRequest({ applicationId: appId, requestId: 'outsider', action: 'authority.read' }, await createSigningIdentity());
    expect(await failure(await page.ownerApi('POST', 'peers/participant', rec(outsider)))).toEqual({ status: 403, code: 'participant_member_required' });
    expect((await page.ownerApi('POST', 'peers/participant', { program: 'host-must-not-execute-this' })).status).toBe(400);
    const forbidden = await signParticipantRequest({ applicationId: appId, requestId: 'forbidden-data', action: 'data.submit' as any }, root.identity);
    expect((await page.ownerApi('POST', 'peers/participant', rec(forbidden))).status).toBe(403);
    const extra = await signParticipantRequest({ applicationId: appId, requestId: 'smuggled-program', action: 'authority.read', program: 'not a control field' } as any, root.identity);
    expect((await page.ownerApi('POST', 'peers/participant', rec(extra))).status).toBe(400);
  });
  it('verifies full historical authority when reading finality, deduplicates evidence and rejects a revoked finalizer', async () => {
    const page = await createTestPage({ application: { id: appId } });
    await prepare(page.api, undefined, { requestedFinality: { kind: 'browser-signed-frontier' } });
    const owner = await device(), accounts = (await body(await page.ownerApi('GET', 'application'))).admissionAccounts;
    const bundle = await genesis(owner, { accounts, finalizer: true, finalityPolicy: { kind: 'signed-frontier', signer: owner.identity.publicKey, scopes: [{ id: await recordDigest(['initial-scope', appId]), authorTimeAfterMs: -1n }] } });
    await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'initialize', bundle: rec(bundle) }));
    const descriptor = bundle.descriptor.payload, head = await recordDigest(bundle.memberships[0]); let requests = 0;
    const exchange = async (action: 'finality.read' | 'finality.publish', proof?: any) => {
      const request = await signParticipantRequest({ applicationId: appId, requestId: `finality-${requests++}`, action, ...(proof ? { proof } : {}) }, owner.identity);
      return page.ownerApi('POST', 'peers/participant', rec(request));
    };
    const policy = descriptor.finalityPolicy as Extract<FinalityPolicy, { kind: 'signed-frontier' }>;
    for (const scope of [policy.scopes[0].id, head]) {
      const statement = { applicationId: appId, policyDigest: await finalityPolicyDigest(policy), authorityHead: head, scope, sequence: 0, previous: null, inclusions: [], closedThroughMs: 10n, blockers: [] };
      const proof = { statement, signatures: [await signFinalityStatement(statement, owner.identity)] };
      expect((await exchange('finality.publish', proof)).status).toBe(200);
      expect((await exchange('finality.publish', proof)).status).toBe(200);
    }
    const first = dec(await body(await exchange('finality.read')));
    expect(first.proofs).toHaveLength(2);
    const revoked = await extend(bundle, owner.identity, prior => ({ members: prior.members.map(member => ({ ...member, finalizer: false })) }), 11n);
    await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'membership', bundle: rec(revoked) }));
    const statement = { ...first.proofs[0].statement, sequence: 1, previous: await recordDigest(first.proofs[0].statement), closedThroughMs: 12n };
    expect((await exchange('finality.publish', { statement, signatures: [await signFinalityStatement(statement, owner.identity)] })).status).toBe(403);
    expect(dec(await body(await exchange('finality.read'))).proofs).toEqual(first.proofs);
  });
});

it('rejects invalid finality before freezing configuration and accepts canonical fractional tool bounds idempotently', async () => {
  const page = await createTestPage({ application: { id: appId } }), publisher = await createSigningIdentity();
  const configuration = { executionManifestDigest, executionProfile: 'events', publisherKeys: [publisher.publicKey] };
  for (const requestedFinality of [null, { kind: 'browser-signed-frontier', extra: true }, rec({ kind: 'fixed-validator', validators: [], threshold: 0, scopes: [] })]) {
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
  await prepare(page.api, publisher); await ownerRooted(page);
  for (const [path, input] of [['peers/enrollment', { action: 'enroll', proof: { record: '00' } }], ['peers/enrollment', { action: 'membership', bundle: { record: '00' } }],
    ['peers/enrollment', { action: 'initialize', bundle: { record: '00' } }], ['peers/enrollment', { action: 'wrap', wrap: { record: '00' } }], ['peers/participant', { record: '00' }]] as const) {
    const answer = await page.ownerApi('POST', path, input);
    expect(answer.status, `${path} ${JSON.stringify(input)}`).toBe(400);
    expect((await answer.json<any>()).error.code).toBe('authority_record_invalid');
  }
});
it('does not relabel persisted authority corruption as malformed caller input', async () => {
  const page = await createTestPage({ application: { id: appId } }); await prepare(page.api); await ownerRooted(page);
  await inDO((await body(await page.api('GET', ''))).id, t => t.db.set('application_authority', { record: '00' }));
  const response = await page.ownerApi('POST', 'peers/enrollment', { action: 'membership', bundle: { record: '7b7d' } });
  expect(response.status).toBe(500);
  expect((await response.json<any>()).error.code).not.toBe('authority_record_invalid');
});
