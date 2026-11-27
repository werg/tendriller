import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import quickJsWasm from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import {
  bytesToHex, createLogGenesis, createSigningIdentity, decodeRecord, encodeLogGenesis, encodeRecord,
  encodeSignedOperation, genesisLogId, hexToBytes, signFinalityCheckpoint, signOperationCore, signRecord,
  verifyHostAttestationV2, policyScopeId, computeIncludedSetDigest,
  type FinalityCheckpoint, type FinalityPolicyV2, type ScheduledFinalityEntry, type SigningIdentity,
  type TopicUpdate,
} from '@chronolog/peer-session';
import { TopicKernel, ContentAddressedStore, MemoryBytesStore, seedStandardModules, operationIdDigest } from '@chronolog/peer-session/kernel';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import { PARTICIPANT_REQUEST_DOMAIN } from '../src/peer-participant';
import { createTestPage } from './public-fixture';
import { create, api, req, inDO, ownerHeaders, base64urlKey, testWrapKey, joinAccountAgent, grantAgent, BASE } from './helpers';
import { requireHostAttestationIdentity } from '../src/host-attestation';
import { sha256Hex } from '../src/ids';

const hostKey = JSON.parse(env.HOST_ATTESTATION_KEY!).publicKey as string;
const ENROLLMENT_REQUEST_DOMAIN = 'chronolog/enrollment-request/v2';

type Send = (method: string, path: string, input?: unknown) => Promise<Response>;
type Page = Awaited<ReturnType<typeof createTestPage>>;
interface Device { identity: SigningIdentity; wrapKey: string }
interface ChainFixture {
  logId: string;
  logIdBytes: Uint8Array;
  genesisBytes: Uint8Array;
  casNodes: Array<{ hash: string; bytes: Uint8Array }>;
}

const rec = (value: unknown) => authorityRecord(encodeRecord(value));
const dec = <T = any>(value: unknown): T => decodeRecord<T>(authorityRecordBytes(value));
async function body(response: Response): Promise<any> {
  const value = await response.json();
  if (!response.ok) throw Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
}
async function failure(response: Response): Promise<{ status: number; code: string }> {
  return { status: response.status, code: ((await response.json()) as any).error?.code };
}
const device = async (): Promise<Device> => ({ identity: await createSigningIdentity(), wrapKey: testWrapKey() });

interface SignedHostAttestationV2 {
  readonly payload: {
    readonly subject: string;
    readonly pageId: string;
    readonly applicationId: string;
    readonly accountId: string;
    readonly email: string | null;
    readonly publicKey: string;
    readonly wrapKey: string;
    readonly label: string;
    readonly inviteId: string | null;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly nonce: string;
  };
  readonly signature: string;
}

async function buildGenesis(
  root: Device,
  options: {
    accounts: string[];
    hostKey?: string;
    mode?: 'attested' | 'strict';
    finalitySchedule?: readonly ScheduledFinalityEntry[];
    finalizer?: boolean;
    publisher?: boolean;
    extraMembers?: Array<Record<string, unknown>>;
    salt?: Uint8Array;
  },
): Promise<ChainFixture> {
  const created = await createLogGenesis({
    creator: {
      publicKey: root.identity.publicKey,
      wrapKey: root.wrapKey,
      reader: true,
      writer: true,
      administrator: true,
      publisher: options.publisher ?? true,
      finalizer: options.finalizer ?? false,
    },
    privateLog: true,
    hostPublicKey: options.hostKey ?? hostKey,
    ...(options.finalitySchedule ? { finalitySchedule: options.finalitySchedule } : {}),
    ...(options.salt ? { salt: options.salt } : {}),
  });
  const genesis = structuredClone(created.genesis);
  const perms = genesis.initialTopics.$permissions as any;
  if (options.extraMembers?.length) {
    perms.members = [...perms.members, ...options.extraMembers];
  }
  perms.admission = {
    mode: options.mode ?? 'attested',
    hostKey: options.hostKey ?? hostKey,
    accounts: [...options.accounts],
    grant: { reader: true, writer: true, administrator: true },
    invites: [],
  };
  const genesisBytes = encodeLogGenesis(genesis);
  const logIdBytes = genesisLogId(genesisBytes);
  return {
    logId: bytesToHex(logIdBytes),
    logIdBytes,
    genesisBytes,
    casNodes: created.casNodes.map(n => ({ hash: n.hash, bytes: n.bytes })),
  };
}

async function signControlOp(
  logIdBytes: Uint8Array,
  signer: SigningIdentity,
  updates: readonly TopicUpdate[],
  options: { operationId?: string; authorTimestampMs?: bigint } = {},
) {
  const signed = await signOperationCore({
    version: 1,
    logId: logIdBytes,
    author: hexToBytes(signer.publicKey),
    operationId: options.operationId ?? crypto.randomUUID(),
    authorTimestampMs: options.authorTimestampMs ?? BigInt(Date.now()),
    nonce: crypto.getRandomValues(new Uint8Array(16)),
    visibility: 'public',
    updates,
  }, signer.privateKey);
  const raw = encodeSignedOperation(signed);
  const opId = bytesToHex(operationIdDigest(signed.coreBytes));
  return { signed, raw, opId, record: authorityRecord(raw) };
}

/** Challenge + key proof, as a browser device does. Returns the raw enroll response. */
async function enrollRaw(
  send: Send,
  applicationId: string,
  member: Device,
  invite?: { inviteId: string; secret: string },
  alter?: (challenge: string) => string,
): Promise<Response> {
  const challenge = await body(await send('POST', 'peers/enrollment', { action: 'challenge', publicKey: member.identity.publicKey }));
  const proof = await signRecord(ENROLLMENT_REQUEST_DOMAIN, {
    applicationId,
    publicKey: member.identity.publicKey,
    wrapKey: member.wrapKey,
    challenge: alter ? alter(challenge.challenge) : challenge.challenge,
  }, member.identity);
  return send('POST', 'peers/enrollment', { action: 'enroll', proof: rec(proof), ...(invite ? { invite } : {}) });
}
async function enroll(
  send: Send,
  applicationId: string,
  member: Device,
  invite?: { inviteId: string; secret: string },
): Promise<SignedHostAttestationV2> {
  return dec<SignedHostAttestationV2>((await body(await enrollRaw(send, applicationId, member, invite))).attestation);
}

async function ownerRooted(page: Page, options: Partial<Parameters<typeof buildGenesis>[1]> = {}) {
  const root = await device();
  const metadata = await body(await page.ownerApi('GET', 'application'));
  const fixture = await buildGenesis(root, { accounts: metadata.admissionAccounts, ...options });
  await body(await page.ownerApi('POST', 'peers/enrollment', {
    action: 'initialize',
    genesis: authorityRecord(fixture.genesisBytes),
    casNodes: fixture.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
  }));
  return { root, fixture };
}

async function syncOps(send: Send, ops: Array<{ record: unknown }>, checkpoints: unknown[] = []) {
  return send('POST', 'peers/enrollment', {
    action: 'sync',
    publicOps: ops.map(o => o.record),
    ...(checkpoints.length ? { checkpoints } : {}),
  });
}

describe('host attestation key and published metadata', () => {
  it('publishes the attestation key in discovery, the service descriptor and application metadata', async () => {
    const known = await body(await req(`${BASE}/.well-known/tendriller.json`, { anonymous: true }));
    expect(known.attestationKey).toBe(hostKey);
    expect((await body(await req(`${BASE}/api/service`, { anonymous: true }))).attestationKey).toBe(hostKey);
    const readiness = await body(await req(`${BASE}/api/readiness`, { anonymous: true }));
    expect(readiness.attestation).toMatchObject({ available: true, key: hostKey, code: null });
    const page = await createTestPage();
    const metadata = await body(await page.api('GET', 'application'));
    expect(metadata.hostAttestationKey).toBe(hostKey);
    expect(metadata.genesis).toBeNull();
    const owner = await inDO((await body(await page.api('GET', ''))).id, t => t.db.get<string>('owner_account', ''));
    expect(metadata.admissionAccounts).toEqual([owner, expect.stringMatching(/^email:owner-.*@example\.com$/)]);
    const unclaimed = await create({ claim: false });
    expect((await body(await api(unclaimed, 'GET', 'application'))).admissionAccounts).toEqual([`email:${await inDO(unclaimed.id, t => t.db.get<string>('intended_owner', ''))}`]);
  });

  it('fails closed with attestation_unconfigured without a valid secret', async () => {
    for (const secret of [undefined, '{}', JSON.stringify({ publicKey: '00'.repeat(32), privateKey: JSON.parse(env.HOST_ATTESTATION_KEY!).privateKey })]) {
      await expect(requireHostAttestationIdentity({ ...env, HOST_ATTESTATION_KEY: secret } as typeof env)).rejects.toMatchObject({ status: 503, code: 'attestation_unconfigured' });
    }
  });
});

describe('browser device enrollment', () => {
  it('signs exact attested v2 fields with the published host key', async () => {
    const page = await createTestPage();
    const { fixture } = await ownerRooted(page);
    const member = await device();
    const signed = await enroll(page.ownerApi, fixture.logId, member);
    const pageId = (await body(await page.api('GET', ''))).id as string;
    const owner = await inDO(pageId, t => t.db.get<string>('owner_account', ''));
    expect(await verifyHostAttestationV2(signed, hostKey)).toBe(true);
    expect(signed.payload).toMatchObject({
      subject: 'device',
      pageId,
      applicationId: fixture.logId,
      accountId: owner,
      publicKey: member.identity.publicKey,
      wrapKey: member.wrapKey,
      label: 'Browser device',
      inviteId: null,
    });
    expect(signed.payload.email).toMatch(/^owner-.*@example\.com$/);
    expect(signed.payload.expiresAt - signed.payload.issuedAt).toBe(3_600_000);
    expect(signed.payload.nonce).toMatch(/^[0-9a-f]{64}$/);
    for (const forged of [
      { ...signed.payload, accountId: 'someone-else' },
      { ...signed.payload, wrapKey: testWrapKey() },
      { ...signed.payload, expiresAt: signed.payload.expiresAt + 1 },
    ]) {
      expect(await verifyHostAttestationV2({ ...signed, payload: forged }, hostKey)).toBe(false);
    }
    const admissions = await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'admissions' }));
    expect(admissions.pending.map((r: unknown) => dec<SignedHostAttestationV2>(r).payload)
      .filter((item: any) => item.subject === 'device')
      .map((item: any) => item.publicKey)).toEqual([member.identity.publicKey]);
  });

  it('rejects unauthenticated, display, wrong-origin and challenge-mismatched enrollment; agents cannot enroll browser keys', async () => {
    const handle = await create();
    const send: Send = (method, path, input) => req(`${handle.page_url}_tendril/${path}`, {
      method,
      headers: { ...ownerHeaders(handle.page_url), 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const root = await device();
    const meta = await body(await send('GET', 'application'));
    const fixture = await buildGenesis(root, { accounts: meta.admissionAccounts });
    await body(await send('POST', 'peers/enrollment', {
      action: 'initialize',
      genesis: authorityRecord(fixture.genesisBytes),
      casNodes: fixture.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    }));

    const member = await device();
    const endpoint = `${handle.page_url}_tendril/peers/enrollment`;
    const jsonHdr = { 'Content-Type': 'application/json' };
    const challenge = { action: 'challenge', publicKey: member.identity.publicKey };
    expect((await req(endpoint, { method: 'POST', anonymous: true, headers: { ...jsonHdr, Origin: new URL(handle.page_url).origin }, body: JSON.stringify(challenge) })).status).toBe(401);
    expect((await req(endpoint, { method: 'POST', headers: { ...ownerHeaders(handle.page_url), ...jsonHdr, Origin: 'https://evil.example' }, body: JSON.stringify(challenge) })).status).toBe(403);
    const display = await inDO(handle.id, async t => t.renderLink(await t.createLink('display', 'wall', null)));
    const displayed = await req(`${display.url}_tendril/peers/enrollment`, { method: 'POST', anonymous: true, headers: { ...jsonHdr, Origin: new URL(display.url).origin }, body: JSON.stringify(challenge) });
    expect(displayed.status).toBe(403);
    expect((await api(handle, 'POST', 'peers/enrollment', challenge)).status).toBe(403);
    expect(await failure(await enrollRaw(send, fixture.logId, member, undefined, value => value + 'x'))).toEqual({ status: 403, code: 'enrollment_challenge_invalid' });
    const other = await device();
    const otherChallenge = await body(await send('POST', 'peers/enrollment', { action: 'challenge', publicKey: other.identity.publicKey }));
    const crossed = await signRecord(ENROLLMENT_REQUEST_DOMAIN, {
      applicationId: fixture.logId, publicKey: member.identity.publicKey, wrapKey: member.wrapKey, challenge: otherChallenge.challenge,
    }, member.identity);
    expect(await failure(await send('POST', 'peers/enrollment', { action: 'enroll', proof: rec(crossed) }))).toEqual({ status: 403, code: 'enrollment_challenge_invalid' });
    expect((await enrollRaw(send, fixture.logId, member)).status).toBe(200);
  });
});

describe('v2 genesis initialization', () => {
  it('stores a member-created Chronolog v2 genesis once, rejects unpinned variants, and never holds a host authority key', async () => {
    const page = await createTestPage();
    const root = await device();
    const metadata = await body(await page.ownerApi('GET', 'application'));
    const accounts = metadata.admissionAccounts as string[];
    const init = (fixture: ChainFixture, send: Send = page.ownerApi) => send('POST', 'peers/enrollment', {
      action: 'initialize',
      genesis: authorityRecord(fixture.genesisBytes),
      casNodes: fixture.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    });

    const outsider = await createSigningIdentity();
    expect(await failure(await init(await buildGenesis(root, { accounts, hostKey: outsider.publicKey })))).toEqual({ status: 400, code: 'admission_host_key_mismatch' });
    expect(await failure(await init(await buildGenesis(root, { accounts: ['email:someone@example.com'] })))).toEqual({ status: 400, code: 'admission_accounts_mismatch' });
    const guest = await page.participant();
    expect(await failure(await init(await buildGenesis(root, { accounts }), guest.api))).toEqual({ status: 403, code: 'owner_required' });

    const valid = await buildGenesis(root, { accounts: [...accounts, 'email:extra@example.com'] });
    const stored = await body(await init(valid));
    expect(bytesToHex(genesisLogId(authorityRecordBytes(stored.genesis)))).toBe(valid.logId);
    expect(stored.genesis).toEqual(authorityRecord(valid.genesisBytes));
    // Exact retry is idempotent.
    expect((await body(await init(valid))).genesis).toEqual(stored.genesis);
    // Different genesis is rejected with 409.
    expect(await failure(await init(await buildGenesis(root, { accounts, salt: crypto.getRandomValues(new Uint8Array(16)) })))).toEqual({ status: 409, code: 'application_initialized' });
    // The host has no authority identity.
    expect(await inDO((await body(await page.api('GET', ''))).id, t => t.db.one("SELECT 1 FROM participant_records WHERE key='authority/identity'"))).toBeNull();
  });

  it('lets only the agent whose registered key is a root administrator initialize, including before claim', async () => {
    const agent = await device();
    const handle = await create({ claim: false, agentKeys: { publicKey: base64urlKey(agent.identity.publicKey), wrapKey: agent.wrapKey } });
    const send: Send = (method, path, input) => api(handle, method, path, input);
    const accounts = (await body(await send('GET', 'application'))).admissionAccounts as string[];
    expect(accounts).toEqual([expect.stringMatching(/^email:owner-/)]);
    const stranger = await device();
    const badFixture = await buildGenesis(stranger, { accounts });
    expect(await failure(await send('POST', 'peers/enrollment', {
      action: 'initialize',
      genesis: authorityRecord(badFixture.genesisBytes),
      casNodes: badFixture.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    }))).toEqual({ status: 403, code: 'initializer_root_required' });

    const goodFixture = await buildGenesis(agent, { accounts });
    const initialized = await body(await send('POST', 'peers/enrollment', {
      action: 'initialize',
      genesis: authorityRecord(goodFixture.genesisBytes),
      casNodes: goodFixture.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    }));
    expect(bytesToHex(genesisLogId(authorityRecordBytes(initialized.genesis)))).toBe(goodFixture.logId);
  });
});

describe('agent attestation', () => {
  it('attests the creator and newly granted agents automatically, and on enroll-agent', async () => {
    const creatorKeys = await device();
    const handle = await create({ agentKeys: { publicKey: base64urlKey(creatorKeys.identity.publicKey), wrapKey: creatorKeys.wrapKey } });
    const send: Send = (method, path, input) => api(handle, method, path, input);
    const pending = async () => (await body(await send('POST', 'peers/enrollment', { action: 'admissions' }))).pending.map((r: unknown) => dec<SignedHostAttestationV2>(r).payload);
    const owner = handle.account!;
    expect(await pending()).toEqual([expect.objectContaining({ subject: 'agent', accountId: owner, publicKey: creatorKeys.identity.publicKey, wrapKey: creatorKeys.wrapKey, label: '@maintainer', inviteId: null })]);
    const enrolled = await body(await send('POST', 'peers/enrollment', { action: 'enroll-agent' }));
    const signed = dec<SignedHostAttestationV2>(enrolled.attestation);
    expect(await verifyHostAttestationV2(signed, hostKey)).toBe(true);
    expect(signed.payload).toMatchObject({ subject: 'agent', accountId: owner, pageId: handle.id, email: expect.stringMatching(/^owner-/) });
    const helperKeys = await device();
    const helper = await joinAccountAgent(handle, 'helper', '', { publicKey: base64urlKey(helperKeys.identity.publicKey), wrapKey: helperKeys.wrapKey });
    await grantAgent(handle, helper);
    expect((await pending()).map((item: any) => [item.publicKey, item.label])).toEqual(expect.arrayContaining([[helperKeys.identity.publicKey, '@helper'], [creatorKeys.identity.publicKey, '@maintainer']]));
    expect(await failure(await req(`${handle.page_url}_tendril/peers/enrollment`, {
      method: 'POST', headers: { ...ownerHeaders(handle.page_url), 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'enroll-agent' }),
    }))).toEqual({ status: 403, code: 'agent_required' });
  });

  it('binds an unclaimed page agent to the intended owner placeholder and requires wrap keys at registration', async () => {
    const handle = await create({ claim: false });
    const { attestation } = await body(await api(handle, 'POST', 'peers/enrollment', { action: 'enroll-agent' }));
    expect(dec<SignedHostAttestationV2>(attestation).payload).toMatchObject({ accountId: `pending:${handle.id}`, email: expect.stringMatching(/^owner-.*@example\.com$/) });
    const response = await req('/api/agents', {
      method: 'POST', anonymous: true, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.18.40.1' },
      body: JSON.stringify({ owner: 'wrap-owner@example.com', handle: 'nowrap', publicKey: base64urlKey('ab'.repeat(32)) }),
    });
    expect(await failure(response)).toEqual({ status: 400, code: 'invalid_wrap_key' });
  });
});

describe('public-control sync, invites, and late-revocation host reconciliation', () => {
  it('merges member-signed $permissions ops, prunes pending admissions, and enforces invite rules', async () => {
    const page = await createTestPage();
    const { root, fixture } = await ownerRooted(page);
    const laptop = await device();
    const laptopAtt = await enroll(page.ownerApi, fixture.logId, laptop);

    const admitOp = await signControlOp(fixture.logIdBytes, root.identity, [{
      topic: '$permissions',
      input: {
        action: 'setMember',
        member: { publicKey: laptop.identity.publicKey, wrapKey: laptop.wrapKey, reader: true, writer: true, administrator: false, publisher: false, finalizer: false },
        attestation: laptopAtt as any,
      },
    }]);
    const synced = await body(await syncOps(page.ownerApi, [admitOp]));
    expect(synced.addedOps).toBe(1);
    const pendingAfter = (await body(await page.ownerApi('POST', 'peers/enrollment', { action: 'admissions' }))).pending;
    expect(pendingAfter.map((r: unknown) => dec<SignedHostAttestationV2>(r).payload.publicKey)).not.toContain(laptop.identity.publicKey);

    // Issue an open invite + an email invite + a public(max=2) invite via $permissions public-control ops.
    const makeInvite = async (binding: any, extra: Record<string, unknown> = {}) => {
      const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      const inviteId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      const secretDigest = await sha256Hex(hexToBytes(secret));
      return {
        entry: { inviteId, role: 'writer', binding, expiresAt: Date.now() + 86_400_000, secretDigest, revoked: false, ...extra },
        redemption: { inviteId, secret },
      };
    };
    const openInv = await makeInvite({ kind: 'open' });
    const emailInv = await makeInvite({ kind: 'email', email: 'invitee@example.com' });
    const pubInv = await makeInvite({ kind: 'public', max: 2 });
    const revokedInv = await makeInvite({ kind: 'open' }, { revoked: true });
    const expiredInv = await makeInvite({ kind: 'open' }, { expiresAt: Date.now() - 1000 });
    const meta = await body(await page.ownerApi('GET', 'application'));
    const invOp = await signControlOp(fixture.logIdBytes, root.identity, [{
      topic: '$permissions',
      input: {
        action: 'setAdmission',
        admission: {
          mode: 'attested',
          hostKey,
          accounts: meta.admissionAccounts,
          grant: { reader: true, writer: true, administrator: true },
          invites: [openInv.entry, emailInv.entry, pubInv.entry, revokedInv.entry, expiredInv.entry],
        },
      },
    }]);
    await body(await syncOps(page.ownerApi, [invOp]));

    const guest = await page.participant();
    const other = await page.participant();
    const guestAtt = await enroll(guest.api, fixture.logId, await device(), openInv.redemption);
    expect(guestAtt.payload).toMatchObject({ accountId: guest.account, inviteId: openInv.redemption.inviteId });
    expect((await enroll(guest.api, fixture.logId, await device(), openInv.redemption)).payload.inviteId).toBe(openInv.redemption.inviteId);
    expect(await failure(await enrollRaw(other.api, fixture.logId, await device(), openInv.redemption))).toEqual({ status: 409, code: 'invite_redeemed' });

    expect(await failure(await enrollRaw(guest.api, fixture.logId, await device(), { ...emailInv.redemption, secret: 'ff'.repeat(32) }))).toEqual({ status: 403, code: 'invite_secret_invalid' });
    expect(await failure(await enrollRaw(guest.api, fixture.logId, await device(), emailInv.redemption))).toEqual({ status: 403, code: 'invite_email_mismatch' });
    expect(await failure(await enrollRaw(guest.api, fixture.logId, await device(), { inviteId: 'ab'.repeat(16), secret: 'ab'.repeat(32) }))).toEqual({ status: 404, code: 'invite_unknown' });
    for (let i = 0; i < 2; i++) await enroll((await page.participant()).api, fixture.logId, await device(), pubInv.redemption);
    expect(await failure(await enrollRaw((await page.participant()).api, fixture.logId, await device(), pubInv.redemption))).toEqual({ status: 409, code: 'invite_exhausted' });
    expect(await failure(await enrollRaw((await page.participant()).api, fixture.logId, await device(), expiredInv.redemption))).toEqual({ status: 410, code: 'invite_expired' });
    expect(await failure(await enrollRaw((await page.participant()).api, fixture.logId, await device(), revokedInv.redemption))).toEqual({ status: 410, code: 'invite_revoked' });
  });

  it('publishes signed $publications releases and rolls back a provisional release on late earlier revocation', async () => {
    const page = await createTestPage();
    const pub2 = await device();
    const { root, fixture } = await ownerRooted(page, {
      extraMembers: [{
        publicKey: pub2.identity.publicKey,
        wrapKey: pub2.wrapKey,
        reader: true,
        writer: true,
        administrator: false,
        publisher: true,
        finalizer: false,
      }],
    });

    // Helper to publish one signed HTML release at an explicit authorTimestampMs.
    const publishHtml = async (signer: SigningIdentity, html: string, tsMs: bigint) => {
      const bytes = new TextEncoder().encode(html);
      const hash = await sha256Hex(bytes);
      const op = await signControlOp(fixture.logIdBytes, signer, [{
        topic: '$publications',
        input: {
          action: 'publish',
          entry: 'index.html',
          files: [{ path: 'index.html', hash, size: bytes.length, type: 'text/html' }],
        },
      }], { authorTimestampMs: tsMs });
      return body(await page.ownerApi('POST', 'peers/publication', {
        action: 'publish',
        op: op.record,
        assets: [{ hash, bytes: btoa(String.fromCharCode(...bytes)) }],
      }));
    };

    const t0 = BigInt(Date.now());
    const r1 = await publishHtml(root.identity, '<!doctype html><html><title>Release 1</title><body>Safe v1</body></html>', t0 + 100n);
    expect(r1.version).toBe(1);
    expect(await (await page.asset()).text()).toContain('Safe v1');

    // pub2 publishes Release 2 at t0 + 300 (provisional under finality: none).
    const r2 = await publishHtml(pub2.identity, '<!doctype html><html><title>Release 2</title><body>From pub2</body></html>', t0 + 300n);
    expect(r2.version).toBe(2);
    expect(await (await page.asset()).text()).toContain('From pub2');

    // Now a LATE-ARRIVING earlier revocation signed by root at t0 + 200 arrives (before pub2's release at t0 + 300)!
    const revokeOp = await signControlOp(fixture.logIdBytes, root.identity, [{
      topic: '$permissions',
      input: { action: 'removeMember', publicKey: pub2.identity.publicKey },
    }], { authorTimestampMs: t0 + 200n });
    await body(await syncOps(page.ownerApi, [revokeOp]));

    // Blind host deterministically replays authored-time order -> pub2's release at t0+300 is now unauthorized ->
    // `reconcileHostEffects` immediately rolls served `current` back to Release 1!
    const afterRollback = await page.asset();
    expect(afterRollback.status).toBe(200);
    expect(await afterRollback.text()).toContain('Safe v1');
    const head = await body(await page.ownerApi('POST', 'peers/publication', { action: 'read' }));
    expect(head.opId).toBe(r1.opId);
    expect(head.version).toBe(1);
  });

  it('admits only signed member control.sync participant requests and rejects non-control ops or unknown signers', async () => {
    const page = await createTestPage();
    const { root, fixture } = await ownerRooted(page);
    const syncReq = await signRecord(PARTICIPANT_REQUEST_DOMAIN, {
      applicationId: fixture.logId,
      requestId: 'sync-1',
      action: 'control.sync',
    }, root.identity);
    const reply = dec(await body(await page.ownerApi('POST', 'peers/participant', rec(syncReq))));
    expect(reply.applicationId).toBe(fixture.logId);
    expect(reply.genesis).toEqual(authorityRecord(fixture.genesisBytes));

    const outsider = await signRecord(PARTICIPANT_REQUEST_DOMAIN, {
      applicationId: fixture.logId,
      requestId: 'outsider',
      action: 'control.sync',
    }, await createSigningIdentity());
    expect(await failure(await page.ownerApi('POST', 'peers/participant', rec(outsider)))).toEqual({ status: 403, code: 'participant_member_required' });
    expect((await page.ownerApi('POST', 'peers/participant', { program: 'host-must-not-execute-this' })).status).toBe(400);

    // Blind host refuses non-control application topic updates.
    const appOp = await signOperationCore({
      version: 1,
      logId: fixture.logIdBytes,
      author: hexToBytes(root.identity.publicKey),
      operationId: 'forbidden-app-topic',
      authorTimestampMs: BigInt(Date.now()),
      nonce: crypto.getRandomValues(new Uint8Array(16)),
      visibility: 'public',
      updates: [{ topic: 'notes', input: { text: 'must not enter blind host' } }],
    }, root.identity.privateKey);
    expect(await failure(await page.ownerApi('POST', 'peers/enrollment', {
      action: 'sync',
      publicOps: [authorityRecord(encodeSignedOperation(appOp))],
    }))).toEqual({ status: 400, code: 'control_topic_required' });
  });

  it('verifies v2 finality checkpoints and waits for finalized releases when $finality is active', async () => {
    const page = await createTestPage();
    const root = await device();
    const meta = await body(await page.ownerApi('GET', 'application'));
    const policy: FinalityPolicyV2 = { kind: 'signed-frontier', signer: root.identity.publicKey };
    const fixture = await buildGenesis(root, {
      accounts: meta.admissionAccounts,
      finalizer: true,
      finalitySchedule: [{ effectiveAfterMs: -1n, policy }],
    });
    await body(await page.ownerApi('POST', 'peers/enrollment', {
      action: 'initialize',
      genesis: authorityRecord(fixture.genesisBytes),
      casNodes: fixture.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    }));

    // Publish a release while finality is active -> stored, NOT served provisionally until finalized by checkpoint!
    const html = new TextEncoder().encode('<!doctype html><html><title>Finalized</title><body>Finalized UI</body></html>');
    const hash = await sha256Hex(html);
    const pubTs = BigInt(Date.now());
    const pubOp = await signControlOp(fixture.logIdBytes, root.identity, [{
      topic: '$publications',
      input: { action: 'publish', entry: 'index.html', files: [{ path: 'index.html', hash, size: html.length, type: 'text/html' }] },
    }], { authorTimestampMs: pubTs });
    const receipt = await body(await page.ownerApi('POST', 'peers/publication', {
      action: 'publish',
      op: pubOp.record,
      assets: [{ hash, bytes: btoa(String.fromCharCode(...html)) }],
    }));
    expect(receipt.finalized).toBe(false);
    // Served release is not yet active before checkpoint!
    expect(await body(await page.ownerApi('POST', 'peers/publication', { action: 'read' }))).toBeNull();

    // Compute exact deterministic snapshot using TopicKernel and sign a valid FinalityCheckpoint!
    const cas = new ContentAddressedStore({ store: new MemoryBytesStore() });
    await seedStandardModules(cas);
    for (const n of fixture.casNodes) await cas.put(n.bytes, [], 'public');
    const kernel = new TopicKernel({ genesis: fixture.genesisBytes, cas, blindHostMode: true, wasmModule: quickJsWasm });
    await kernel.materialize([{ opId: operationIdDigest(pubOp.signed.coreBytes), core: (await import('@chronolog/peer-session/kernel')).decodeOperationCore(pubOp.signed.coreBytes) }]);
    const snap = kernel.snapshot();
    const scopeId = await policyScopeId(fixture.logId, { effectiveAfterMs: -1n, policy });
    const checkpointPayload = {
      logId: fixture.logId,
      policyScopeId: scopeId,
      closedThroughMs: pubTs + 10n,
      includedSetDigest: computeIncludedSetDigest([pubOp.opId]),
      historyDigest: snap.historyDigest,
      stateRoot: snap.stateRoot,
      inclusions: [{ opId: pubOp.opId, authorTimestampMs: pubTs, author: root.identity.publicKey }],
    };
    const sig = await signFinalityCheckpoint(checkpointPayload, root.identity);
    const checkpoint: FinalityCheckpoint = { payload: checkpointPayload, attestation: { kind: 'signatures', signatures: [sig] } };

    // A checkpoint signed by an unauthorized key is rejected.
    const rogue = await createSigningIdentity();
    const rogueSig = await signFinalityCheckpoint(checkpointPayload, rogue);
    expect(await failure(await syncOps(page.ownerApi, [], [rec({ payload: checkpointPayload, attestation: { kind: 'signatures', signatures: [rogueSig] } })])))
      .toEqual({ status: 403, code: 'checkpoint_unverified' });

    // Valid checkpoint promotes the finalized release!
    const synced = await body(await syncOps(page.ownerApi, [], [rec(checkpoint)]));
    expect(synced.addedCheckpoints).toBe(1);
    const head = await body(await page.ownerApi('POST', 'peers/publication', { action: 'read' }));
    expect(head.opId).toBe(pubOp.opId);
    expect(head.finalized).toBe(true);
    expect(await (await page.asset()).text()).toContain('Finalized UI');
  });

  it('returns structured 400 for malformed canonical records at untrusted request boundaries', async () => {
    const fresh = await createTestPage();
    const badInit = await fresh.ownerApi('POST', 'peers/enrollment', { action: 'initialize', genesis: { record: '00' } });
    expect(badInit.status).toBe(400);
    expect((await badInit.json<any>()).error.code).toBe('authority_genesis_invalid');

    const page = await createTestPage();
    await ownerRooted(page);
    for (const [path, input] of [
      ['peers/enrollment', { action: 'enroll', proof: { record: '00' } }],
      ['peers/participant', { record: '00' }],
    ] as const) {
      const answer = await page.ownerApi('POST', path, input);
      expect(answer.status, `${path} ${JSON.stringify(input)}`).toBe(400);
      expect((await answer.json<any>()).error.code).toBe('authority_record_invalid');
    }
  });

  it('initializes and syncs non-host-attested multisigMembers (2-of-3 quorum) and openMembers chains via $permissions.query()', async () => {
    const s1 = await device();
    const s2 = await device();
    const s3 = await device();
    const newcomer = await device();

    // 1. Multisig 2-of-3 governance with ZERO host attestation and map-shaped members state!
    const msPage = await createTestPage();
    const msCreated = await createLogGenesis({
      creator: { publicKey: s1.identity.publicKey, wrapKey: s1.wrapKey, reader: true, writer: true, administrator: true },
      privateLog: true,
      topics: {
        $permissions: {
          module: 'chronolog/permissions',
          export: 'multisigMembers',
          initialState: {
            threshold: 2,
            signers: [s1.identity.publicKey, s2.identity.publicKey, s3.identity.publicKey],
            members: {},
            proposals: {},
          },
        },
        inventory: { module: 'chronolog/sql' },
      },
    });

    await body(await msPage.ownerApi('POST', 'peers/enrollment', {
      action: 'initialize',
      genesis: authorityRecord(msCreated.genesisBytes),
      casNodes: msCreated.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    }));

    // Newcomer is NOT yet a reader -> participant sync rejected!
    const makeParticipantSync = async (signer: Device, logId: string) => {
      const signed = await signRecord(PARTICIPANT_REQUEST_DOMAIN, {
        applicationId: logId,
        requestId: crypto.randomUUID(),
        action: 'control.sync',
      }, signer.identity);
      return msPage.ownerApi('POST', 'peers/participant', rec(signed));
    };
    expect(await failure(await makeParticipantSync(newcomer, msCreated.logId))).toEqual({ status: 403, code: 'participant_member_required' });

    // Signer 1 proposes admitting newcomer (1/2 approvals — still not admitted)
    const logIdBytes = hexToBytes(msCreated.logId);
    const propOp = await signControlOp(logIdBytes, s1.identity, [{
      topic: '$permissions',
      input: {
        action: 'propose',
        proposalId: 'add-newcomer',
        kind: 'setMember',
        member: { publicKey: newcomer.identity.publicKey, wrapKey: newcomer.wrapKey, reader: true, writer: true, administrator: false, publisher: false, finalizer: false },
      },
    }], { authorTimestampMs: 1000n });
    await body(await syncOps(msPage.ownerApi, [propOp]));
    expect(await failure(await makeParticipantSync(newcomer, msCreated.logId))).toEqual({ status: 403, code: 'participant_member_required' });

    // Signer 2 approves -> 2/2 quorum executes atomically; blind host recognizes newcomer via $permissions.query()!
    const approveOp = await signControlOp(logIdBytes, s2.identity, [{
      topic: '$permissions',
      input: { action: 'approve', proposalId: 'add-newcomer' },
    }], { authorTimestampMs: 2000n });
    await body(await syncOps(msPage.ownerApi, [approveOp]));
    expect((await makeParticipantSync(newcomer, msCreated.logId)).status).toBe(200);

    // 2. Open-read / open-write chain (zero host attestation): stranger can sync immediately!
    const openPage = await createTestPage();
    const openCreated = await createLogGenesis({
      creator: { publicKey: s1.identity.publicKey, wrapKey: s1.wrapKey, reader: true, writer: true, administrator: true },
      privateLog: false,
      topics: {
        $permissions: {
          module: 'chronolog/permissions',
          export: 'openMembers',
          initialState: {
            admins: [s1.identity.publicKey],
            members: [],
            openRead: true,
            openWrite: true,
            admission: null,
          },
        },
        board: { module: 'chronolog/sql' },
      },
    });
    await body(await openPage.ownerApi('POST', 'peers/enrollment', {
      action: 'initialize',
      genesis: authorityRecord(openCreated.genesisBytes),
      casNodes: openCreated.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    }));
    const strangerSync = await signRecord(PARTICIPANT_REQUEST_DOMAIN, {
      applicationId: openCreated.logId,
      requestId: crypto.randomUUID(),
      action: 'control.sync',
    }, newcomer.identity);
    expect((await openPage.ownerApi('POST', 'peers/participant', rec(strangerSync))).status).toBe(200);

    // Unauthenticated visitor (zero OAuth cookie) can load the open-read page, read /_tendril/application,
    // and sync public control facts — while owner-only /_tendril/manage stays forbidden.
    const openUrl = new URL(openPage.pageUrl);
    const anonPageRes = await req(openPage.pageUrl, { anonymous: true });
    expect(anonPageRes.status).toBe(200);
    const anonAppRes = await req(new URL('_tendril/application', openUrl).href, { anonymous: true });
    expect(anonAppRes.status).toBe(200);
    const anonSyncRes = await req(new URL('_tendril/peers/participant', openUrl).href, {
      anonymous: true,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: openUrl.origin },
      body: JSON.stringify(rec(strangerSync)),
    });
    expect(anonSyncRes.status).toBe(200);
    const anonManageRes = await req(new URL('_tendril/manage', openUrl).href, { anonymous: true });
    expect(anonManageRes.status).toBe(403);
  });
});
