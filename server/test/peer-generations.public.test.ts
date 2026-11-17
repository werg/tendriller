import { peerApi, peerJson, peerRequest, ownerPeerApi } from './helpers';
import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createPeerIdentity, signTransitionRequest, verifyAuthorityBundle, generationStartRoot,
  participantGrant, controlParticipantGrant, applicationDescriptionDigest, signApplicationSchema, verifyApplicationSchema, peerDigest,
  type ApplicationDescription, type PeerIdentity, type PeerGrant, type AuthorityBundle, type SignedGeneration, type TransitionRequest } from '@chronolog/peer-generation/control';
import type { PeerApplicationConfiguration } from '../../contract/peer-controls.mjs';
import { api, create, inDO, req, type Handle } from './helpers';
import { createTestPage } from './public-fixture';
import { authenticateAgentToken } from '../src/access';
import { handleParticipant } from '../src/peer-participant';
import type { Tendril } from '../src/tendril';

const grant = (peer: PeerIdentity, extra: Partial<PeerGrant> = {}): PeerGrant => ({ ...participantGrant(peer.publicKey, { administrator: true }), ...extra });
const definition = { id: 'peer-control-test', version: '1', schema: null,
  commands: [{ name: 'append', description: 'Append an entry', input: { type: 'object', properties: { text: { type: 'string', maxLength: 128 }, progress: { type: 'number', minimum: 0.5 } }, required: ['text'], additionalProperties: false } }],
  queries: [{ name: 'entries', description: 'Read entries', input: { type: 'object', properties: {}, additionalProperties: false } }],
} as const satisfies ApplicationDescription;
let definitionDigest: string;
beforeAll(async () => { definitionDigest = await applicationDescriptionDigest(definition); });
const configuration = (peers: PeerIdentity[]) => ({ historyId: 'peer-history', executionManifestDigest: '12'.repeat(32),
  definition, schemaAdministrator: peers[0].publicKey, epoch: 0, keyDigest: '56'.repeat(32),
  members: peers.map(peer => ({ grant: grant(peer) })) } satisfies PeerApplicationConfiguration);
const applicationId = () => crypto.randomUUID().replaceAll('-', '').repeat(2);
async function admitGuest(h: Handle): Promise<string> {
  return inDO(h.id, async t => {
    const account = crypto.randomUUID(), link = await t.createLink('guest', 'control target', null);
    await t.env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)')
      .bind(account, t.now(), `${account}@example.test`).run();
    t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)', account, link.id, t.now());
    return account;
  });
}
/** Revoke the target at the requester's final asynchronous access check, after signing preparation. */
async function revokePreparedTarget(t: Tendril, account: string, run: () => Promise<void>): Promise<void> {
  const original = t.env.ACCOUNTS, owner = t.db.get('owner_account', '');
  let checkedTarget = false, revoked = false;
  t.env.ACCOUNTS = { prepare(sql: string) {
    const statement = original.prepare(sql);
    if (!sql.includes('FROM accounts WHERE id')) return statement;
    return { bind(...args: unknown[]) {
      const bound = statement.bind(...args);
      return { async first() {
        const result = await bound.first();
        if (args[0] === account) checkedTarget = true;
        if (checkedTarget && args[0] === owner && !revoked) {
          revoked = true; t.db.run('DELETE FROM guest_accounts WHERE account_id=?', account);
        }
        return result;
      } };
    } };
  } } as D1Database;
  try { await run(); expect(revoked).toBe(true); } finally { t.env.ACCOUNTS = original; }
}
async function select(h: Handle, requester: PeerIdentity, coordinator: PeerIdentity, current: SignedGeneration | null, transitionId: string,
  overrides: Partial<TransitionRequest> = {}) {
  const payload: TransitionRequest = { applicationId: (await peerJson<AuthorityBundle>(h, 'control', 'read')).descriptor.payload.applicationId,
    profile: 'peer-generation-v1', policy: 'eligible-members-v1', transitionId, requester: requester.publicKey, coordinator: coordinator.publicKey,
    expectedGeneration: current?.id ?? null, controlRevision: current?.payload.controlRevision ?? 0,
    reason: current ? 'takeover' : 'create', base: current ? { point: { generation: current.id, sequence: 0, root: await generationStartRoot(current) }, receipt: null, bridge: [] } : null,
    ...overrides };
  const request = await signTransitionRequest(payload, requester);
  return { request, response: await peerApi(h, 'control', 'select', { request }) };
}

it('publishes durable governance without a native resident, preserves root on restart, and returns exact lost selections', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const config = configuration([a, b]);
  const initial = await (await page.peer('control', 'configure', config)).json() as AuthorityBundle;
  expect((await verifyAuthorityBundle(initial)).current).toBeNull();
  expect(initial.descriptor.payload.controlPublicKey).not.toBe(a.publicKey);
  const request = await signTransitionRequest({ applicationId: initial.descriptor.payload.applicationId, profile: 'peer-generation-v1',
    policy: 'eligible-members-v1', transitionId: 'initial', requester: a.publicKey, coordinator: a.publicKey,
    expectedGeneration: null, controlRevision: 0, reason: 'create', base: null }, a);
  const response = await page.peer('control', 'select', { request });
  expect(response.status).toBe(200);
  const selected = await response.json();
  await page.restart();
  expect(await (await page.peer('control', 'select', { request })).json()).toEqual(selected);
  const resumed = await (await page.peer('control', 'read')).json() as AuthorityBundle;
  expect((await verifyAuthorityBundle(resumed)).current?.id).toBe((selected as SignedGeneration).id);
  expect(resumed.descriptor).toEqual(initial.descriptor);
  expect((await page.api('PATCH', '', { lifetime: 'ad_hoc' })).status).toBe(409);
  expect(await (await page.peer('control', 'configure', config)).json()).toEqual(resumed);
  const changedDefinition = { ...definition, version: '2' };
  expect((await page.peer('control', 'configure', { ...config, definition: changedDefinition })).status).toBe(409);
  expect(await (await page.peer('publication', 'definition')).json()).toEqual({ descriptor: initial.descriptor, definition, schema: null });
});

it('returns the immutable canonical definition with its signed binding to admitted accounts after restart', async () => {
  const a = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const configured = await page.ownerPeer('control', 'configure', configuration([a]));
  expect(configured.status).toBe(200);
  const authority = await configured.json() as AuthorityBundle;
  await verifyAuthorityBundle(authority);
  const expected = { descriptor: authority.descriptor, definition, schema: null };
  const participant = await page.participant();
  const first = await participant.peer('publication', 'definition');
  expect(first.status).toBe(200); expect(await first.json()).toEqual(expected);
  expect(await applicationDescriptionDigest(definition)).toBe(authority.descriptor.payload.definitionDigest);
  await page.restart();
  expect(await (await page.ownerPeer('publication', 'definition')).json()).toEqual(expected);
  const deniedWrite = await page.ownerPeer('publication', 'definition', definition);
  expect(deniedWrite.status).toBe(400);
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), participant.account).run();
  const denied = await participant.peer('publication', 'definition');
  // POST authentication returns a typed refusal instead of a sign-in navigation.
  expect(denied.status).toBe(401);
  expect(await denied.text()).not.toContain(definitionDigest);
});

it('rejects missing, unknown, malformed and mismatched definition metadata before control or lifetime writes', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const valid = configuration([a]);
  const { definition: omitted, ...missing } = valid;
  const variants = [missing, { ...valid, definition: { ...definition, unrecognized: true } },
    { ...valid, definition: { ...definition, commands: [{ ...definition.commands[0], input: { type: 'object', properties: {}, additionalProperties: true } }] } },
    { ...valid, definitionDigest: '78'.repeat(32) }, { ...valid, unknownMetadata: true }];
  const before = await inDO(h.id, t => t.db.get('lifetime', 'ad_hoc'));
  for (const input of variants) {
    expect((await peerApi(h, 'control', 'configure', input)).status).toBe(400);
    expect(await inDO(h.id, t => ({ configuration: t.db.get('peer_generation_configuration', null),
      accounts: t.db.get('peer_generation_accounts', null), retained: t.db.all("SELECT key FROM membership_records WHERE key LIKE 'peer-generation/%'"),
      lifetime: t.db.get('lifetime', 'ad_hoc') }))).toEqual({ configuration: null, accounts: null, retained: [], lifetime: before });
  }
  expect((await peerApi(h, 'control', 'configure', valid)).status).toBe(200);
  expect((await req(`${h.api}/peers/participant`, { method: 'POST', anonymous: true })).status).toBe(401);
});

it('refuses a retained definition whose contents no longer match the signed descriptor', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  await peerJson(h, 'control', 'configure', configuration([a]));
  await inDO(h.id, t => {
    const current = t.db.get<any>('peer_generation_configuration', null);
    t.db.set('peer_generation_configuration', { ...current, definition: { ...current.definition, version: 'tampered' } });
  });
  const response = await peerApi(h, 'publication', 'definition');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'peer_definition_state_mismatch' } });
});

it('rechecks local access after asynchronous definition verification before disclosing its schemas', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  await peerJson(h, 'control', 'configure', configuration([a]));
  await inDO(h.id, async t => {
    const principal = await authenticateAgentToken(t, h.token), original = t.env.ACCOUNTS;
    let checked = false;
    t.env.ACCOUNTS = { prepare(sql: string) {
      const statement = original.prepare(sql);
      if (!sql.includes('FROM accounts WHERE id')) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { async first() { const result = await bound.first(); checked = true; t.db.run('DELETE FROM tokens'); return result; } };
      } };
    } } as D1Database;
    try {
      await expect(handleParticipant(t, peerRequest(h.application.id, 'publication', 'definition'), principal))
        .rejects.toMatchObject({ status: 403 });
      expect(checked).toBe(true);
    } finally { t.env.ACCOUNTS = original; }
  });
});

it('selects one racing successor using the shared verifier and stores no application bodies', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity(), c = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  await peerJson(h, 'control', 'configure', configuration([a, b, c]));
  const first = await select(h, a, a, null, 'create');
  expect(first.response.status).toBe(200);
  const g0 = await first.response.json() as SignedGeneration;
  const racers = await Promise.all([select(h, b, b, g0, 'takeover-b'), select(h, c, c, g0, 'takeover-c')]);
  expect(racers.map(result => result.response.status).sort()).toEqual([200, 409]);
  const selected = await peerJson<AuthorityBundle>(h, 'control', 'read');
  expect(selected.generations).toHaveLength(2);
  await verifyAuthorityBundle(selected);
  expect(await inDO(h.id, t => ({ application: t.db.one('SELECT COUNT(*) AS n FROM application_changes'),
    records: t.db.one('SELECT COUNT(*) AS n FROM record_log_entries'), devices: t.db.one('SELECT COUNT(*) AS n FROM devices') })))
    .toEqual({ application: { n: 0 }, records: { n: 0 }, devices: { n: 0 } });
});

it('separately checks requester recovery, candidate eligibility, and the authenticated account binding', async () => {
  const a = await createPeerIdentity(), writer = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const config = configuration([a, writer]); config.members[1].grant = grant(writer, { recovery: false, coordinator: false, administrator: false });
  await peerJson(h, 'control', 'configure', config);
  expect((await select(h, writer, a, null, 'unauthorized-recovery')).response.status).toBe(403);
  expect((await select(h, a, writer, null, 'ineligible-coordinator')).response.status).toBe(403);
  const stranger = await createPeerIdentity();
  expect((await select(h, stranger, a, null, 'unenrolled-requester')).response.status).toBe(403);
  expect((await req(`${h.api}/peers/participant`, { method: 'POST', anonymous: true })).status).toBe(401);
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const authority = await (await page.peer('control', 'configure', configuration([a]))).json() as AuthorityBundle;
  const participant = await page.participant();
  const request = await signTransitionRequest({ applicationId: authority.descriptor.payload.applicationId, profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    transitionId: 'wrong-account', expectedGeneration: null, requester: a.publicKey, coordinator: a.publicKey, reason: 'create', base: null, controlRevision: 0 }, a);
  expect((await participant.peer('control', 'select', { request })).status).toBe(403);
});

it('activates restrictive controls atomically, enforces key rotation, and keeps exact control retries after self-revocation', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  await peerJson(h, 'control', 'configure', configuration([a, b]));
  const initial = await select(h, a, a, null, 'initial');
  const g0 = await initial.response.json() as SignedGeneration;
  const request = await signTransitionRequest({ ...initial.request.payload, transitionId: 'revoke-a', expectedGeneration: g0.id, coordinator: b.publicKey,
    reason: 'control-change', controlRevision: 1, base: { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] } }, a);
  const grants = [grant(a, { reader: false, writer: false, coordinator: false, recovery: false, administrator: false, dataRole: null }), grant(b)];
  const invalid = { epoch: 0, keyDigest: '56'.repeat(32), grants, recoveryFloor: null };
  expect((await peerApi(h, 'control', 'select', { request, control: invalid })).status).toBe(400);
  expect((await peerJson<AuthorityBundle>(h, 'control', 'read')).controls).toHaveLength(1);
  const control = { ...invalid, epoch: 1, keyDigest: '89'.repeat(32) };
  const result = await peerJson(h, 'control', 'select', { request, control });
  expect(await peerJson(h, 'control', 'select', { request, control })).toEqual(result);
  expect((await peerApi(h, 'control', 'select', { request, control: { ...control, keyDigest: '90'.repeat(32) } })).status).toBe(409);
  const authority = await verifyAuthorityBundle(await peerJson(h, 'control', 'read'));
  expect(authority.grant(a.publicKey)?.writer).toBe(false);
  expect(authority.control.payload.epoch).toBe(1);
  expect((await select(h, a, b, authority.current, 'revoked-a')).response.status).toBe(403);
});

it('revokes an inactive enrolled account without granting it new rights or forgetting its binding', async () => {
  const owner = await createPeerIdentity(), guest = await createPeerIdentity(), newDevice = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const participant = await page.participant();
  const config = { ...configuration([owner, guest]), members: [
    { grant: grant(owner) }, { grant: grant(guest), accountId: participant.account },
  ] };
  const initial = await (await page.peer('control', 'configure', config)).json() as AuthorityBundle;
  const first = await signTransitionRequest({ applicationId: initial.descriptor.payload.applicationId, profile: 'peer-generation-v1',
    policy: 'eligible-members-v1', transitionId: 'initial', requester: owner.publicKey, coordinator: owner.publicKey,
    expectedGeneration: null, controlRevision: 0, reason: 'create', base: null }, owner);
  const g0 = await (await page.peer('control', 'select', { request: first })).json() as SignedGeneration;
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), participant.account).run();
  const request = await signTransitionRequest({ ...first.payload, transitionId: 'revoke-inactive', expectedGeneration: g0.id,
    reason: 'control-change', controlRevision: 1,
    base: { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] } }, owner);
  const control = { epoch: 1, keyDigest: '89'.repeat(32), recoveryFloor: null,
    grants: [grant(owner), grant(guest, { reader: false, writer: false, coordinator: false, recovery: false, administrator: false, dataRole: null })] };
  expect((await page.peer('control', 'select', { request, control: { ...control, grants: [grant(owner), grant(guest)] } })).status).toBe(403);
  for (const dataRole of ['member', 'admin'] as const)
    expect((await page.peer('control', 'select', { request, control: { ...control,
      grants: [grant(owner), { ...control.grants[1], dataRole }] } })).status).toBe(403);
  expect((await page.peer('control', 'select', { request, control: { ...control,
    accounts: [{ publicKey: newDevice.publicKey, accountId: participant.account }] } })).status).toBe(403);
  expect((await (await page.peer('control', 'read')).json() as AuthorityBundle).controls).toHaveLength(1);
  const response = await page.peer('control', 'select', { request, control });
  expect(response.status).toBe(200);
  const selected = await response.json();
  await page.restart();
  expect(await (await page.peer('control', 'select', { request, control })).json()).toEqual(selected);
  const authority = await verifyAuthorityBundle(await (await page.peer('control', 'read')).json() as AuthorityBundle);
  expect(authority.control.payload.epoch).toBe(1);
  expect(authority.grant(guest.publicKey)).toEqual(control.grants[1]);
  const replacement = await page.participant();
  const next = await signTransitionRequest({ ...request.payload, transitionId: 'reassign-revoked-device',
    expectedGeneration: authority.current!.id, controlRevision: 2,
    base: { point: { generation: authority.current!.id, sequence: 0, root: await generationStartRoot(authority.current!) }, receipt: null, bridge: [] } }, owner);
  expect((await page.peer('control', 'select', { request: next,
    control: { ...control, accounts: [{ publicKey: guest.publicKey, accountId: replacement.account }] } })).status).toBe(409);
});

it('fences a missing control identity instead of silently generating a replacement', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const original = await peerJson<AuthorityBundle>(h, 'control', 'configure', configuration([a]));
  await inDO(h.id, t => t.db.run('DELETE FROM membership_records WHERE key=?', 'peer-generation/identity'));
  expect((await peerApi(h, 'control', 'read')).status).toBe(503);
  expect((await peerApi(h, 'control', 'configure', configuration([a]))).status).toBe(503);
  expect(await inDO(h.id, t => t.db.get<any>('peer_generation_configuration', null).descriptor)).toEqual(original.descriptor);
});

it('bounds admitted control bodies before reading and releases slots after body failure', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  await peerJson(h, 'control', 'configure', configuration([a]));
  await inDO(h.id, async t => {
    const principal = await authenticateAgentToken(t, h.token), controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pending: Promise<unknown>[] = [], url = 'https://page.example/_tendril/peers/participant';
    let excessReads = 0;
    try {
      for (let index = 0; index < 4; index++) {
        const body = new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } }, { highWaterMark: 0 });
        const operation = handleParticipant(t, new Request(url, { method: 'POST', body }), principal);
        pending.push(operation); void operation.catch(() => {});
        if (index === 0) {
          const available = await handleParticipant(t, peerRequest(h.application.id, 'control', 'read'), principal);
          expect(available.status).toBe(200);
        }
      }
      const extra = new Request(url, { method: 'POST', body: new ReadableStream<Uint8Array>({ pull(controller) {
        excessReads++; controller.enqueue(new TextEncoder().encode('{}')); controller.close();
      } }, { highWaterMark: 0 }) });
      await expect(handleParticipant(t, extra, principal))
        .rejects.toMatchObject({ status: 429, code: 'peer_control_busy' });
      await expect(handleParticipant(t, peerRequest(h.application.id, 'publication', 'definition'), principal))
        .rejects.toMatchObject({ status: 429, code: 'peer_control_busy' });
      expect(excessReads).toBe(0);
    } finally {
      for (const controller of controllers) { try { controller.error(new Error('test body stopped')); } catch { /* Already closed. */ } }
      await Promise.allSettled(pending);
    }
    expect((await handleParticipant(t, peerRequest(h.application.id, 'control', 'read'), principal)).status).toBe(200);
  });
});

for (const phase of ['initial configuration', 'control update', 'owner control update'] as const) {
  it(`rechecks target admission at the ${phase} commit after signing preparation`, async () => {
    const a = await createPeerIdentity(), b = await createPeerIdentity();
    const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
    const account = await admitGuest(h);
    let action = 'configure', body: unknown = { ...configuration([a]),
      members: [{ grant: grant(a) }, { grant: grant(b), accountId: account }] };
    let before: AuthorityBundle | null = null;
    if (phase !== 'initial configuration') {
      await peerJson(h, 'control', 'configure', configuration([a]));
      const initial = await select(h, a, a, null, 'initial'), current = await initial.response.json() as SignedGeneration;
      before = await peerJson<AuthorityBundle>(h, 'control', 'read');
      const request = await signTransitionRequest({ ...initial.request.payload, transitionId: 'enroll-b', expectedGeneration: current.id,
        controlRevision: 1, reason: 'control-change', base: { point: { generation: current.id, sequence: 0, root: await generationStartRoot(current) }, receipt: null, bridge: [] } }, a);
      const control = { epoch: 1, keyDigest: '89'.repeat(32), grants: [grant(a), grant(b)], recoveryFloor: null,
        accounts: [{ publicKey: b.publicKey, accountId: account }] };
      body = { request, control };
      action = 'select';
      if (phase === 'owner control update') {
        const { transitionId, expectedGeneration, coordinator, controlRevision, reason, base } = request.payload;
        body = { transition: { transitionId, expectedGeneration, coordinator, controlRevision, reason, base }, control };
        action = 'administer';
      }
    }
    await inDO(h.id, async t => {
      const principal = await authenticateAgentToken(t, h.token);
      await revokePreparedTarget(t, account, async () => {
        await expect(handleParticipant(t, peerRequest(h.application.id, 'control', action, body), principal))
          .rejects.toMatchObject({ status: 403, code: 'forbidden' });
      });
      expect(t.db.get<{ publicKey: string }[]>('peer_generation_accounts', []).some(binding => binding.publicKey === b.publicKey)).toBe(false);
      if (phase === 'initial configuration') {
        expect(t.db.get('peer_generation_configuration', null)).toBeNull();
        expect(t.db.all("SELECT key FROM membership_records WHERE key LIKE 'peer-generation/%'")).toEqual([]);
      }
    });
    if (before) expect(await peerJson(h, 'control', 'read')).toEqual(before);
  });
}

it('can revoke an inactive account while retaining its immutable enrollment for exact retries', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const account = await admitGuest(h);
  await peerJson(h, 'control', 'configure', { ...configuration([a]), members: [{ grant: grant(a) }, { grant: grant(b), accountId: account }] });
  const initial = await select(h, a, a, null, 'initial'), current = await initial.response.json() as SignedGeneration;
  await inDO(h.id, async t => {
    t.db.run('DELETE FROM guest_accounts WHERE account_id=?', account);
    await t.env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(t.now(), account).run();
  });
  const request = await signTransitionRequest({ ...initial.request.payload, transitionId: 'revoke-b', expectedGeneration: current.id,
    controlRevision: 1, reason: 'control-change', base: { point: { generation: current.id, sequence: 0, root: await generationStartRoot(current) }, receipt: null, bridge: [] } }, a);
  const control = { epoch: 1, keyDigest: '89'.repeat(32), recoveryFloor: null,
    grants: [grant(a), grant(b, { reader: false, writer: false, coordinator: false, recovery: false, administrator: false, dataRole: null })] };
  const selected = await peerJson(h, 'control', 'select', { request, control });
  expect(await peerJson(h, 'control', 'select', { request, control })).toEqual(selected);
  const authority = await verifyAuthorityBundle(await peerJson(h, 'control', 'read'));
  expect(authority.grant(b.publicKey)?.reader).toBe(false);
  expect(await inDO(h.id, t => t.db.get<any[]>('peer_generation_accounts', []).find(binding => binding.publicKey === b.publicKey)))
    .toEqual({ publicKey: b.publicKey, accountId: account });
});

it('recovers through explicit owner control authority without a creator device key or data privileges', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const initial = await (await page.ownerPeer('control', 'configure', { ...configuration([a, b]),
    members: [{ publicKey: a.publicKey }, { publicKey: b.publicKey }] })).json() as AuthorityBundle;
  const hosted = initial.descriptor.payload.controlPublicKey;
  expect(initial.controls[0].payload.grants).toEqual([participantGrant(a.publicKey), participantGrant(b.publicKey), controlParticipantGrant(hosted)]);
  const start = { transitionId: 'owner-create', expectedGeneration: null, coordinator: a.publicKey, controlRevision: 0, reason: 'create', base: null };
  const first = await page.ownerPeer('control', 'administer', { transition: start });
  expect(first.status).toBe(200);
  const g0 = await first.json() as SignedGeneration;
  expect(g0.payload.transition.payload.requester).toBe(hosted);
  const base = { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] };
  const transition = { transitionId: 'creator-key-lost', expectedGeneration: g0.id, coordinator: b.publicKey, controlRevision: 1, reason: 'control-change', base };
  const control = { epoch: 1, keyDigest: '98'.repeat(32), grants: [participantGrant(b.publicKey)], recoveryFloor: null };
  const guest = await page.participant();
  expect((await guest.peer('control', 'administer', { transition, control })).status).toBe(403);
  expect((await page.ownerPeer('control', 'administer', { transition,
    control: { ...control, grants: [...control.grants, { ...controlParticipantGrant(hosted), writer: true }] } })).status).toBe(403);
  const changed = await page.ownerPeer('control', 'administer', { transition, control });
  expect(changed.status).toBe(200);
  const g1 = await changed.json() as SignedGeneration;
  await page.restart();
  expect(await (await page.ownerPeer('control', 'administer', { transition, control })).json()).toEqual(g1);
  const authority = await verifyAuthorityBundle(await (await page.ownerPeer('control', 'read')).json() as AuthorityBundle);
  expect(authority.current?.id).toBe(g1.id);
  expect(authority.grant(hosted)).toEqual(controlParticipantGrant(hosted));
  expect(authority.grant(a.publicKey)).toBeNull();
  const nextBase = { point: { generation: g1.id, sequence: 0, root: await generationStartRoot(g1) }, receipt: null, bridge: [] };
  expect((await page.ownerPeer('control', 'administer', { transition: { ...transition,
    transitionId: 'host-cannot-coordinate', expectedGeneration: g1.id, coordinator: hosted, reason: 'takeover', base: nextBase } })).status).toBe(403);
  expect((await page.ownerPeer('control', 'administer', { transition: { ...transition,
    transitionId: 'host-cannot-impersonate-handover', expectedGeneration: g1.id, reason: 'handover', base: nextBase } })).status).toBe(403);
});

it('lets the owner remove inactive accounts while retaining immutable enrollment provenance', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const guest = await page.participant();
  const configured = await page.ownerPeer('control', 'configure', { ...configuration([a, b]),
    members: [{ publicKey: a.publicKey }, { publicKey: b.publicKey, accountId: guest.account }] });
  expect(configured.status).toBe(200); await configured.text();
  const first = await page.ownerPeer('control', 'administer', { transition: {
    transitionId: 'before-account-removal', expectedGeneration: null, coordinator: a.publicKey, controlRevision: 0, reason: 'create', base: null } });
  const g0 = await first.json() as SignedGeneration;
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), guest.account).run();
  const changed = await page.ownerPeer('control', 'administer', {
    transition: { transitionId: 'remove-inactive', expectedGeneration: g0.id, coordinator: a.publicKey, controlRevision: 1, reason: 'control-change',
      base: { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] } },
    control: { epoch: 1, keyDigest: '98'.repeat(32), grants: [participantGrant(a.publicKey)], recoveryFloor: null },
  });
  expect(changed.status).toBe(200); await changed.text();
  const authority = await verifyAuthorityBundle(await (await page.ownerPeer('control', 'read')).json() as AuthorityBundle);
  expect(authority.grant(b.publicKey)).toBeNull();
});

it('rechecks local token revocation after asynchronous authorization before committing a generation', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const initial = await peerJson<AuthorityBundle>(h, 'control', 'configure', configuration([a]));
  const request = await signTransitionRequest({ applicationId: initial.descriptor.payload.applicationId, profile: 'peer-generation-v1',
    policy: 'eligible-members-v1', transitionId: 'revoked-during-commit', expectedGeneration: null,
    requester: a.publicKey, coordinator: a.publicKey, controlRevision: 0, reason: 'create', base: null }, a);
  await inDO(h.id, async t => {
    const principal = await authenticateAgentToken(t, h.token), original = t.env.ACCOUNTS;
    let changed = false;
    t.env.ACCOUNTS = { prepare(sql: string) {
      const statement = original.prepare(sql);
      if (!sql.includes('FROM accounts WHERE id')) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { async first() {
          const result = await bound.first(); changed = true; t.db.run('DELETE FROM tokens'); return result;
        } };
      } };
    } } as D1Database;
    try {
      await expect(handleParticipant(t, peerRequest(h.application.id, 'control', 'select', { request }), principal)).rejects.toMatchObject({ status: 403 });
      expect(changed).toBe(true);
    } finally { t.env.ACCOUNTS = original; }
  });
  const authority = await (await ownerPeerApi(h, 'control', 'read')).json() as AuthorityBundle;
  expect(authority.generations).toEqual([]);
});

it('requires immutable canonical public command/query metadata before publishing authority', async () => {
  const a = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const config = configuration([a]), { definition: omitted, ...missing } = config;
  expect((await page.peer('publication', 'definition')).status).toBe(409);
  expect((await page.peer('control', 'configure', missing)).status).toBe(400);
  expect((await page.peer('control', 'configure', { ...config, definitionDigest: await applicationDescriptionDigest(definition) })).status).toBe(400);
  expect((await page.peer('control', 'configure', { ...config, definition: { ...definition,
    commands: [{ ...definition.commands[0], input: { type: 'object', properties: {} } }] } })).status).toBe(400);
  expect((await page.peer('control', 'configure', { ...config, schemaDigest: null })).status).toBe(400);
  expect((await page.peer('control', 'read')).status).toBe(409);
  const configured = await page.peer('control', 'configure', config);
  expect(configured.status).toBe(200);
  const authority = await configured.json() as AuthorityBundle;
  const participant = await page.participant();
  const published = await (await participant.peer('publication', 'definition')).json() as { descriptor: AuthorityBundle['descriptor']; definition: ApplicationDescription; schema: null };
  expect(published).toEqual({ descriptor: authority.descriptor, definition, schema: null });
  expect(await applicationDescriptionDigest(published.definition)).toBe(authority.descriptor.payload.definitionDigest);
  expect(authority.descriptor.payload.schemaDigest).toBeNull();
  expect(await (await page.peer('control', 'configure', { ...config, schema: null })).json()).toEqual(authority);
  void omitted;
});

it('retains a verified signed genesis schema as metadata without executing SQL on the control host', async () => {
  const a = await createPeerIdentity(), wrongSigner = await createPeerIdentity(), id = applicationId();
  const h = await create({ application: { kind: 'peer', id }, listener: false, mode: 'dashboard' });
  // Public Chronolog encodeChangeProgram(program('CREATE TABLE tasks (id INTEGER PRIMARY KEY)')).
  const program = 'a2000301818200a200782b435245415445205441424c45207461736b732028696420494e5445474552205052494d415259204b4559290180';
  const sqlDefinition: ApplicationDescription = { ...definition, id: 'sql-test', schema: program };
  const digest = await applicationDescriptionDigest(sqlDefinition);
  const payload = { applicationId: id, definitionDigest: digest, executionManifestDigest: '12'.repeat(32), program };
  const schema = await signApplicationSchema(payload, a), invalid = await signApplicationSchema(payload, wrongSigner);
  const config: PeerApplicationConfiguration = { ...configuration([a]), definition: sqlDefinition, schema };
  expect((await peerApi(h, 'control', 'configure', { ...config, schema: invalid })).status).toBe(403);
  for (const field of ['applicationId', 'definitionDigest', 'executionManifestDigest'] as const) {
    const wrongBinding = await signApplicationSchema({ ...payload, [field]: '00'.repeat(32) }, a);
    expect((await peerApi(h, 'control', 'configure', { ...config, schema: wrongBinding })).status).toBe(400);
  }
  expect((await peerApi(h, 'control', 'configure', { ...config, schema: null })).status).toBe(400);
  expect((await peerApi(h, 'control', 'read')).status).toBe(409);
  const authority = await peerJson<AuthorityBundle>(h, 'control', 'configure', config);
  expect(authority.descriptor.payload.definitionDigest).toBe(digest);
  expect(authority.descriptor.payload.schemaDigest).toBe(await peerDigest(schema));
  expect(await peerJson<AuthorityBundle>(h, 'control', 'configure', config)).toEqual(authority);
  const publication = await peerJson(h, 'publication', 'definition');
  expect(publication).toEqual({ descriptor: authority.descriptor, definition: sqlDefinition, schema });
  expect((await verifyApplicationSchema(publication.schema, publication.descriptor.payload)).version).toBe(3);
  expect(await inDO(h.id, t => t.db.one("SELECT name FROM sqlite_master WHERE name='tasks'"))).toBeNull();
  await inDO(h.id, t => t.db.run('DELETE FROM membership_records WHERE key=?', 'peer-generation/identity'));
  expect((await peerApi(h, 'control', 'read')).status).toBe(503);
  expect(await peerJson(h, 'publication', 'definition')).toEqual(publication);
  await inDO(h.id, t => {
    const stored = t.db.get<any>('peer_generation_configuration', null);
    t.db.set('peer_generation_configuration', { ...stored, schema: { ...stored.schema, signature: '00'.repeat(64) } });
  });
  const corrupted = await peerApi(h, 'publication', 'definition');
  expect(corrupted.status).toBe(503);
  expect(await corrupted.json()).toMatchObject({ error: { code: 'peer_definition_state_mismatch' } });
});
