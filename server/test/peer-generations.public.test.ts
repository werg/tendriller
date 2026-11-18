import { peerApi, peerApiJson, peerOwnerApi, participantMessage, participantPayload } from './peer-exchange';
import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createPeerIdentity, signTransitionRequest, verifyAuthorityBundle, generationStartRoot,
  participantGrant, controlParticipantGrant, applicationDescriptionDigest, signApplicationSchema, verifyApplicationSchema, peerDigest,
  type ApplicationDescription, type PeerIdentity, type PeerGrant, type AuthorityBundle, type SignedGeneration, type TransitionRequest } from '@chronolog/peer-generation/control';
import type { PeerApplicationConfiguration } from '../../contract/peer-controls.mjs';
import { advance, api, apiJson, create, inDO, req, runAlarm, type Handle } from './helpers';
import { createTestPage } from './public-fixture';
import { authenticateAgentToken } from '../src/access';
import { exchangePeerControl } from '../src/peer-generations';
import { handlePeerParticipant } from '../src/peer-participant';
import { selectedApplication } from '../src/application';
import { ensurePeerControlIdentity, loadPeerControlIdentity } from '../src/peer-control-identity';
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

it('shares one durable control root when release bootstrap precedes application configuration', async () => {
  const device = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  const keys = await inDO(h.id, async t => (await Promise.all([
    ensurePeerControlIdentity(t), ensurePeerControlIdentity(t), ensurePeerControlIdentity(t),
  ])).map(identity => identity.publicKey));
  expect(new Set(keys).size).toBe(1);
  const authority = await peerApiJson<AuthorityBundle>(h, 'control/configure', configuration([device]));
  expect(authority.descriptor.payload.controlPublicKey).toBe(keys[0]);
  expect(await inDO(h.id, async t => (await loadPeerControlIdentity(t))?.publicKey)).toBe(keys[0]);
});

it('keeps the hosted control key bound once to the owner when supplied among devices', async () => {
  const device = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  const hosted = await inDO(h.id, async t => (await ensurePeerControlIdentity(t)).publicKey);
  const guest = await admitGuest(h);
  const config = configuration([device]);
  const grant = controlParticipantGrant(hosted);
  const forbidden = await peerApi(h, 'control/configure', { ...config, members: [...config.members, { grant, accountId: guest }] });
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toMatchObject({ error: { code: 'peer_host_control_account_immutable' } });
  const accepted = await peerApiJson<AuthorityBundle>(h, 'control/configure',
    { ...config, members: [...config.members, { grant }] });
  expect(accepted.descriptor.payload.controlPublicKey).toBe(hosted);
  const bindings = await inDO(h.id, async t => t.db.get<{ publicKey: string; accountId: string }[]>('peer_generation_accounts', []));
  expect(bindings.filter(binding => binding.publicKey === hosted)).toEqual([{ publicKey: hosted, accountId: await inDO(h.id, t => t.db.get('owner_account', '')) }]);
});

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
  const payload: TransitionRequest = { applicationId: (await peerApiJson<AuthorityBundle>(h, 'control/read')).descriptor.payload.applicationId,
    profile: 'peer-generation-v1', policy: 'eligible-members-v1', transitionId, requester: requester.publicKey, coordinator: coordinator.publicKey,
    expectedGeneration: current?.id ?? null, controlRevision: current?.payload.controlRevision ?? 0,
    reason: current ? 'takeover' : 'create', base: current ? { point: { generation: current.id, sequence: 0, root: await generationStartRoot(current) }, receipt: null, bridge: [] } : null,
    ...overrides };
  const request = await signTransitionRequest(payload, requester);
  return { request, response: await peerApi(h, 'control/select', { request }) };
}

it('publishes durable governance without a native resident, preserves root on restart, and returns exact lost selections', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const config = configuration([a, b]);
  const initial = await (await page.exchange('control/configure', config)).json() as AuthorityBundle;
  expect((await verifyAuthorityBundle(initial)).current).toBeNull();
  expect(initial.descriptor.payload.controlPublicKey).not.toBe(a.publicKey);
  const request = await signTransitionRequest({ applicationId: initial.descriptor.payload.applicationId, profile: 'peer-generation-v1',
    policy: 'eligible-members-v1', transitionId: 'initial', requester: a.publicKey, coordinator: a.publicKey,
    expectedGeneration: null, controlRevision: 0, reason: 'create', base: null }, a);
  const response = await page.exchange('control/select', { request });
  expect(response.status).toBe(200);
  const selected = await response.json();
  await page.restart();
  expect(await (await page.exchange('control/select', { request })).json()).toEqual(selected);
  const resumed = await (await page.exchange('control/read')).json() as AuthorityBundle;
  expect((await verifyAuthorityBundle(resumed)).current?.id).toBe((selected as SignedGeneration).id);
  expect(resumed.descriptor).toEqual(initial.descriptor);
  expect((await page.api('PATCH', '', { lifetime: 'ad_hoc' })).status).toBe(409);
  expect(await (await page.exchange('control/configure', config)).json()).toEqual(resumed);
  const changedDefinition = { ...definition, version: '2' };
  expect((await page.exchange('control/configure', { ...config, definition: changedDefinition })).status).toBe(409);
  expect(await (await page.exchange('publication/definition')).json()).toEqual({ descriptor: initial.descriptor, definition, schema: null });
});

it('refuses claim release and retains signed controls through expiry, alarm and restart', async () => {
  const a = await createPeerIdentity(), h = await create({ application: { id: applicationId() } });
  await peerApiJson(h, 'control/configure', configuration([a]));
  const selected = await select(h, a, a, null, 'retained-owner');
  expect(selected.response.status).toBe(200); await selected.response.text();
  const retained = await peerApiJson<AuthorityBundle>(h, 'control/read');
  const owner = await inDO(h.id, t => t.db.get('owner_account', null));

  const released = await api(h, 'POST', 'release');
  expect(released.status).toBe(409);
  expect(await released.json()).toMatchObject({ error: { code: 'peer_controls_require_owner' } });
  expect(await env.ACCOUNTS.prepare('SELECT owner_account FROM tendrils WHERE id=?').bind(h.id).first('owner_account')).toBe(owner);
  await advance(h.id, 2 * 86_400_000);
  await runAlarm(h.id);
  expect(await inDO(h.id, t => ({ owner: t.db.get('owner_account', null), lifetime: t.db.get('lifetime', null),
    expiresAt: t.expiresAt(), unclaimedSince: t.db.get('unclaimed_since', null),
    releases: t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM release_events')!.n })))
    .toEqual({ owner, lifetime: 'resident', expiresAt: null, unclaimedSince: null, releases: 0 });
  await inDO(h.id, t => { t.ctx.abort('Retained controls after rejected claim release'); }).catch(() => {});
  expect(await peerApiJson(h, 'control/read')).toEqual(retained);
});

it('releases an unconfigured claim and expires it without creating peer control state', async () => {
  const h = await create({ application: { id: applicationId() } });
  const released = await apiJson(h, 'POST', 'release');
  expect(released).toMatchObject({ released: true, expires_at: expect.any(Number) });
  expect(await inDO(h.id, t => ({ owner: t.db.get('owner_account', null), configured: t.db.get('peer_generation_configuration', null),
    records: t.db.all('SELECT key FROM participant_records'), expiresAt: t.expiresAt() })))
    .toEqual({ owner: null, configured: null, records: [], expiresAt: released.expires_at });
  expect(await env.ACCOUNTS.prepare('SELECT owner_account FROM tendrils WHERE id=?').bind(h.id).first('owner_account')).toBeNull();
  await advance(h.id, 2 * 86_400_000);
  await runAlarm(h.id);
  expect((await api(h, 'GET', '')).status).toBe(404);
});

it('returns the immutable canonical definition with its signed binding to admitted accounts after restart', async () => {
  const a = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const configured = await page.ownerExchange('control/configure', configuration([a]));
  expect(configured.status).toBe(200);
  const authority = await configured.json() as AuthorityBundle;
  await verifyAuthorityBundle(authority);
  const expected = { descriptor: authority.descriptor, definition, schema: null };
  const participant = await page.participant();
  const first = await participant.exchange('publication/definition');
  expect(first.status).toBe(200); expect(await first.json()).toEqual(expected);
  expect(await applicationDescriptionDigest(definition)).toBe(authority.descriptor.payload.definitionDigest);
  await page.restart();
  expect(await (await page.ownerExchange('publication/definition')).json()).toEqual(expected);
  const deniedWrite = await page.ownerExchange('publication/definition', definition);
  expect(deniedWrite.status).toBe(400);
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), participant.account).run();
  const denied = await participant.exchange('publication/definition');
  expect(denied.status).toBe(401);
  expect(denied.headers.get('Content-Type')).toContain('application/json');
  expect(await denied.text()).not.toContain(definitionDigest);
});

it('rejects missing, unknown, malformed and mismatched definition metadata before control or lifetime writes', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  const valid = configuration([a]);
  const { definition: omitted, ...missing } = valid;
  const variants = [missing, { ...valid, definition: { ...definition, unrecognized: true } },
    { ...valid, definition: { ...definition, commands: [{ ...definition.commands[0], input: { type: 'object', properties: {}, additionalProperties: true } }] } },
    { ...valid, definitionDigest: '78'.repeat(32) }, { ...valid, unknownMetadata: true }];
  const before = await inDO(h.id, t => t.db.get('lifetime', 'ad_hoc'));
  for (const input of variants) {
    expect((await peerApi(h, 'control/configure', input)).status).toBe(400);
    expect(await inDO(h.id, t => ({ configuration: t.db.get('peer_generation_configuration', null),
      accounts: t.db.get('peer_generation_accounts', null), retained: t.db.all("SELECT key FROM participant_records WHERE key LIKE 'peer-generation/%'"),
      lifetime: t.db.get('lifetime', 'ad_hoc') }))).toEqual({ configuration: null, accounts: null, retained: [], lifetime: before });
  }
  expect((await peerApi(h, 'control/configure', valid)).status).toBe(200);
  expect((await req(`${h.api}/peers/participant`, { anonymous: true })).status).toBe(401);
});

it('refuses a retained definition whose contents no longer match the signed descriptor', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  await peerApiJson(h, 'control/configure', configuration([a]));
  await inDO(h.id, t => {
    const current = t.db.get<any>('peer_generation_configuration', null);
    t.db.set('peer_generation_configuration', { ...current, definition: { ...current.definition, version: 'tampered' } });
  });
  const response = await peerApi(h, 'publication/definition');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'peer_definition_state_mismatch' } });
});

it('rechecks local access after asynchronous definition verification before disclosing its schemas', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  await peerApiJson(h, 'control/configure', configuration([a]));
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
      await expect(exchangePeerControl(t, principal, 'definition'))
        .rejects.toMatchObject({ status: 403 });
      expect(checked).toBe(true);
    } finally { t.env.ACCOUNTS = original; }
  });
});

it('selects one racing successor using the shared verifier and stores no application bodies', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity(), c = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  await peerApiJson(h, 'control/configure', configuration([a, b, c]));
  const first = await select(h, a, a, null, 'create');
  expect(first.response.status).toBe(200);
  const g0 = await first.response.json() as SignedGeneration;
  const racers = await Promise.all([select(h, b, b, g0, 'takeover-b'), select(h, c, c, g0, 'takeover-c')]);
  expect(racers.map(result => result.response.status).sort()).toEqual([200, 409]);
  const selected = await peerApiJson<AuthorityBundle>(h, 'control/read');
  expect(selected.generations).toHaveLength(2);
  await verifyAuthorityBundle(selected);
  expect(await inDO(h.id, t => ({ application: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='application_changes'"),
    records: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='record_log_entries'"), devices: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='devices'") })))
    .toEqual({ application: { n: 0 }, records: { n: 0 }, devices: { n: 0 } });
});

it('separately checks requester recovery, candidate eligibility, and the authenticated account binding', async () => {
  const a = await createPeerIdentity(), writer = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  const config = configuration([a, writer]); config.members[1].grant = grant(writer, { recovery: false, coordinator: false, administrator: false });
  await peerApiJson(h, 'control/configure', config);
  expect((await select(h, writer, a, null, 'unauthorized-recovery')).response.status).toBe(403);
  expect((await select(h, a, writer, null, 'ineligible-coordinator')).response.status).toBe(403);
  const stranger = await createPeerIdentity();
  expect((await select(h, stranger, a, null, 'unenrolled-requester')).response.status).toBe(403);
  expect((await req(`${h.api}/peers/participant`, { anonymous: true })).status).toBe(401);
  const page = await createTestPage({ application: { id: applicationId() } });
  const authority = await (await page.exchange('control/configure', configuration([a]))).json() as AuthorityBundle;
  const participant = await page.participant();
  const request = await signTransitionRequest({ applicationId: authority.descriptor.payload.applicationId, profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    transitionId: 'wrong-account', expectedGeneration: null, requester: a.publicKey, coordinator: a.publicKey, reason: 'create', base: null, controlRevision: 0 }, a);
  expect((await participant.exchange('control/select', { request })).status).toBe(403);
});

it('activates restrictive controls atomically, enforces key rotation, and keeps exact control retries after self-revocation', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  await peerApiJson(h, 'control/configure', configuration([a, b]));
  const initial = await select(h, a, a, null, 'initial');
  const g0 = await initial.response.json() as SignedGeneration;
  const request = await signTransitionRequest({ ...initial.request.payload, transitionId: 'revoke-a', expectedGeneration: g0.id, coordinator: b.publicKey,
    reason: 'control-change', controlRevision: 1, base: { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] } }, a);
  const grants = [grant(a, { reader: false, writer: false, coordinator: false, recovery: false, administrator: false, dataRole: null }), grant(b)];
  const invalid = { epoch: 0, keyDigest: '56'.repeat(32), grants, recoveryFloor: null };
  expect((await peerApi(h, 'control/select', { request, control: invalid })).status).toBe(400);
  expect((await peerApiJson<AuthorityBundle>(h, 'control/read')).controls).toHaveLength(1);
  const control = { ...invalid, epoch: 1, keyDigest: '89'.repeat(32) };
  const result = await peerApiJson(h, 'control/select', { request, control });
  expect(await peerApiJson(h, 'control/select', { request, control })).toEqual(result);
  expect((await peerApi(h, 'control/select', { request, control: { ...control, keyDigest: '90'.repeat(32) } })).status).toBe(409);
  const authority = await verifyAuthorityBundle(await peerApiJson(h, 'control/read'));
  expect(authority.grant(a.publicKey)?.writer).toBe(false);
  expect(authority.control.payload.epoch).toBe(1);
  expect((await select(h, a, b, authority.current, 'revoked-a')).response.status).toBe(403);
});

it('revokes an inactive enrolled account without granting it new rights or forgetting its binding', async () => {
  const owner = await createPeerIdentity(), guest = await createPeerIdentity(), newDevice = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const participant = await page.participant();
  const config = { ...configuration([owner, guest]), members: [
    { grant: grant(owner) }, { grant: grant(guest), accountId: participant.account },
  ] };
  const initial = await (await page.exchange('control/configure', config)).json() as AuthorityBundle;
  const first = await signTransitionRequest({ applicationId: initial.descriptor.payload.applicationId, profile: 'peer-generation-v1',
    policy: 'eligible-members-v1', transitionId: 'initial', requester: owner.publicKey, coordinator: owner.publicKey,
    expectedGeneration: null, controlRevision: 0, reason: 'create', base: null }, owner);
  const g0 = await (await page.exchange('control/select', { request: first })).json() as SignedGeneration;
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), participant.account).run();
  const request = await signTransitionRequest({ ...first.payload, transitionId: 'revoke-inactive', expectedGeneration: g0.id,
    reason: 'control-change', controlRevision: 1,
    base: { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] } }, owner);
  const control = { epoch: 1, keyDigest: '89'.repeat(32), recoveryFloor: null,
    grants: [grant(owner), grant(guest, { reader: false, writer: false, coordinator: false, recovery: false, administrator: false, dataRole: null })] };
  expect((await page.exchange('control/select', { request, control: { ...control, grants: [grant(owner), grant(guest)] } })).status).toBe(403);
  for (const dataRole of ['member', 'admin'] as const)
    expect((await page.exchange('control/select', { request, control: { ...control,
      grants: [grant(owner), { ...control.grants[1], dataRole }] } })).status).toBe(403);
  expect((await page.exchange('control/select', { request, control: { ...control,
    accounts: [{ publicKey: newDevice.publicKey, accountId: participant.account }] } })).status).toBe(403);
  expect((await (await page.exchange('control/read')).json() as AuthorityBundle).controls).toHaveLength(1);
  const response = await page.exchange('control/select', { request, control });
  expect(response.status).toBe(200);
  const selected = await response.json();
  await page.restart();
  expect(await (await page.exchange('control/select', { request, control })).json()).toEqual(selected);
  const authority = await verifyAuthorityBundle(await (await page.exchange('control/read')).json() as AuthorityBundle);
  expect(authority.control.payload.epoch).toBe(1);
  expect(authority.grant(guest.publicKey)).toEqual(control.grants[1]);
  const replacement = await page.participant();
  const next = await signTransitionRequest({ ...request.payload, transitionId: 'reassign-revoked-device',
    expectedGeneration: authority.current!.id, controlRevision: 2,
    base: { point: { generation: authority.current!.id, sequence: 0, root: await generationStartRoot(authority.current!) }, receipt: null, bridge: [] } }, owner);
  expect((await page.exchange('control/select', { request: next,
    control: { ...control, accounts: [{ publicKey: guest.publicKey, accountId: replacement.account }] } })).status).toBe(409);
});

it('fences a missing control identity instead of silently generating a replacement', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  const original = await peerApiJson<AuthorityBundle>(h, 'control/configure', configuration([a]));
  await inDO(h.id, t => t.db.run('DELETE FROM participant_records WHERE key=?', 'peer-generation/identity'));
  expect((await peerApi(h, 'control/read')).status).toBe(503);
  expect((await peerApi(h, 'control/configure', configuration([a]))).status).toBe(503);
  expect(await inDO(h.id, t => t.db.get<any>('peer_generation_configuration', null).descriptor)).toEqual(original.descriptor);
});

it('bounds admitted control bodies before reading and releases slots after body failure', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  await peerApiJson(h, 'control/configure', configuration([a]));
  await inDO(h.id, async t => {
    const principal = await authenticateAgentToken(t, h.token), controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pending: Promise<unknown>[] = [], url = 'https://page.example/_tendril/peers/participant';
    const request = (operation: string) => new Request(url, { method: 'POST', body: JSON.stringify(participantMessage(selectedApplication(t).id, operation)) });
    let excessReads = 0;
    try {
      for (let index = 0; index < 4; index++) {
        const body = new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } }, { highWaterMark: 0 });
        const operation = handlePeerParticipant(t, new Request(url, { method: 'POST', body }), principal);
        pending.push(operation); void operation.catch(() => {});
        if (index === 0) {
          const available = await handlePeerParticipant(t, request('control/read'), principal);
          expect(available.status).toBe(200);
        }
      }
      const extra = new Request(url, { method: 'POST', body: new ReadableStream<Uint8Array>({ pull(controller) {
        excessReads++; controller.enqueue(new TextEncoder().encode('{}')); controller.close();
      } }, { highWaterMark: 0 }) });
      await expect(handlePeerParticipant(t, extra, principal))
        .rejects.toMatchObject({ status: 429, code: 'peer_participant_busy' });
      await expect(handlePeerParticipant(t, request('publication/definition'), principal))
        .rejects.toMatchObject({ status: 429, code: 'peer_participant_busy' });
      expect(excessReads).toBe(0);
    } finally {
      for (const controller of controllers) { try { controller.error(new Error('test body stopped')); } catch { /* Already closed. */ } }
      await Promise.allSettled(pending);
    }
    expect((await handlePeerParticipant(t, request('control/read'), principal)).status).toBe(200);
  });
});

for (const phase of ['initial configuration', 'control update', 'owner control update'] as const) {
  it(`rechecks target admission at the ${phase} commit after signing preparation`, async () => {
    const a = await createPeerIdentity(), b = await createPeerIdentity();
    const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
    const account = await admitGuest(h);
    let action: 'configure' | 'select' | 'administer' = 'configure', body: unknown = { ...configuration([a]),
      members: [{ grant: grant(a) }, { grant: grant(b), accountId: account }] };
    let before: AuthorityBundle | null = null;
    if (phase !== 'initial configuration') {
      await peerApiJson(h, 'control/configure', configuration([a]));
      const initial = await select(h, a, a, null, 'initial'), current = await initial.response.json() as SignedGeneration;
      before = await peerApiJson<AuthorityBundle>(h, 'control/read');
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
        await expect(exchangePeerControl(t, principal, action, body))
          .rejects.toMatchObject({ status: 403, code: 'forbidden' });
      });
      expect(t.db.get<{ publicKey: string }[]>('peer_generation_accounts', []).some(binding => binding.publicKey === b.publicKey)).toBe(false);
      if (phase === 'initial configuration') {
        expect(t.db.get('peer_generation_configuration', null)).toBeNull();
        expect(t.db.all("SELECT key FROM participant_records WHERE key LIKE 'peer-generation/%'")).toEqual([]);
      }
    });
    if (before) expect(await peerApiJson(h, 'control/read')).toEqual(before);
  });
}

it('can revoke an inactive account while retaining its immutable enrollment for exact retries', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  const account = await admitGuest(h);
  await peerApiJson(h, 'control/configure', { ...configuration([a]), members: [{ grant: grant(a) }, { grant: grant(b), accountId: account }] });
  const initial = await select(h, a, a, null, 'initial'), current = await initial.response.json() as SignedGeneration;
  await inDO(h.id, async t => {
    t.db.run('DELETE FROM guest_accounts WHERE account_id=?', account);
    await t.env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(t.now(), account).run();
  });
  const request = await signTransitionRequest({ ...initial.request.payload, transitionId: 'revoke-b', expectedGeneration: current.id,
    controlRevision: 1, reason: 'control-change', base: { point: { generation: current.id, sequence: 0, root: await generationStartRoot(current) }, receipt: null, bridge: [] } }, a);
  const control = { epoch: 1, keyDigest: '89'.repeat(32), recoveryFloor: null,
    grants: [grant(a), grant(b, { reader: false, writer: false, coordinator: false, recovery: false, administrator: false, dataRole: null })] };
  const selected = await peerApiJson(h, 'control/select', { request, control });
  expect(await peerApiJson(h, 'control/select', { request, control })).toEqual(selected);
  const authority = await verifyAuthorityBundle(await peerApiJson(h, 'control/read'));
  expect(authority.grant(b.publicKey)?.reader).toBe(false);
  expect(await inDO(h.id, t => t.db.get<any[]>('peer_generation_accounts', []).find(binding => binding.publicKey === b.publicKey)))
    .toEqual({ publicKey: b.publicKey, accountId: account });
});

it('recovers through explicit owner control authority without a creator device key or data privileges', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const initial = await (await page.ownerExchange('control/configure', { ...configuration([a, b]),
    members: [{ publicKey: a.publicKey }, { publicKey: b.publicKey }] })).json() as AuthorityBundle;
  const hosted = initial.descriptor.payload.controlPublicKey;
  expect(initial.controls[0].payload.grants).toEqual([participantGrant(a.publicKey), participantGrant(b.publicKey), controlParticipantGrant(hosted)]);
  const start = { transitionId: 'owner-create', expectedGeneration: null, coordinator: a.publicKey, controlRevision: 0, reason: 'create', base: null };
  const first = await page.ownerExchange('control/administer', { transition: start });
  expect(first.status).toBe(200);
  const g0 = await first.json() as SignedGeneration;
  expect(g0.payload.transition.payload.requester).toBe(hosted);
  const base = { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] };
  const transition = { transitionId: 'creator-key-lost', expectedGeneration: g0.id, coordinator: b.publicKey, controlRevision: 1, reason: 'control-change', base };
  const control = { epoch: 1, keyDigest: '98'.repeat(32), grants: [participantGrant(b.publicKey)], recoveryFloor: null };
  const guest = await page.participant();
  expect((await guest.exchange('control/administer', { transition, control })).status).toBe(403);
  expect((await page.ownerExchange('control/administer', { transition,
    control: { ...control, grants: [...control.grants, { ...controlParticipantGrant(hosted), writer: true }] } })).status).toBe(403);
  const changed = await page.ownerExchange('control/administer', { transition, control });
  expect(changed.status).toBe(200);
  const g1 = await changed.json() as SignedGeneration;
  await page.restart();
  expect(await (await page.ownerExchange('control/administer', { transition, control })).json()).toEqual(g1);
  const authority = await verifyAuthorityBundle(await (await page.ownerExchange('control/read')).json() as AuthorityBundle);
  expect(authority.current?.id).toBe(g1.id);
  expect(authority.grant(hosted)).toEqual(controlParticipantGrant(hosted));
  expect(authority.grant(a.publicKey)).toBeNull();
  const nextBase = { point: { generation: g1.id, sequence: 0, root: await generationStartRoot(g1) }, receipt: null, bridge: [] };
  expect((await page.ownerExchange('control/administer', { transition: { ...transition,
    transitionId: 'host-cannot-coordinate', expectedGeneration: g1.id, coordinator: hosted, reason: 'takeover', base: nextBase } })).status).toBe(403);
  expect((await page.ownerExchange('control/administer', { transition: { ...transition,
    transitionId: 'host-cannot-impersonate-handover', expectedGeneration: g1.id, reason: 'handover', base: nextBase } })).status).toBe(403);
});

it('lets the owner remove inactive accounts while retaining immutable enrollment provenance', async () => {
  const a = await createPeerIdentity(), b = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const guest = await page.participant();
  const configured = await page.ownerExchange('control/configure', { ...configuration([a, b]),
    members: [{ publicKey: a.publicKey }, { publicKey: b.publicKey, accountId: guest.account }] });
  expect(configured.status).toBe(200); await configured.text();
  const first = await page.ownerExchange('control/administer', { transition: {
    transitionId: 'before-account-removal', expectedGeneration: null, coordinator: a.publicKey, controlRevision: 0, reason: 'create', base: null } });
  const g0 = await first.json() as SignedGeneration;
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), guest.account).run();
  const changed = await page.ownerExchange('control/administer', {
    transition: { transitionId: 'remove-inactive', expectedGeneration: g0.id, coordinator: a.publicKey, controlRevision: 1, reason: 'control-change',
      base: { point: { generation: g0.id, sequence: 0, root: await generationStartRoot(g0) }, receipt: null, bridge: [] } },
    control: { epoch: 1, keyDigest: '98'.repeat(32), grants: [participantGrant(a.publicKey)], recoveryFloor: null },
  });
  expect(changed.status).toBe(200); await changed.text();
  const authority = await verifyAuthorityBundle(await (await page.ownerExchange('control/read')).json() as AuthorityBundle);
  expect(authority.grant(b.publicKey)).toBeNull();
});

it('requires explicit publisher enrollment and rechecks publication-only account rights during control changes', async () => {
  const coordinator = await createPeerIdentity(), publisher = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const guest = await page.participant();
  const publicationOnly = { ...participantGrant(publisher.publicKey, { publisher: true }),
    reader: false, writer: false, coordinator: false, recovery: false, dataRole: null };
  const configured = await page.ownerExchange('control/configure', { ...configuration([coordinator]),
    members: [{ publicKey: coordinator.publicKey, publisher: true }, { grant: publicationOnly, accountId: guest.account }] });
  expect(configured.status).toBe(200);
  const initial = await configured.json() as AuthorityBundle;
  expect((await verifyAuthorityBundle(initial)).grant(coordinator.publicKey)).toMatchObject({ publisher: true, administrator: false });
  const first = await page.ownerExchange('control/administer', { transition: { transitionId: 'before-publisher-suspension',
    expectedGeneration: null, coordinator: coordinator.publicKey, controlRevision: 0, reason: 'create', base: null } });
  const generation = await first.json() as SignedGeneration;
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), guest.account).run();
  const transition = { transitionId: 'publisher-control-change', expectedGeneration: generation.id, coordinator: coordinator.publicKey,
    controlRevision: 1, reason: 'control-change', base: { point: { generation: generation.id, sequence: 0,
      root: await generationStartRoot(generation) }, receipt: null, bridge: [] } };
  const control = { epoch: 0, keyDigest: '56'.repeat(32), recoveryFloor: null,
    grants: [participantGrant(coordinator.publicKey), publicationOnly] };
  expect((await page.ownerExchange('control/administer', { transition, control })).status).toBe(403);
  const revoked = await page.ownerExchange('control/administer', { transition,
    control: { ...control, grants: [control.grants[0], { ...publicationOnly, publisher: false }] } });
  expect(revoked.status).toBe(200); await revoked.text();
  expect((await verifyAuthorityBundle(await (await page.ownerExchange('control/read')).json() as AuthorityBundle)).grant(publisher.publicKey)?.publisher).toBe(false);
});

it('rechecks local token revocation after asynchronous authorization before committing a generation', async () => {
  const a = await createPeerIdentity();
  const h = await create({ application: { id: applicationId() }, mode: 'dashboard', listener: false });
  const initial = await peerApiJson<AuthorityBundle>(h, 'control/configure', configuration([a]));
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
      await expect(exchangePeerControl(t, principal, 'select', { request })).rejects.toMatchObject({ status: 403 });
      expect(changed).toBe(true);
    } finally { t.env.ACCOUNTS = original; }
  });
  const authority = await (await peerOwnerApi(h, 'control/read')).json() as AuthorityBundle;
  expect(authority.generations).toEqual([]);
});

it('requires immutable canonical public command/query metadata before publishing authority', async () => {
  const a = await createPeerIdentity();
  const page = await createTestPage({ application: { id: applicationId() } });
  const config = configuration([a]), { definition: omitted, ...missing } = config;
  expect((await page.exchange('publication/definition')).status).toBe(409);
  expect((await page.exchange('control/configure', missing)).status).toBe(400);
  expect((await page.exchange('control/configure', { ...config, definitionDigest: await applicationDescriptionDigest(definition) })).status).toBe(400);
  expect((await page.exchange('control/configure', { ...config, definition: { ...definition,
    commands: [{ ...definition.commands[0], input: { type: 'object', properties: {} } }] } })).status).toBe(400);
  expect((await page.exchange('control/configure', { ...config, schemaDigest: null })).status).toBe(400);
  expect((await page.exchange('control/read')).status).toBe(409);
  const configured = await page.exchange('control/configure', config);
  expect(configured.status).toBe(200);
  const authority = await configured.json() as AuthorityBundle;
  const participant = await page.participant();
  const published = await (await participant.exchange('publication/definition')).json() as { descriptor: AuthorityBundle['descriptor']; definition: ApplicationDescription; schema: null };
  expect(published).toEqual({ descriptor: authority.descriptor, definition, schema: null });
  expect(await applicationDescriptionDigest(published.definition)).toBe(authority.descriptor.payload.definitionDigest);
  expect(authority.descriptor.payload.schemaDigest).toBeNull();
  expect(await (await page.exchange('control/configure', { ...config, schema: null })).json()).toEqual(authority);
  void omitted;
});

it('retains a verified signed genesis schema as metadata without executing SQL on the control host', async () => {
  const a = await createPeerIdentity(), wrongSigner = await createPeerIdentity(), id = applicationId();
  const h = await create({ application: { id }, listener: false, mode: 'dashboard' });
  // Public Chronolog encodeChangeProgram(program('CREATE TABLE tasks (id INTEGER PRIMARY KEY)')).
  const program = 'a2000301818200a200782b435245415445205441424c45207461736b732028696420494e5445474552205052494d415259204b4559290180';
  const sqlDefinition: ApplicationDescription = { ...definition, id: 'sql-test', schema: program };
  const digest = await applicationDescriptionDigest(sqlDefinition);
  const payload = { applicationId: id, definitionDigest: digest, executionManifestDigest: '12'.repeat(32), program };
  const schema = await signApplicationSchema(payload, a), invalid = await signApplicationSchema(payload, wrongSigner);
  const config: PeerApplicationConfiguration = { ...configuration([a]), definition: sqlDefinition, schema };
  expect((await peerApi(h, 'control/configure', { ...config, schema: invalid })).status).toBe(403);
  for (const field of ['applicationId', 'definitionDigest', 'executionManifestDigest'] as const) {
    const wrongBinding = await signApplicationSchema({ ...payload, [field]: '00'.repeat(32) }, a);
    expect((await peerApi(h, 'control/configure', { ...config, schema: wrongBinding })).status).toBe(400);
  }
  expect((await peerApi(h, 'control/configure', { ...config, schema: null })).status).toBe(400);
  expect((await peerApi(h, 'control/read')).status).toBe(409);
  const authority = await peerApiJson<AuthorityBundle>(h, 'control/configure', config);
  expect(authority.descriptor.payload.definitionDigest).toBe(digest);
  expect(authority.descriptor.payload.schemaDigest).toBe(await peerDigest(schema));
  expect(await peerApiJson<AuthorityBundle>(h, 'control/configure', config)).toEqual(authority);
  const publication = await peerApiJson(h, 'publication/definition');
  expect(publication).toEqual({ descriptor: authority.descriptor, definition: sqlDefinition, schema });
  expect((await verifyApplicationSchema(publication.schema, publication.descriptor.payload)).version).toBe(3);
  expect(await inDO(h.id, t => t.db.one("SELECT name FROM sqlite_master WHERE name='tasks'"))).toBeNull();
  await inDO(h.id, t => t.db.run('DELETE FROM participant_records WHERE key=?', 'peer-generation/identity'));
  expect((await peerApi(h, 'control/read')).status).toBe(503);
  expect(await peerApiJson(h, 'publication/definition')).toEqual(publication);
  await inDO(h.id, t => {
    const stored = t.db.get<any>('peer_generation_configuration', null);
    t.db.set('peer_generation_configuration', { ...stored, schema: { ...stored.schema, signature: '00'.repeat(64) } });
  });
  const corrupted = await peerApi(h, 'publication/definition');
  expect(corrupted.status).toBe(503);
  expect(await corrupted.json()).toMatchObject({ error: { code: 'peer_definition_state_mismatch' } });
});
