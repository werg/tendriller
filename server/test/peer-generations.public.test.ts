import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createPeerIdentity, signTransitionRequest, verifyAuthorityBundle, generationStartRoot,
  controlIntentDigest, peerDigest, controlParticipantGrant,
  type PeerIdentity, type PeerGrant, type AuthorityBundle, type SignedGeneration, type TransitionRequest } from '@chronolog/peer-generation/control';
import { peerAccountBindingsContext, type PeerControlUpdate } from '../../contract/peer-controls.mjs';
import { api, apiJson, create, inDO, req, type Handle } from './helpers';
import { createTestPage } from './public-fixture';
import { authenticateAgentToken } from '../src/access';
import { handlePeerGenerations } from '../src/peer-generations';

const grant = (peer: PeerIdentity, extra: Partial<PeerGrant> = {}): PeerGrant => ({ publicKey: peer.publicKey,
  reader: true, writer: true, coordinator: true, recovery: true, administrator: true, dataRole: 'member', ...extra });
const configuration = (peers: PeerIdentity[]) => ({ historyId: 'peer-history', executionManifestDigest: '12'.repeat(32),
  definitionDigest: '34'.repeat(32), schemaAdministrator: peers[0].publicKey, schemaDigest: null, epoch: 0, keyDigest: '56'.repeat(32),
  members: peers.map(peer => ({ grant: grant(peer) })) });
const applicationId = () => crypto.randomUUID().replaceAll('-', '').repeat(2);
type TransitionInput = Omit<TransitionRequest, 'controlIntentDigest' | 'contextDigest'>;
async function signRequest(authority: AuthorityBundle, payload: TransitionInput, signer: PeerIdentity, control?: PeerControlUpdate) {
  const previous = authority.controls[payload.controlRevision - 1];
  const selectedControl = control === undefined ? authority.controls[payload.controlRevision]!.payload : {
    ...previous!.payload, revision: payload.controlRevision, previous: await peerDigest(previous!),
    epoch: control.epoch, keyDigest: control.keyDigest, grants: control.grants, recoveryFloor: control.recoveryFloor,
  };
  const context = peerAccountBindingsContext(control?.accounts);
  return signTransitionRequest({ ...payload, controlIntentDigest: await controlIntentDigest(selectedControl),
    contextDigest: context === null ? null : await peerDigest(context) }, signer);
}
async function admittedGuest(h: Handle) {
  const account = crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(account, Date.now(), `${account}@example.test`).run();
  const linkId = await inDO(h.id, async t => {
    const link = await t.createLink('guest', 'generation recipient', null);
    t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)', account, link.id, t.now());
    return link.id;
  });
  return { account, linkId };
}
async function select(h: Handle, requester: PeerIdentity, coordinator: PeerIdentity, current: SignedGeneration | null, transitionId: string,
  overrides: Partial<TransitionRequest> = {}) {
  const authority = await apiJson<AuthorityBundle>(h, 'GET', 'peers/application');
  const payload: TransitionInput = { applicationId: authority.descriptor.payload.applicationId,
    profile: 'peer-generation-v1', policy: 'eligible-members-v1', transitionId, requester: requester.publicKey, coordinator: coordinator.publicKey,
    expectedGeneration: current?.id ?? null, controlRevision: current?.payload.controlRevision ?? 0,
    reason: current ? 'takeover' : 'create', base: current ? { point: { generation: current.id, sequence: 0, root: await generationStartRoot(current) }, receipt: null, bridge: [] } : null,
    ...overrides };
  const request = await signRequest(authority, payload, requester);
  return { request, response: await api(h, 'POST', 'peers/generations', { request }) };
}

it('publishes durable governance without a native resident, preserves root on restart, and returns exact lost selections', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const config = configuration([a, b]);
  const initial = await (await page.api('PUT', 'peers/application', config)).json() as AuthorityBundle;
  expect((await verifyAuthorityBundle(initial)).current).toBeNull();
  expect(initial.descriptor.payload.controlPublicKey).not.toBe(a.publicKey);
  const request = await signRequest(initial, { applicationId: initial.descriptor.payload.applicationId, profile: 'peer-generation-v1',
    policy: 'eligible-members-v1', transitionId: 'initial', requester: a.publicKey, coordinator: a.publicKey,
    expectedGeneration: null, controlRevision: 0, reason: 'create', base: null }, a);
  const response = await page.api('POST', 'peers/generations', { request });
  expect(response.status).toBe(200);
  const selected = await response.json();
  await page.restart();
  expect(await (await page.api('POST', 'peers/generations', { request })).json()).toEqual(selected);
  const resumed = await (await page.api('GET', 'peers/application')).json() as AuthorityBundle;
  expect((await verifyAuthorityBundle(resumed)).current?.id).toBe((selected as SignedGeneration).id);
  expect(resumed.descriptor).toEqual(initial.descriptor);
  expect((await page.api('PATCH', '', { lifetime: 'ad_hoc' })).status).toBe(409);
  expect(await (await page.api('PUT', 'peers/application', config)).json()).toEqual(resumed);
  expect((await page.api('PUT', 'peers/application', { ...config, definitionDigest: '78'.repeat(32) })).status).toBe(409);
});

it('selects one racing successor using the shared verifier and stores no application bodies', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity(), c = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  await apiJson(h, 'PUT', 'peers/application', configuration([a, b, c]));
  const first = await select(h, a, a, null, 'create');
  expect(first.response.status).toBe(200);
  const g0 = await first.response.json() as SignedGeneration;
  const racers = await Promise.all([select(h, b, b, g0, 'takeover-b'), select(h, c, c, g0, 'takeover-c')]);
  expect(racers.map(result => result.response.status).sort()).toEqual([200, 409]);
  const selected = await apiJson<AuthorityBundle>(h, 'GET', 'peers/application');
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
  await apiJson(h, 'PUT', 'peers/application', config);
  expect((await select(h, writer, a, null, 'unauthorized-recovery')).response.status).toBe(403);
  expect((await select(h, a, writer, null, 'ineligible-coordinator')).response.status).toBe(403);
  const stranger = await createPeerIdentity();
  expect((await select(h, stranger, a, null, 'unenrolled-requester')).response.status).toBe(403);
  expect((await req(`${h.api}/peers/application`, { anonymous: true })).status).toBe(401);
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const authority = await (await page.api('PUT', 'peers/application', configuration([a]))).json() as AuthorityBundle;
  const participant = await page.participant();
  const request = await signRequest(authority, { applicationId: authority.descriptor.payload.applicationId, profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    transitionId: 'wrong-account', expectedGeneration: null, requester: a.publicKey, coordinator: a.publicKey, reason: 'create', base: null, controlRevision: 0 }, a);
  expect((await participant.api('POST', 'peers/generations', { request })).status).toBe(403);
});

it('activates restrictive controls atomically, enforces key rotation, and keeps exact control retries after self-revocation', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const configured = await apiJson<AuthorityBundle>(h, 'PUT', 'peers/application', configuration([a, b]));
  const initial = await select(h, a, a, null, 'initial');
  const g0 = await initial.response.json() as SignedGeneration;
  const transition: TransitionInput = { ...initial.request.payload, transitionId: 'revoke-a', expectedGeneration: g0.id, coordinator: b.publicKey,
    reason: 'control-change', controlRevision: 1, base: { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] } };
  const grants = [grant(a, { reader: false, writer: false, coordinator: false, recovery: false, administrator: false, dataRole: null }),
    grant(b), controlParticipantGrant(configured.descriptor.payload.controlPublicKey)];
  const invalid = { epoch: 0, keyDigest: '56'.repeat(32), grants, recoveryFloor: null };
  const invalidRequest = await signRequest(configured, { ...transition, transitionId: 'invalid-rotation' }, a, invalid);
  expect((await api(h, 'POST', 'peers/generations', { request: invalidRequest, control: invalid })).status).toBe(400);
  expect((await apiJson<AuthorityBundle>(h, 'GET', 'peers/application')).controls).toHaveLength(1);
  const control = { ...invalid, epoch: 1, keyDigest: '89'.repeat(32) };
  const request = await signRequest(configured, transition, a, control);
  const result = await apiJson(h, 'POST', 'peers/generations', { request, control });
  expect(await apiJson(h, 'POST', 'peers/generations', { request, control })).toEqual(result);
  expect((await api(h, 'POST', 'peers/generations', { request, control: { ...control, keyDigest: '90'.repeat(32) } })).status).toBe(409);
  const authority = await verifyAuthorityBundle(await apiJson(h, 'GET', 'peers/application'));
  expect(authority.grant(a.publicKey)?.writer).toBe(false);
  expect(authority.control.payload.epoch).toBe(1);
  expect((await select(h, a, b, authority.current, 'revoked-a')).response.status).toBe(403);
});

it('binds first-use control policy and account additions to the device-signed intent', async () => {
  const owner = await createPeerIdentity(), newcomer = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const recipient = await admittedGuest(h), replacement = await admittedGuest(h);
  const initial = await apiJson<AuthorityBundle>(h, 'PUT', 'peers/application', configuration([owner]));
  const first = await select(h, owner, owner, null, 'initial');
  const generation = await first.response.json() as SignedGeneration;
  const control: PeerControlUpdate = { epoch: 0, keyDigest: '56'.repeat(32), recoveryFloor: null,
    grants: [grant(owner), grant(newcomer, { administrator: false }), controlParticipantGrant(initial.descriptor.payload.controlPublicKey)],
    accounts: [{ publicKey: newcomer.publicKey, accountId: recipient.account }] };
  const request = await signRequest(initial, { ...first.request.payload, transitionId: 'enroll-reviewed-device',
    expectedGeneration: generation.id, reason: 'control-change', controlRevision: 1,
    base: { point: { generation: generation.id, sequence: 0, root: await generationStartRoot(generation) }, receipt: null, bridge: [] } }, owner, control);

  const substitutedGrants = control.grants.map(value => value.publicKey === newcomer.publicKey ? { ...value, administrator: true } : value);
  const policyResponse = await api(h, 'POST', 'peers/generations', { request, control: { ...control, grants: substitutedGrants } });
  expect(policyResponse.status).toBe(403);
  expect(await policyResponse.json()).toMatchObject({ error: { code: 'peer_control_intent_mismatch' } });
  const accountResponse = await api(h, 'POST', 'peers/generations', { request, control: { ...control,
    accounts: [{ publicKey: newcomer.publicKey, accountId: replacement.account }] } });
  expect(accountResponse.status).toBe(403);
  expect(await accountResponse.json()).toMatchObject({ error: { code: 'peer_control_context_mismatch' } });
  expect((await apiJson<AuthorityBundle>(h, 'GET', 'peers/application')).controls).toHaveLength(1);
  expect(await inDO(h.id, t => t.db.get<{ publicKey: string }[]>('peer_generation_accounts', []).some(binding => binding.publicKey === newcomer.publicKey))).toBe(false);

  const selected = await apiJson<SignedGeneration>(h, 'POST', 'peers/generations', { request, control });
  expect(await apiJson(h, 'POST', 'peers/generations', { request, control })).toEqual(selected);
  const authority = await verifyAuthorityBundle(await apiJson(h, 'GET', 'peers/application'));
  expect(authority.grant(newcomer.publicKey)?.administrator).toBe(false);
  expect(await inDO(h.id, t => t.db.get<{ publicKey: string; accountId: string }[]>('peer_generation_accounts', []).find(binding => binding.publicKey === newcomer.publicKey)?.accountId)).toBe(recipient.account);
});

it('requires explicit member grants instead of choosing coordination and recovery privileges', async () => {
  const owner = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  expect((await api(h, 'PUT', 'peers/application', { ...configuration([owner]), members: [{ publicKey: owner.publicKey }] })).status).toBe(400);
  expect(await inDO(h.id, t => t.db.get('peer_generation_configuration', null))).toBeNull();
});

it('revokes an inactive enrolled account without granting it new rights or forgetting its binding', async () => {
  const owner = await createPeerIdentity(), guest = await createPeerIdentity(), newDevice = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const participant = await page.participant();
  const config = { ...configuration([owner, guest]), members: [
    { grant: grant(owner) }, { grant: grant(guest), accountId: participant.account },
  ] };
  const initial = await (await page.api('PUT', 'peers/application', config)).json() as AuthorityBundle;
  const first = await signRequest(initial, { applicationId: initial.descriptor.payload.applicationId, profile: 'peer-generation-v1',
    policy: 'eligible-members-v1', transitionId: 'initial', requester: owner.publicKey, coordinator: owner.publicKey,
    expectedGeneration: null, controlRevision: 0, reason: 'create', base: null }, owner);
  const g0 = await (await page.api('POST', 'peers/generations', { request: first })).json() as SignedGeneration;
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), participant.account).run();
  const transition: TransitionInput = { ...first.payload, transitionId: 'revoke-inactive', expectedGeneration: g0.id,
    reason: 'control-change', controlRevision: 1,
    base: { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] } };
  const hosted = controlParticipantGrant(initial.descriptor.payload.controlPublicKey);
  const control = { epoch: 1, keyDigest: '89'.repeat(32), recoveryFloor: null,
    grants: [grant(owner), grant(guest, { reader: false, writer: false, coordinator: false, recovery: false, administrator: false, dataRole: null }), hosted] };
  const denied: PeerControlUpdate[] = [
    { ...control, grants: [grant(owner), grant(guest), hosted] },
    ...(['member', 'admin'] as const).map(dataRole => ({ ...control, grants: [grant(owner), { ...control.grants[1]!, dataRole }, hosted] })),
    { ...control, accounts: [{ publicKey: newDevice.publicKey, accountId: participant.account }] },
  ];
  for (const [index, change] of denied.entries()) {
    const request = await signRequest(initial, { ...transition, transitionId: `inactive-rights-${index}` }, owner, change);
    expect((await page.api('POST', 'peers/generations', { request, control: change })).status).toBe(403);
  }
  expect((await (await page.api('GET', 'peers/application')).json() as AuthorityBundle).controls).toHaveLength(1);
  const request = await signRequest(initial, transition, owner, control);
  const response = await page.api('POST', 'peers/generations', { request, control });
  expect(response.status).toBe(200);
  const selected = await response.json();
  await page.restart();
  expect(await (await page.api('POST', 'peers/generations', { request, control })).json()).toEqual(selected);
  const authority = await verifyAuthorityBundle(await (await page.api('GET', 'peers/application')).json() as AuthorityBundle);
  expect(authority.control.payload.epoch).toBe(1);
  expect(authority.grant(guest.publicKey)).toEqual(control.grants[1]);
  const replacement = await page.participant();
  const reassignment = { ...control, accounts: [{ publicKey: guest.publicKey, accountId: replacement.account }] };
  const next = await signRequest(authority.bundle, { ...request.payload, transitionId: 'reassign-revoked-device',
    expectedGeneration: authority.current!.id, controlRevision: 2,
    base: { point: { generation: authority.current!.id, sequence: 0, root: await generationStartRoot(authority.current!) }, receipt: null, bridge: [] } }, owner, reassignment);
  expect((await page.api('POST', 'peers/generations', { request: next, control: reassignment })).status).toBe(409);
});

it('fences a missing control identity instead of silently generating a replacement', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const original = await apiJson<AuthorityBundle>(h, 'PUT', 'peers/application', configuration([a]));
  await inDO(h.id, t => t.db.run('DELETE FROM membership_records WHERE key=?', 'peer-generation/identity'));
  expect((await api(h, 'GET', 'peers/application')).status).toBe(503);
  expect((await api(h, 'PUT', 'peers/application', configuration([a]))).status).toBe(503);
  expect(await inDO(h.id, t => t.db.get<any>('peer_generation_configuration', null).descriptor)).toEqual(original.descriptor);
});

it('recovers through explicit owner control authority without a creator device key or data privileges', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const initial = await (await page.ownerApi('PUT', 'peers/application', { ...configuration([a, b]),
    members: [{ grant: grant(a, { administrator: false }) }, { grant: grant(b, { administrator: false }) }] })).json() as AuthorityBundle;
  const hosted = initial.descriptor.payload.controlPublicKey;
  expect(initial.controls[0].payload.grants).toEqual([grant(a, { administrator: false }), grant(b, { administrator: false }), controlParticipantGrant(hosted)]);
  const start = { transitionId: 'owner-create', expectedGeneration: null, coordinator: a.publicKey, controlRevision: 0, reason: 'create', base: null };
  const first = await page.ownerApi('POST', 'peers/administration', { transition: start });
  expect(first.status).toBe(200);
  const g0 = await first.json() as SignedGeneration;
  expect(g0.payload.transition.payload.requester).toBe(hosted);
  const base = { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] };
  const transition = { transitionId: 'creator-key-lost', expectedGeneration: g0.id, coordinator: b.publicKey, controlRevision: 1, reason: 'control-change', base };
  const control = { epoch: 1, keyDigest: '98'.repeat(32), grants: [grant(b, { administrator: false })], recoveryFloor: null };
  const guest = await page.participant();
  expect((await guest.api('POST', 'peers/administration', { transition, control })).status).toBe(403);
  expect((await page.ownerApi('POST', 'peers/administration', { transition,
    control: { ...control, grants: [...control.grants, { ...controlParticipantGrant(hosted), writer: true }] } })).status).toBe(403);
  const changed = await page.ownerApi('POST', 'peers/administration', { transition, control });
  expect(changed.status).toBe(200);
  const g1 = await changed.json() as SignedGeneration;
  await page.restart();
  expect(await (await page.ownerApi('POST', 'peers/administration', { transition, control })).json()).toEqual(g1);
  const authority = await verifyAuthorityBundle(await (await page.ownerApi('GET', 'peers/application')).json() as AuthorityBundle);
  expect(authority.current?.id).toBe(g1.id);
  expect(authority.grant(hosted)).toEqual(controlParticipantGrant(hosted));
  expect(authority.grant(a.publicKey)).toBeNull();
  const nextBase = { point: { generation: g1.id, sequence: 0, root: await generationStartRoot(g1) }, receipt: null, bridge: [] };
  expect((await page.ownerApi('POST', 'peers/administration', { transition: { ...transition,
    transitionId: 'host-cannot-coordinate', expectedGeneration: g1.id, coordinator: hosted, reason: 'takeover', base: nextBase } })).status).toBe(403);
  expect((await page.ownerApi('POST', 'peers/administration', { transition: { ...transition,
    transitionId: 'host-cannot-impersonate-handover', expectedGeneration: g1.id, reason: 'handover', base: nextBase } })).status).toBe(403);
});

it('lets the owner remove inactive accounts while retaining immutable enrollment provenance', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { kind: 'peer', id: applicationId() } });
  const guest = await page.participant();
  const configured = await page.ownerApi('PUT', 'peers/application', { ...configuration([a, b]),
    members: [{ grant: grant(a, { administrator: false }) }, { grant: grant(b, { administrator: false }), accountId: guest.account }] });
  expect(configured.status).toBe(200); await configured.text();
  const first = await page.ownerApi('POST', 'peers/administration', { transition: {
    transitionId: 'before-account-removal', expectedGeneration: null, coordinator: a.publicKey, controlRevision: 0, reason: 'create', base: null } });
  const g0 = await first.json() as SignedGeneration;
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), guest.account).run();
  const changed = await page.ownerApi('POST', 'peers/administration', {
    transition: { transitionId: 'remove-inactive', expectedGeneration: g0.id, coordinator: a.publicKey, controlRevision: 1, reason: 'control-change',
      base: { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] } },
    control: { epoch: 1, keyDigest: '98'.repeat(32), grants: [grant(a, { administrator: false })], recoveryFloor: null },
  });
  expect(changed.status).toBe(200); await changed.text();
  const authority = await verifyAuthorityBundle(await (await page.ownerApi('GET', 'peers/application')).json() as AuthorityBundle);
  expect(authority.grant(b.publicKey)).toBeNull();
});

it('rechecks local token revocation after asynchronous authorization before committing a generation', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const initial = await apiJson<AuthorityBundle>(h, 'PUT', 'peers/application', configuration([a]));
  const request = await signRequest(initial, { applicationId: initial.descriptor.payload.applicationId, profile: 'peer-generation-v1',
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
      await expect(handlePeerGenerations(t, new Request(`${h.api}/peers/generations`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request }) }), 'peers/generations', principal)).rejects.toMatchObject({ status: 403 });
      expect(changed).toBe(true);
    } finally { t.env.ACCOUNTS = original; }
  });
  const authority = await (await req(`${h.page_url}_tendril/peers/application`)).json() as AuthorityBundle;
  expect(authority.generations).toEqual([]);
});

it('does not enroll an account whose only approved invitation has expired', async () => {
  const owner = await createPeerIdentity(), guest = await createPeerIdentity();
  const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
  const recipient = await admittedGuest(h);
  await inDO(h.id, t => t.db.run('UPDATE links SET expires_at=? WHERE id=?', t.now() - 1, recipient.linkId));
  const config = { ...configuration([owner, guest]), members: [
    { grant: grant(owner) }, { grant: grant(guest), accountId: recipient.account },
  ] };
  expect((await api(h, 'PUT', 'peers/application', config)).status).toBe(403);
  expect(await inDO(h.id, t => t.db.get('peer_generation_configuration', null))).toBeNull();
  expect(await inDO(h.id, t => t.db.one('SELECT 1 FROM membership_records WHERE key=?', 'peer-generation/identity'))).toBeNull();
});

it('rechecks recipient admission after asynchronous account checks and at the control commit', async () => {
  for (const revokeAt of ['account-check', 'commit'] as const) {
    const owner = await createPeerIdentity(), guest = await createPeerIdentity();
    const h = await create({ application: { kind: 'peer', id: applicationId() }, mode: 'dashboard', listener: false });
    const recipient = await admittedGuest(h);
    await apiJson(h, 'PUT', 'peers/application', configuration([owner]));
    const initial = await apiJson<SignedGeneration>(h, 'POST', 'peers/administration', { transition: {
      transitionId: 'initial', expectedGeneration: null, coordinator: owner.publicKey, controlRevision: 0, reason: 'create', base: null,
    } });
    const body = {
      transition: { transitionId: `recipient-${revokeAt}`, expectedGeneration: initial.id, coordinator: owner.publicKey,
        controlRevision: 1, reason: 'control-change',
        base: { point: { generation: initial.id, sequence: 0, root: await generationStartRoot(initial) }, receipt: null, bridge: [] } },
      control: { epoch: 0, keyDigest: '56'.repeat(32), recoveryFloor: null,
        grants: [grant(owner, { administrator: false }), grant(guest, { administrator: false })],
        accounts: [{ publicKey: guest.publicKey, accountId: recipient.account }] },
    };
    await inDO(h.id, async t => {
      const principal = await authenticateAgentToken(t, h.token), originalAccounts = t.env.ACCOUNTS;
      const transaction = t.transaction.bind(t);
      let checks = 0, revoked = false;
      const revoke = () => { revoked = true; t.db.run('UPDATE links SET expires_at=? WHERE id=?', t.now() - 1, recipient.linkId); };
      if (revokeAt === 'account-check') {
        t.env.ACCOUNTS = { prepare(sql: string) {
          const statement = originalAccounts.prepare(sql);
          if (!sql.includes('FROM accounts WHERE id')) return statement;
          return { bind(...args: unknown[]) {
            const bound = statement.bind(...args);
            return { async first() {
              const result = await bound.first();
              if (args[0] === recipient.account && ++checks === 2) revoke();
              return result;
            } };
          } };
        } } as D1Database;
      } else t.transaction = <T>(write: () => T): T => { revoke(); return transaction(write); };
      try {
        await expect(handlePeerGenerations(t, new Request(`${h.api}/peers/administration`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), 'peers/administration', principal)).rejects.toMatchObject({ status: 403 });
        expect(revoked).toBe(true);
      } finally { t.env.ACCOUNTS = originalAccounts; t.transaction = transaction; }
    });
    const authority = await apiJson<AuthorityBundle>(h, 'GET', 'peers/application');
    expect(authority.controls).toHaveLength(1);
    expect(authority.generations.map(generation => generation.id)).toEqual([initial.id]);
    expect(await inDO(h.id, t => t.db.get<{ publicKey: string }[]>('peer_generation_accounts', []).some(binding => binding.publicKey === guest.publicKey))).toBe(false);
  }
});
