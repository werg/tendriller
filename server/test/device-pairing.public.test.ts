import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createPeerIdentity, signTransitionRequest, generationStartRoot, participantGrant, verifyAuthorityBundle,
  type PeerIdentity, type AuthorityBundle, type SignedGeneration } from '@chronolog/peer-generation/control';
import { DEVICE_PAIRING_LIMITS, signDevicePairingChallenge, type DevicePairingStatus, type DevicePairingPrepared } from '../../contract/pairing.mjs';
import { api, apiJson, create, req, inDO, advance, type Handle } from './helpers';
import { peerApiJson } from './peer-exchange';
import { sha256Hex } from '../src/ids';
import { authenticateAgentToken } from '../src/access';
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
async function form(status: DevicePairingStatus, cookie: string) {
  const response = await req(status.reviewUrl, { headers: { Cookie: cookie } }), html = await response.text();
  expect(response.status, html).toBe(200);
  expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  return { csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '', digest: /name="digest" value="([^"]+)"/.exec(html)?.[1] ?? '', html };
}
async function review(status: DevicePairingStatus, cookie: string, action = 'approve', supplied?: { csrf: string; digest: string }) {
  const fields = supplied ?? await form(status, cookie);
  return req(status.reviewUrl, { method: 'POST', headers: { Cookie: cookie, Origin: new URL(status.reviewUrl).origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: fields.csrf, digest: fields.digest, action }).toString() });
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

it('shows the exact service-origin review and requires one-use session-bound CSRF', async () => {
  const { h, device, cookie, owner } = await fixture(), c = await proven(h, device), fields = await form(c, cookie);
  expect(fields.html).toContain(owner); expect(fields.html).toContain(c.challenge.applicationId); expect(fields.html).toContain('no coordination, recovery, administration or publishing');
  expect((await req(c.reviewUrl, { redirect: 'manual' })).status).toBe(303);
  expect((await review(c, cookie, 'approve', { ...fields, digest: '00'.repeat(32) })).status).toBe(403);
  expect((await req(c.reviewUrl, { method: 'POST', headers: { Cookie: cookie, Origin: c.challenge.pageOrigin }, body: new URLSearchParams({ csrf: fields.csrf, digest: fields.digest, action: 'approve' }).toString() })).status).toBe(403);
  expect((await review(c, cookie, 'approve', fields)).status).toBe(200);
  expect((await review(c, cookie, 'approve', fields)).status).toBe(403);
  expect((await jsonResponse(await browser(h, undefined, c.pairingId))).state).toBe('approved');
  expect((await apiJson(h, 'GET', 'peers/pairing')).pairings).toHaveLength(1);
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).grant(device.publicKey)).toBeNull();
});

it('commits only the exact reviewed grant, recovers a lost response after restart and keeps revoked grants revoked', async () => {
  const { h, device, native, cookie } = await fixture(), c = await proven(h, device);
  const prepared = await prepare(h, native, c);
  await jsonResponse(await commit(h, c, prepared), 409);
  expect((await review(c, cookie)).status).toBe(200);
  const badSignature = { ...prepared, request: { ...prepared.request, signature: '00'.repeat(64) } };
  await jsonResponse(await commit(h, c, badSignature), 403);
  expect((await apiJson(h, 'GET', 'peers/pairing?pairingId=' + c.pairingId)).prepared).toBeUndefined();
  const broad = structuredClone(prepared);
  (broad.control.grants[broad.control.grants.length - 1] as { administrator: boolean }).administrator = true;
  await jsonResponse(await commit(h, c, broad), 409);
  expect((await jsonResponse(await browser(h, undefined, c.pairingId))).state).toBe('approved');
  const accepted = await jsonResponse(await commit(h, c, prepared));
  expect(accepted.state).toBe('committed'); expect(accepted.generation).toBeDefined();
  // The authoritative receipt, not only the endpoint's final write, recovers an uncertain response.
  await inDO(h.id, t => { const row = t.db.one<{ data: string }>('SELECT data FROM device_pairings WHERE id=?', c.pairingId)!;
    const record = JSON.parse(row.data); record.state = 'committing'; delete record.generation;
    t.db.run('UPDATE device_pairings SET status=?,data=? WHERE id=?', 'committing', JSON.stringify(record), c.pairingId); });
  await inDO(h.id, t => t.ctx.abort('Lost pairing reply')).catch(() => {});
  const recovered = await jsonResponse(await commit(h, c, prepared));
  expect(recovered.generation).toEqual(accepted.generation);
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

it('expires reviews and refuses stale authority instead of preparing a replacement transition', async () => {
  const { h, native, device, cookie } = await fixture(), c = await proven(h, device), fields = await form(c, cookie);
  await advance(h.id, DEVICE_PAIRING_LIMITS.lifetimeMs + 1);
  expect((await review(c, cookie, 'approve', fields)).status).toBe(403);
  expect((await jsonResponse(await browser(h, undefined, c.pairingId))).state).toBe('expired');
  const fresh = await proven(h, device), prepared = await prepare(h, native, fresh);
  expect((await review(fresh, cookie)).status).toBe(200);
  const current = (await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).current!;
  const next = await signTransitionRequest({ ...prepared.request.payload, transitionId: 'unrelated-handover', controlRevision: current.payload.controlRevision,
    reason: 'handover' }, native);
  await peerApiJson<SignedGeneration>(h, 'control/select', { request: next });
  await jsonResponse(await commit(h, fresh, prepared), 409);
  expect((await jsonResponse(await browser(h, undefined, fresh.pairingId))).state).toBe('stale');
  expect((await verifyAuthorityBundle(await peerApiJson(h, 'control/read'))).grant(device.publicKey)).toBeNull();
});

it('keeps rejection and malformed/capacity boundaries durable without overwriting requests', async () => {
  const { h, device, native, cookie } = await fixture(), c = await proven(h, device), prepared = await prepare(h, native, c);
  expect((await review(c, cookie, 'deny')).status).toBe(200);
  await jsonResponse(await commit(h, c, prepared), 409);
  expect((await jsonResponse(await browser(h, undefined, c.pairingId))).state).toBe('denied');
  await jsonResponse(await browser(h, { action: 'challenge', requestId: 'x'.repeat(5000), publicKey: device.publicKey, rights: { reader: true, writer: true } }), 413);
  for (let i = 1; i < DEVICE_PAIRING_LIMITS.challengesPerMinute; i++) await challenge(h, device);
  await jsonResponse(await browser(h, { action: 'challenge', requestId: 'over-rate', publicKey: device.publicKey, rights: { reader: true, writer: true } }), 429);
  const retained = await inDO(h.id, t => t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM device_pairings')!.n);
  expect(retained).toBe(DEVICE_PAIRING_LIMITS.challengesPerMinute);
  expect((await jsonResponse(await browser(h, undefined, c.pairingId))).state).toBe('denied');
});

it('isolates guest requests by account and requires owner review even with a valid page session', async () => {
  const { h, device, cookie } = await fixture(), a = await guest(h), b = await guest(h);
  const c = await jsonResponse(await browser(a.handle, { action: 'challenge', requestId: 'guest-request', publicKey: device.publicKey, rights: { reader: true, writer: true } }, undefined, a.headers));
  expect(c.challenge.accountId).toBe(a.accountId);
  await jsonResponse(await browser(b.handle, undefined, c.pairingId, b.headers), 403);
  await jsonResponse(await browser(h, undefined, c.pairingId), 403);
  await jsonResponse(await browser(b.handle, { action: 'prove', pairingId: c.pairingId, signature: await signDevicePairingChallenge(c.challenge, device) }, undefined, b.headers), 403);
  await jsonResponse(await browser(a.handle, { action: 'prove', pairingId: c.pairingId, signature: await signDevicePairingChallenge(c.challenge, device) }, undefined, a.headers));
  const raw = 'guest-review-' + crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)').bind(await sha256Hex(raw), a.accountId, Date.now(), Date.now() + 86400000).run();
  expect((await req(c.reviewUrl, { headers: { Cookie: `__Host-tendriller=${raw}` } })).status).toBe(403);
  expect((await review(c, cookie)).status).toBe(200);
  expect((await jsonResponse(await browser(a.handle, undefined, c.pairingId, a.headers))).state).toBe('approved');
});

it('rechecks guest admission at the atomic control write and resumes the same prepared transition', async () => {
  const { h, native, device, cookie } = await fixture(), g = await guest(h);
  const c = await jsonResponse(await browser(g.handle, { action: 'challenge', requestId: 'revocation-race', publicKey: device.publicKey, rights: { reader: true, writer: true } }, undefined, g.headers));
  await jsonResponse(await browser(g.handle, { action: 'prove', pairingId: c.pairingId, signature: await signDevicePairingChallenge(c.challenge, device) }, undefined, g.headers));
  expect((await review(c, cookie)).status).toBe(200);
  const prepared = await prepare(h, native, c);
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
      const principal = await authenticateAgentToken(t, h.token), request = new Request('https://tendril.internal/agent', { method: 'POST',
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

it('refuses a corrupt retained attempt without selecting a replacement or dropping the journal', async () => {
  const { h, native, device, cookie } = await fixture(), c = await proven(h, device), prepared = await prepare(h, native, c);
  expect((await review(c, cookie)).status).toBe(200);
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
  const other = await fixture();
  await inDO(other.h.id, t => { const bindings = t.db.get<{ publicKey: string; accountId: string }[]>('peer_generation_accounts', []);
    while (bindings.length < 1024) bindings.push({ publicKey: bindings.length.toString(16).padStart(64, '0'), accountId: other.owner });
    t.db.set('peer_generation_accounts', bindings); });
  const binding = await jsonResponse<any>(await browser(other.h, { action: 'challenge', requestId: 'binding-full', publicKey: other.device.publicKey, rights: { reader: true, writer: true } }), 429);
  expect(binding.error.code).toBe('peer_account_binding_full');
  expect(await inDO(other.h.id, t => t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM device_pairings')!.n)).toBe(0);
});
