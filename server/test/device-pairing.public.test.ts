import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createPeerIdentity, signTransitionRequest, generationStartRoot, participantGrant, verifyAuthorityBundle, peerDigest,
  type PeerIdentity, type AuthorityBundle, type SignedGeneration } from '@chronolog/peer-generation/control';
import { DEVICE_PAIRING_LIMITS, pairingProofBytes, signDevicePairingChallenge, type DevicePairingStatus, type DevicePairingPrepared } from '../../contract/pairing.mjs';
import { agentPrincipal, api, apiJson, create, req, inDO, advance, type Handle } from './helpers';
import { peerApiJson } from './peer-exchange';
import { sha256Hex } from '../src/ids';
import { handleDevicePairing } from '../src/device-pairing';

async function fixture() {
  const native = await createPeerIdentity(), device = await createPeerIdentity();
  const h = await create({ application: { id: crypto.randomUUID().replaceAll('-', '').repeat(2) } });
  const bundle = await peerApiJson<AuthorityBundle>(h, 'control/configure', { historyId: 'pairing-test', executionManifestDigest: 'ab'.repeat(32),
    definition: { id: 'pairing-test', version: '1', schema: null, commands: [], queries: [] }, schemaAdministrator: native.publicKey,
    epoch: 0, keyDigest: 'cd'.repeat(32), members: [{ grant: participantGrant(native.publicKey, { administrator: true }) }] });
  const initial = await signTransitionRequest({ applicationId: bundle.descriptor.payload.applicationId, profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    transitionId: 'initial', requester: native.publicKey, coordinator: native.publicKey, expectedGeneration: null, controlRevision: 0, reason: 'create', base: null }, native);
  await peerApiJson(h, 'control/select', { request: initial });
  const owner = await inDO(h.id, t => t.db.get<string>('owner_account', ''));
  const raw = 'pair-review-' + crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)').bind(await sha256Hex(raw), owner, Date.now(), Date.now() + 86400000).run();
  return { h, native, device, owner, cookie: `__Host-tendriller=${raw}` };
}
async function browser(h: Handle, input?: unknown, id?: string, headers: Record<string, string> = {}): Promise<Response> {
  return req(`${h.page_url}_tendril/peers/pairing${id ? '?pairingId=' + id : ''}`, input === undefined ? { headers } :
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
}
async function jsonResponse<T = DevicePairingStatus>(response: Response, expected = 200): Promise<T> {
  const text = await response.text(); expect(response.status, text).toBe(expected); return JSON.parse(text) as T;
}
async function challenge(h: Handle, device: PeerIdentity, requestId = crypto.randomUUID()) {
  return jsonResponse(await browser(h, { action: 'challenge', requestId, publicKey: device.publicKey, rights: { reader: true, writer: true } }));
}
async function proven(h: Handle, device: PeerIdentity) {
  const c = await challenge(h, device);
  return jsonResponse(await browser(h, { action: 'prove', pairingId: c.pairingId, signature: await signDevicePairingChallenge(c.challenge, device) }));
}
async function prepare(h: Handle, native: PeerIdentity, status: DevicePairingStatus): Promise<DevicePairingPrepared> {
  const authority = await verifyAuthorityBundle(await peerApiJson<AuthorityBundle>(h, 'control/read'));
  const c = status.challenge, current = authority.current!, control = authority.control.payload;
  const request = await signTransitionRequest({ applicationId: c.applicationId, profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    transitionId: `pair-${c.pairingId}`, requester: native.publicKey, coordinator: current.payload.coordinator,
    expectedGeneration: c.expectedGeneration, controlRevision: c.controlRevision + 1, reason: 'control-change',
    base: { point: { generation: current.id, sequence: 0, root: await generationStartRoot(current) }, receipt: null, bridge: [] } }, native);
  return { request, control: { epoch: control.epoch, keyDigest: control.keyDigest, recoveryFloor: control.recoveryFloor,
    grants: [...control.grants, { publicKey: c.publicKey, reader: true, writer: c.rights.writer, coordinator: false, recovery: false, administrator: false, publisher: false, dataRole: 'member' }],
    accounts: [{ publicKey: c.publicKey, accountId: c.accountId }] } };
}
const commit = (h: Handle, status: DevicePairingStatus, prepared: DevicePairingPrepared) => api(h, 'POST', 'peers/pairing', { action: 'commit', pairingId: status.pairingId, ...prepared });
const stage = (h: Handle, status: DevicePairingStatus, prepared: DevicePairingPrepared) => api(h, 'POST', 'peers/pairing', { action: 'prepare', pairingId: status.pairingId, ...prepared });
async function guest(h: Handle) {
  const accountId = crypto.randomUUID(), raw = 'guest-' + crypto.randomUUID(), hash = await sha256Hex(raw);
  await env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(accountId, Date.now(), `${accountId}@example.test`).run();
  const link = await inDO(h.id, async t => {
    const link = await t.createLink('guest', 'Pairing guest', null);
    t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)', accountId, link.id, t.now());
    t.db.run('INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,?,?)', hash, accountId, 'guest', t.now() + 86400000);
    return { id: link.id, key: link.key };
  });
  const url = new URL(h.page_url); url.pathname = `/s/${link.key}/`;
  return { accountId, linkId: link.id, handle: { ...h, page_url: url.href }, headers: { Cookie: `__Host-tendril=${raw}`, Origin: url.origin } };
}

it('retains one exact challenge across duplicates and restart without granting authority', async () => {
  const { h, device } = await fixture(), id = crypto.randomUUID();
  const [a, b] = await Promise.all([challenge(h, device, id), challenge(h, device, id)]);
  expect(a).toEqual(b); expect(a.state).toBe('challenge');
  await inDO(h.id, t => t.ctx.abort('Retain the pairing challenge')).catch(() => {});
  expect(await challenge(h, device, id)).toEqual(a);
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).grant(device.publicKey)).toBeNull();
  const changed = await browser(h, { action: 'challenge', requestId: id, publicKey: (await createPeerIdentity()).publicKey, rights: { reader: true, writer: true } });
  await jsonResponse(changed, 409);
  expect(await inDO(h.id, t => t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM device_pairings')!.n)).toBe(1);
});

it('requires the page session, correct origin and exact private-key proof; invalid attempts are bounded', async () => {
  const { h, device } = await fixture(), c = await challenge(h, device), wrong = await createPeerIdentity();
  const wrongSignature = await signDevicePairingChallenge({ ...c.challenge, publicKey: wrong.publicKey }, wrong);
  for (let i = 0; i < DEVICE_PAIRING_LIMITS.invalidProofs; i++) await jsonResponse(await browser(h, { action: 'prove', pairingId: c.pairingId, signature: wrongSignature }), 403);
  expect((await jsonResponse(await browser(h, undefined, c.pairingId))).state).toBe('denied');
  expect((await req(`${h.page_url}_tendril/peers/pairing`, { anonymous: true, redirect: 'manual', headers: { Accept: 'application/json' } })).status).not.toBe(200);
  expect((await req(`${h.page_url}_tendril/peers/pairing`, { method: 'POST', headers: { Origin: 'https://wrong.example', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
  await jsonResponse(await browser(h, { action: 'challenge', requestId: crypto.randomUUID(), publicKey: device.publicKey, rights: { reader: true, writer: true, administrator: true } }), 400);
});

async function provenGuest(h: Handle, device: PeerIdentity) {
  const g = await guest(h);
  const c = await jsonResponse(await browser(g.handle, { action: 'challenge', requestId: crypto.randomUUID(), publicKey: device.publicKey, rights: { reader: true, writer: true } }, undefined, g.headers));
  const status = await jsonResponse(await browser(g.handle, { action: 'prove', pairingId: c.pairingId, signature: await signDevicePairingChallenge(c.challenge, device) }, undefined, g.headers));
  return { g, status };
}

it('auto-approves both owner and admitted guest browsers on stage so joining goes in one go', async () => {
  const { h, native, device } = await fixture(), c = await proven(h, device), prepared = await prepare(h, native, c);
  const staged = await jsonResponse(await stage(h, c, prepared));
  expect(staged.state).toBe('approved');
  expect(staged.preparedDigest).toBe(await peerDigest(prepared));
  const committed = await jsonResponse(await commit(h, c, prepared));
  expect(committed.state).toBe('committed');
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).grant(device.publicKey)?.writer).toBe(true);

  const guestDevice = await createPeerIdentity();
  const { status: gc } = await provenGuest(h, guestDevice), gPrepared = await prepare(h, native, gc);
  const gStaged = await jsonResponse(await stage(h, gc, gPrepared));
  expect(gStaged.state).toBe('approved');
  const gCommitted = await jsonResponse(await commit(h, gc, gPrepared));
  expect(gCommitted.state).toBe('committed');
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).grant(guestDevice.publicKey)?.writer).toBe(true);
});

it('prepares one verified immutable proposal without selecting authority before commit', async () => {
  const { h, native, device, cookie } = await fixture(), { g, status: c } = await provenGuest(h, device), prepared = await prepare(h, native, c);
  const before = await peerApiJson<AuthorityBundle>(h, 'control/read');
  expect((await apiJson(h, 'GET', 'peers/pairing')).pairings).toEqual([c]);
  const base = prepared.request.payload.base!;
  const invalidPrefix = { ...prepared, request: await signTransitionRequest({ ...prepared.request.payload,
    base: { ...base, point: { ...base.point, root: '00'.repeat(32) } } }, native) };
  const refused = await stage(h, c, invalidPrefix);
  expect(refused.status).not.toBe(200); await refused.text();
  expect((await apiJson(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId)).prepared).toBeUndefined();
  const staged = await jsonResponse(await stage(h, c, prepared));
  expect(staged.state).toBe('approved'); expect(staged.prepared).toEqual(prepared);
  expect(staged.preparedDigest).toBe(await peerDigest(prepared));
  expect(await peerApiJson(h, 'control/read')).toEqual(before);
  expect(await inDO(h.id, t => t.db.get<{ publicKey: string }[]>('peer_generation_accounts', []).some(row => row.publicKey === device.publicKey))).toBe(false);
  const publicStatus = await jsonResponse(await browser(g.handle, undefined, c.pairingId, g.headers));
  expect(publicStatus.preparedDigest).toBe(staged.preparedDigest); expect(publicStatus.prepared).toBeUndefined();
  await inDO(h.id, t => t.ctx.abort('Retain the exact prepared proposal')).catch(() => {});
  expect(await jsonResponse(await stage(h, c, prepared))).toEqual(staged);
  const changed = { ...prepared, control: { ...prepared.control, grants: [...prepared.control.grants].reverse() } };
  await jsonResponse(await stage(h, c, changed), 409);
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).grant(device.publicKey)).toBeNull();
});

it('has no approval screen: legacy review links only return the browser and accept no decisions', async () => {
  const { h, native, device, cookie } = await fixture(), c = await proven(h, device), prepared = await prepare(h, native, c);
  const staged = await jsonResponse(await stage(h, c, prepared));
  expect(staged.state).toBe('approved');
  const page = new URL('some/view?tab=2#data', h.page_url).href;
  const back = await req(`${c.reviewUrl}?return_to=${encodeURIComponent(page)}`, { redirect: 'manual', anonymous: true });
  expect(back.status).toBe(303); expect(back.headers.get('Location')).toBe(page);
  const bare = await req(c.reviewUrl, { redirect: 'manual', headers: { Cookie: cookie } });
  expect(bare.status).toBe(303); expect(bare.headers.get('Location')).toBe(new URL(c.challenge.pageOrigin).href);
  for (const wrong of ['https://evil.example/', h.api, `${c.challenge.serviceOrigin}/dashboard`, `blob:${c.challenge.pageOrigin}/not-a-page`, `${c.challenge.pageOrigin.replace('https://', 'https://user@')}/`])
    expect((await req(`${c.reviewUrl}?return_to=${encodeURIComponent(wrong)}`, { redirect: 'manual' })).status).toBe(400);
  expect((await req(`${c.reviewUrl}?other=1`, { redirect: 'manual' })).status).toBe(400);
  const posted = await req(c.reviewUrl, { method: 'POST', headers: { Cookie: cookie, Origin: c.challenge.serviceOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=deny' });
  expect(posted.status).toBe(410);
  expect((await jsonResponse(await browser(h, undefined, c.pairingId))).state).toBe('approved');
  expect((await jsonResponse(await commit(h, c, prepared))).state).toBe('committed');
});

it('selects only one exact proposal when two approved devices share a generation', async () => {
  const { h, native, device, cookie } = await fixture(), other = await createPeerIdentity();
  const a = await proven(h, device), b = await proven(h, other);
  const preparedA = await prepare(h, native, a), preparedB = await prepare(h, native, b);
  expect(preparedA.request.payload.expectedGeneration).toBe(preparedB.request.payload.expectedGeneration);
  const stagedA = await jsonResponse(await stage(h, a, preparedA)), stagedB = await jsonResponse(await stage(h, b, preparedB));
  expect((await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + a.pairingId)).state).toBe('approved');
  expect((await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + b.pairingId)).state).toBe('approved');
  const attempts = await Promise.all([commit(h, a, preparedA), commit(h, b, preparedB)]);
  expect(attempts.map(response => response.status).sort()).toEqual([200, 409]);
  const outcomes = await Promise.all(attempts.map(response => response.json()));
  const selected = attempts.findIndex(response => response.status === 200), rejected = 1 - selected;
  const proposals = [{ status: a, prepared: preparedA, digest: stagedA.preparedDigest },
    { status: b, prepared: preparedB, digest: stagedB.preparedDigest }];
  const winner = proposals[selected], loser = proposals[rejected];
  const winnerResult = outcomes[selected] as DevicePairingStatus;
  expect(winnerResult).toMatchObject({ state: 'committed', pairingId: winner.status.pairingId, preparedDigest: winner.digest });
  const authority = await verifyAuthorityBundle(await peerApiJson(h, 'control/read'));
  expect(authority.bundle.generations).toHaveLength(2);
  expect(authority.current!.payload.transition).toEqual(winner.prepared.request);
  const order = (grants: readonly { publicKey: string }[]) => [...grants].sort((left, right) => left.publicKey.localeCompare(right.publicKey));
  expect(await peerDigest(order(authority.control.payload.grants))).toBe(await peerDigest(order(winner.prepared.control.grants)));
  expect(authority.grant(loser.status.challenge.publicKey)).toBeNull();
  const stale = await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + loser.status.pairingId);
  expect(stale.state).toBe('stale'); expect(stale.prepared).toEqual(loser.prepared); expect(stale.preparedDigest).toBe(loser.digest);
  expect((await jsonResponse(await commit(h, winner.status, winner.prepared))).generation).toEqual(winnerResult.generation);
  await jsonResponse(await commit(h, loser.status, loser.prepared), 409);
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).bundle.generations).toHaveLength(2);
});

it('commits only the exact prepared member grant, recovers a lost response after restart and keeps revoked grants revoked', async () => {
  const { h, device, native } = await fixture(), { g, status: c } = await provenGuest(h, device);
  const prepared = await prepare(h, native, c);
  await jsonResponse(await commit(h, c, prepared), 409);
  const badSignature = { ...prepared, request: { ...prepared.request, signature: '00'.repeat(64) } };
  await jsonResponse(await stage(h, c, badSignature), 403);
  expect((await apiJson(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId)).prepared).toBeUndefined();
  const broad = structuredClone(prepared);
  (broad.control.grants[broad.control.grants.length - 1] as { administrator: boolean }).administrator = true;
  await jsonResponse(await stage(h, c, broad), 409);
  await jsonResponse(await stage(h, c, prepared));
  await jsonResponse(await commit(h, c, badSignature), 409);
  await jsonResponse(await commit(h, c, broad), 409);
  expect((await jsonResponse(await browser(g.handle, undefined, c.pairingId, g.headers))).state).toBe('approved');
  const accepted = await jsonResponse(await commit(h, c, prepared));
  expect(accepted.state).toBe('committed'); expect(accepted.generation).toBeDefined();
  // The authoritative receipt, not only the endpoint's final write, recovers an uncertain response.
  await inDO(h.id, t => { const row = t.db.one<{ data: string }>('SELECT data FROM device_pairings WHERE id=?', c.pairingId)!;
    const record = JSON.parse(row.data); record.state = 'committing'; delete record.generation;
    t.db.run('UPDATE device_pairings SET status=?,data=? WHERE id=?', 'committing', JSON.stringify(record), c.pairingId); });
  await inDO(h.id, t => t.ctx.abort('Lost pairing reply')).catch(() => {});
  expect((await apiJson(h, 'GET', 'peers/pairing')).pairings).toHaveLength(0);
  const recovered = await jsonResponse(await commit(h, c, prepared));
  expect(recovered.generation).toEqual(accepted.generation);
  expect(await inDO(h.id, t => t.db.one<{ status: string }>('SELECT status FROM device_pairings WHERE id=?', c.pairingId)!.status)).toBe('committed');
  const authority = await verifyAuthorityBundle(await peerApiJson(h, 'control/read')), current = authority.current!, ctl = authority.control.payload;
  const revoke = await signTransitionRequest({ ...prepared.request.payload, transitionId: 'explicit-revoke', expectedGeneration: current.id,
    controlRevision: ctl.revision + 1, base: { point: { generation: current.id, sequence: 0, root: await generationStartRoot(current) }, receipt: null, bridge: [] } }, native);
  await peerApiJson(h, 'control/select', { request: revoke, control: { epoch: ctl.epoch + 1, keyDigest: 'ef'.repeat(32), recoveryFloor: ctl.recoveryFloor,
    grants: ctl.grants.filter(grant => grant.publicKey !== device.publicKey) } });
  await advance(h.id, DEVICE_PAIRING_LIMITS.lifetimeMs + 1);
  const replay = await jsonResponse(await commit(h, c, prepared));
  expect(replay.state).toBe('revoked'); expect(replay.generation).toEqual(accepted.generation);
  const final = await verifyAuthorityBundle(await peerApiJson(h, 'control/read'));
  expect(final.grant(device.publicKey)).toBeNull(); expect(final.bundle.generations).toHaveLength(3);
});

it('expires requests and refuses stale authority instead of preparing a replacement transition', async () => {
  const { h, native, device, cookie } = await fixture(), c = await proven(h, device);
  await jsonResponse(await stage(h, c, await prepare(h, native, c)));
  await advance(h.id, DEVICE_PAIRING_LIMITS.lifetimeMs + 1);
  expect((await jsonResponse(await browser(h, undefined, c.pairingId))).state).toBe('expired');
  const fresh = await proven(h, device), prepared = await prepare(h, native, fresh);
  await jsonResponse(await stage(h, fresh, prepared));
  const current = (await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).current!;
  const next = await signTransitionRequest({ ...prepared.request.payload, transitionId: 'unrelated-handover', controlRevision: current.payload.controlRevision,
    reason: 'handover' }, native);
  await peerApiJson<SignedGeneration>(h, 'control/select', { request: next });
  await jsonResponse(await commit(h, fresh, prepared), 409);
  expect((await jsonResponse(await browser(h, undefined, fresh.pairingId))).state).toBe('stale');
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).grant(device.publicKey)).toBeNull();
});

it('serializes two simultaneously approved proposals without silently signing a replacement generation', async () => {
  const { h, native, device, cookie } = await fixture(), secondDevice = await createPeerIdentity();
  const first = await proven(h, device), second = await proven(h, secondDevice);
  expect(first.challenge.expectedGeneration).toBe(second.challenge.expectedGeneration);
  const prepared = await Promise.all([prepare(h, native, first), prepare(h, native, second)]);
  await Promise.all([stage(h, first, prepared[0]), stage(h, second, prepared[1])].map(async result => jsonResponse(await result)));
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const responses = await Promise.race([
    Promise.all([commit(h, first, prepared[0]), commit(h, second, prepared[1])]),
    new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(Error('Concurrent pairing admission did not settle')), 2000); }),
  ]).finally(() => clearTimeout(deadline));
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const states = await Promise.all([first, second].map(async value => jsonResponse(await browser(h, undefined, value.pairingId))));
  expect(states.map(value => value.state).sort()).toEqual(['committed', 'stale']);
  const winner = states.findIndex(value => value.state === 'committed'), loser = 1 - winner;
  await jsonResponse(responses[winner]); await jsonResponse(responses[loser], 409);
  await jsonResponse(await commit(h, [first, second][loser], prepared[loser]), 409);
  const authority = await verifyAuthorityBundle(await peerApiJson(h, 'control/read'));
  expect(authority.bundle.generations).toHaveLength(2);
  expect(authority.grant([device, secondDevice][winner].publicKey)?.reader).toBe(true);
  expect(authority.grant([device, secondDevice][loser].publicKey)).toBeNull();
});

it('keeps malformed/capacity boundaries durable without overwriting requests', async () => {
  const { h, device, native, cookie } = await fixture(), c = await proven(h, device), prepared = await prepare(h, native, c);
  expect((await jsonResponse(await stage(h, c, prepared))).state).toBe('approved');
  await jsonResponse(await browser(h, { action: 'challenge', requestId: 'x'.repeat(5000), publicKey: device.publicKey, rights: { reader: true, writer: true } }), 413);
  for (let i = 1; i < DEVICE_PAIRING_LIMITS.challengesPerMinute; i++) await challenge(h, device);
  await jsonResponse(await browser(h, { action: 'challenge', requestId: 'over-rate', publicKey: device.publicKey, rights: { reader: true, writer: true } }), 429);
  const retained = await inDO(h.id, t => t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM device_pairings')!.n);
  expect(retained).toBe(DEVICE_PAIRING_LIMITS.challengesPerMinute);
  expect((await jsonResponse(await browser(h, undefined, c.pairingId))).state).toBe('approved');
});

it('isolates guest requests by account and approves them automatically once staged', async () => {
  const { h, native, device, cookie } = await fixture(), a = await guest(h), b = await guest(h);
  const c = await jsonResponse(await browser(a.handle, { action: 'challenge', requestId: 'guest-request', publicKey: device.publicKey, rights: { reader: true, writer: true } }, undefined, a.headers));
  expect(c.challenge.accountId).toBe(a.accountId);
  await jsonResponse(await browser(b.handle, undefined, c.pairingId, b.headers), 403);
  await jsonResponse(await browser(h, undefined, c.pairingId), 403);
  await jsonResponse(await browser(b.handle, { action: 'prove', pairingId: c.pairingId, signature: await signDevicePairingChallenge(c.challenge, device) }, undefined, b.headers), 403);
  await jsonResponse(await browser(a.handle, { action: 'prove', pairingId: c.pairingId, signature: await signDevicePairingChallenge(c.challenge, device) }, undefined, a.headers));
  expect((await jsonResponse(await stage(h, c, await prepare(h, native, c)))).state).toBe('approved');
  expect((await jsonResponse(await browser(a.handle, undefined, c.pairingId, a.headers))).state).toBe('approved');
});

it('rechecks guest admission at the atomic control write and resumes the same prepared transition', async () => {
  const { h, native, device, cookie } = await fixture(), g = await guest(h);
  const c = await jsonResponse(await browser(g.handle, { action: 'challenge', requestId: 'revocation-race', publicKey: device.publicKey, rights: { reader: true, writer: true } }, undefined, g.headers));
  await jsonResponse(await browser(g.handle, { action: 'prove', pairingId: c.pairingId, signature: await signDevicePairingChallenge(c.challenge, device) }, undefined, g.headers));
  const prepared = await prepare(h, native, c);
  await jsonResponse(await stage(h, c, prepared));
  const race = await inDO(h.id, async t => {
    const original = t.env.ACCOUNTS;
    let revoked = false;
    t.env.ACCOUNTS = { prepare(sql: string) {
      const statement = original.prepare(sql);
      if (!sql.includes('FROM accounts WHERE id')) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { async first() {
          const value = await bound.first();
          if (!revoked && args[0] === g.accountId && t.db.one<{ status: string }>('SELECT status FROM device_pairings WHERE id=?', c.pairingId)?.status === 'committing') {
            revoked = true; t.db.run('DELETE FROM guest_accounts WHERE account_id=?', g.accountId);
          }
          return value;
        } };
      } };
    } } as D1Database;
    try {
      const principal = agentPrincipal(t, h), request = new Request('https://tendril.internal/agent', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'commit', pairingId: c.pairingId, ...prepared }) });
      try { await handleDevicePairing(t, request, new URL(request.url), principal); return { revoked, code: 'unexpected-success' }; }
      catch (error) { return { revoked, code: (error as { code: string }).code }; }
    } finally { t.env.ACCOUNTS = original; }
  });
  expect(race.revoked).toBe(true); expect(race.code).toBe('forbidden');
  const uncertain = await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId);
  expect(uncertain.state).toBe('revoked'); expect(uncertain.prepared).toEqual(prepared);
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).grant(device.publicKey)).toBeNull();
  await inDO(h.id, t => t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)', g.accountId, g.linkId, t.now()));
  const resumed = await jsonResponse(await commit(h, c, prepared)); expect(resumed.state).toBe('committed');
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).bundle.generations).toHaveLength(2);
});

it('refuses suspension after an active account read without consuming the approved pairing', async () => {
  const { h, native, device, cookie } = await fixture(), g = await guest(h);
  const c = await jsonResponse(await browser(g.handle, { action: 'challenge', requestId: 'suspension-race',
    publicKey: device.publicKey, rights: { reader: true, writer: true } }, undefined, g.headers));
  await jsonResponse(await browser(g.handle, { action: 'prove', pairingId: c.pairingId,
    signature: await signDevicePairingChallenge(c.challenge, device) }, undefined, g.headers));
  const prepared = await prepare(h, native, c), before = await peerApiJson<AuthorityBundle>(h, 'control/read');
  const staged = await jsonResponse(await stage(h, c, prepared));
  const race = await inDO(h.id, async t => {
    const original = t.env.ACCOUNTS;
    let suspended = false;
    t.env.ACCOUNTS = new Proxy(original, { get(target, key) {
      if (key !== 'prepare') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes('FROM accounts WHERE id')) return statement;
        return { bind(...args: unknown[]) {
          const bound = statement.bind(...args);
          return { async first() {
            const active = await bound.first();
            if (!suspended && active && args[0] === g.accountId &&
                t.db.one<{ status: string }>('SELECT status FROM device_pairings WHERE id=?', c.pairingId)?.status === 'committing') {
              // Return the old active snapshot after a real account suspension.
              // Only a fresh check before the signed control write can refuse it.
              await original.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(t.now(), g.accountId).run();
              suspended = true;
            }
            return active;
          } };
        } };
      };
    } });
    try {
      const principal = agentPrincipal(t, h), request = new Request('https://tendril.internal/agent', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'commit', pairingId: c.pairingId, ...prepared }) });
      try { await handleDevicePairing(t, request, new URL(request.url), principal); return { suspended, code: 'unexpected-success' }; }
      catch (error) { return { suspended, code: (error as { code: string }).code }; }
    } finally { t.env.ACCOUNTS = original; }
  });
  expect(race).toEqual({ suspended: true, code: 'pairing_account_revoked' });
  const retained = await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId);
  expect(retained.state).toBe('revoked'); expect(retained.prepared).toEqual(prepared); expect(retained.preparedDigest).toBe(staged.preparedDigest);
  expect(await peerApiJson(h, 'control/read')).toEqual(before);
  expect(await inDO(h.id, t => t.db.get<{ publicKey: string }[]>('peer_generation_accounts', []).some(row => row.publicKey === device.publicKey))).toBe(false);
  await inDO(h.id, t => t.ctx.abort('Retain the suspended pairing')).catch(() => {});
  const reopened = await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId);
  expect(reopened).toEqual(retained);
  expect(await jsonResponse(await commit(h, c, prepared), 403)).toMatchObject({ error: { code: 'forbidden' } });
  expect(await peerApiJson(h, 'control/read')).toEqual(before);
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=NULL WHERE id=?').bind(g.accountId).run();
  const resumed = await jsonResponse(await commit(h, c, prepared));
  expect(resumed.state).toBe('committed'); expect(resumed.preparedDigest).toBe(staged.preparedDigest);
  expect(resumed.generation!.payload.transition).toEqual(prepared.request);
  const authority = await verifyAuthorityBundle(await peerApiJson<AuthorityBundle>(h, 'control/read'));
  expect(authority.bundle.generations).toHaveLength(2);
  expect(authority.grant(device.publicKey)).toMatchObject({ reader: true, writer: true, administrator: false, publisher: false });
});

it('refuses a corrupt retained attempt without selecting a replacement or dropping the journal', async () => {
  const { h, native, device, cookie } = await fixture(), c = await proven(h, device), prepared = await prepare(h, native, c);
  await jsonResponse(await stage(h, c, prepared));
  await jsonResponse(await commit(h, c, prepared));
  await inDO(h.id, t => { const row = t.db.one<{ data: string }>('SELECT data FROM device_pairings WHERE id=?', c.pairingId)!;
    const record = JSON.parse(row.data); record.prepared.control.epoch++;
    t.db.run('UPDATE device_pairings SET data=? WHERE id=?', JSON.stringify(record), c.pairingId); });
  const result = await apiJson(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId, undefined, 503);
  expect(result.error.code).toBe('pairing_reconciliation_required');
  await jsonResponse(await commit(h, c, prepared), 503);
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).bundle.generations).toHaveLength(2);
  expect(await inDO(h.id, t => t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM device_pairings')!.n)).toBe(1);
});

it('exposes verified expiry after uncommitted guest revocation without permitting a late admission', async () => {
  const { h, native, device, cookie } = await fixture(), g = await guest(h);
  const c = await jsonResponse(await browser(g.handle, { action: 'challenge', requestId: 'revoked-then-expired',
    publicKey: device.publicKey, rights: { reader: true, writer: true } }, undefined, g.headers));
  await jsonResponse(await browser(g.handle, { action: 'prove', pairingId: c.pairingId,
    signature: await signDevicePairingChallenge(c.challenge, device) }, undefined, g.headers));
  const prepared = await prepare(h, native, c);
  await jsonResponse(await stage(h, c, prepared));
  await inDO(h.id, t => t.db.run('DELETE FROM guest_accounts WHERE account_id=?', g.accountId));
  const revoked = await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId);
  expect(revoked.state).toBe('revoked'); expect(revoked.generation).toBeUndefined();
  await advance(h.id, DEVICE_PAIRING_LIMITS.lifetimeMs + 1);
  const expired = await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId);
  expect(expired.state).toBe('expired'); expect(expired.generation).toBeUndefined();
  expect(expired.prepared).toEqual(prepared); expect(expired.preparedDigest).toBe(revoked.preparedDigest);
  // Even restoring account admission cannot allow a delayed old commit after
  // the authoritative expiry was observed and the helper releases its pause.
  await inDO(h.id, t => t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)',
    g.accountId, g.linkId, t.now()));
  await jsonResponse(await commit(h, c, prepared), 409);
  const authority = await verifyAuthorityBundle(await peerApiJson(h, 'control/read'));
  expect(authority.grant(device.publicKey)).toBeNull(); expect(authority.bundle.generations).toHaveLength(1);
  expect((await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId)).prepared).toEqual(prepared);
});

it('refuses corrupt prepared evidence before committing', async () => {
  const { h, native, device, cookie } = await fixture(), c = await proven(h, device), prepared = await prepare(h, native, c);
  await jsonResponse(await stage(h, c, prepared));
  await inDO(h.id, t => {
    const row = t.db.one<{ data: string }>('SELECT data FROM device_pairings WHERE id=?', c.pairingId)!;
    const record = JSON.parse(row.data); record.prepared.request.payload.base.point.root = '00'.repeat(32);
    t.db.run('UPDATE device_pairings SET data=? WHERE id=?', JSON.stringify(record), c.pairingId);
  });
  expect((await req(c.reviewUrl, { redirect: 'manual' })).status).toBe(503);
  await jsonResponse(await commit(h, c, prepared), 503);
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).bundle.generations).toHaveLength(1);
});

it('does not report a differently selected control as the exact reviewed enrollment', async () => {
  const { h, native, device, cookie } = await fixture(), c = await proven(h, device), prepared = await prepare(h, native, c);
  await jsonResponse(await stage(h, c, prepared));
  const changed = structuredClone(prepared);
  (changed.control.grants[changed.control.grants.length - 1] as { administrator: boolean }).administrator = true;
  // Existing native administrative authority can select separately; pairing must not mislabel that receipt.
  await peerApiJson(h, 'control/select', changed);
  const result = await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId);
  expect(result.state).toBe('reconciliation_required'); expect(result.prepared).toEqual(prepared);
  expect((await jsonResponse(await commit(h, c, prepared))).state).toBe('reconciliation_required');
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).bundle.generations).toHaveLength(2);
});

it('fails closed for missing storage and finite retained and device-binding capacities', async () => {
  const { h, device } = await fixture(), c = await challenge(h, device, 'retained-at-capacity');
  await inDO(h.id, t => t.transaction(() => {
    const row = t.db.one<{ data: string; account_id: string }>('SELECT data,account_id FROM device_pairings WHERE id=?', c.pairingId)!;
    for (let i = 1; i < DEVICE_PAIRING_LIMITS.retainedPerApplication; i++)
      t.db.run('INSERT INTO device_pairings(id,account_id,created_at,expires_at,status,data) VALUES(?,?,?,?,?,?)', i.toString(16).padStart(64, '0'), row.account_id, t.now(), 0, 'denied', row.data);
  }));
  const full = await jsonResponse<any>(await browser(h, { action: 'challenge', requestId: 'another', publicKey: device.publicKey, rights: { reader: true, writer: true } }), 429);
  expect(full.error.code).toBe('pairing_ledger_full'); expect(await challenge(h, device, 'retained-at-capacity')).toEqual(c);
  await inDO(h.id, t => t.db.run('DROP TABLE device_pairings'));
  const missing = await jsonResponse<any>(await browser(h, undefined, c.pairingId), 503);
  expect(missing.error.code).toBe('pairing_storage_unavailable');
  expect((await apiJson(h, 'GET', 'peers/pairing', undefined, 503)).error.code).toBe('pairing_storage_unavailable');
  const other = await fixture();
  await inDO(other.h.id, t => { const bindings = t.db.get<{ publicKey: string; accountId: string }[]>('peer_generation_accounts', []);
    while (bindings.length < 1024) bindings.push({ publicKey: bindings.length.toString(16).padStart(64, '0'), accountId: other.owner });
    t.db.set('peer_generation_accounts', bindings); });
  const binding = await jsonResponse<any>(await browser(other.h, { action: 'challenge', requestId: 'binding-full', publicKey: other.device.publicKey, rights: { reader: true, writer: true } }), 429);
  expect(binding.error.code).toBe('peer_account_binding_full');
  expect(await inDO(other.h.id, t => t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM device_pairings')!.n)).toBe(0);
});

it('reports the exact staged proposal as committed when its native administrator selects it directly', async () => {
  const { h, native, device } = await fixture(), { g, status: c } = await provenGuest(h, device), prepared = await prepare(h, native, c);
  await jsonResponse(await stage(h, c, prepared));
  await peerApiJson(h, 'control/select', prepared);
  const result = await jsonResponse(await browser(g.handle, undefined, c.pairingId, g.headers));
  expect(result.state).toBe('committed');
  for (let retry = 0; retry < 2; retry++) {
    expect((await jsonResponse(await commit(h, c, prepared))).state).toBe('committed');
    expect((await jsonResponse(await browser(g.handle, undefined, c.pairingId, g.headers))).state).toBe('committed');
  }
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).grant(device.publicKey)?.writer).toBe(true);
});

it('notifies a resident native owner when a later browser proves its key and is staged', async () => {
  const { h, native, device } = await fixture();
  const response = await api(h, 'GET', 'setup/watch', undefined,
    { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'tendriller.setup.v1' });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const next = () => new Promise<any>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(event.data as string)), { once: true }));
  const initial = next(); socket.accept(); await initial;
  const proved = next(), status = await proven(h, device);
  expect((await proved).type).toBe('setup');
  const prepared = await prepare(h, native, status);
  const approved = next();
  await jsonResponse(await stage(h, status, prepared));
  expect((await approved).type).toBe('setup');
  expect((await apiJson<DevicePairingStatus>(h, 'GET', 'peers/pairing?pairingId=' + status.pairingId)).state).toBe('approved');
  socket.close();
});
