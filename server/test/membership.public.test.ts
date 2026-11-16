import { expect, it } from 'vitest';
import { decodeSignedGenesis, encodeSignedEnrollmentRequest, loadOrCreateEnrollmentIdentity,
  membershipDescriptor, prepareEnrollmentRequest, type DurableOperationStore } from '@chronolog/membership';
import type { MembershipConfiguration, MembershipInfo, MemberRequest } from '../../contract/members.mjs';
import { createTestPage } from './public-fixture';
import { apiJson, create, inDO } from './helpers';
import { authenticateAgentToken } from '../src/access';
import { handleMembership } from '../src/membership';

const bytes = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
const config = (): MembershipConfiguration => ({
  executionManifestDigest: bytes(new Uint8Array(32).fill(1)),
  schemaAdministratorPublicKey: bytes(new Uint8Array(32).fill(2)),
  nativeAuthority: { url: 'https://authority.example.test/_chronolog/membership', historyId: 'h_' + 'a'.repeat(32), publicKey: bytes(new Uint8Array(32).fill(3)) },
});
async function body<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
function privateStore(): DurableOperationStore {
  const entries = new Map<string, Uint8Array>();
  return { get: async key => entries.get(key)?.slice() ?? null, put: async (key, value) => { entries.set(key, value.slice()); } };
}
async function request(info: MembershipInfo) {
  const store = privateStore(), identity = await loadOrCreateEnrollmentIdentity(store, 'device');
  const descriptor = await membershipDescriptor(decodeSignedGenesis(decode(info.descriptor!.genesis)), decode(info.descriptor!.groupRoute));
  const transportAuthor = '@' + btoa(String.fromCharCode(...identity.signing.publicKeyBytes)) + '.ed25519';
  const signed = await prepareEnrollmentRequest({ descriptor, store, requestId: info.identity.requestPrefix + crypto.randomUUID(),
    identity: identity.signing, readerPublicKey: identity.reader.publicKeyBytes, transportAuthor,
    requestedRoles: ['reader'] });
  return bytes(encodeSignedEnrollmentRequest(signed));
}

it('provisions a durable membership root with explicitly separate schema and native authority keys', async () => {
  const page = await createTestPage({ application: { kind: 'peer', id: 'membership' }, lifetime: 'resident' });
  const input = config(), participant = await page.participant();
  expect((await participant.api('PUT', 'members', input)).status).toBe(403);
  const first = await body<MembershipInfo>(await page.ownerApi('PUT', 'members', input));
  expect(first.identity.administrator).toBe(true);
  expect(first.requests).toEqual([]); expect(first.progress).toBeNull();
  const genesis = decodeSignedGenesis(decode(first.descriptor!.genesis));
  expect(bytes(genesis.manifest.rootAdminPublicKey)).not.toBe(input.schemaAdministratorPublicKey);
  expect(bytes(genesis.manifest.schemaAdminPublicKey)).toBe(input.schemaAdministratorPublicKey);
  expect(genesis.manifest.initialCapabilities.map(capability => capability.role)).toEqual(['administrator']);
  expect(genesis.manifest.historyPolicy).toMatchObject({ kind: 'coordinated', historyId: input.nativeAuthority.historyId,
    authorityPublicKey: decode(input.nativeAuthority.publicKey) });
  expect(await body(await page.api('PUT', 'members', input))).toEqual(first);
  expect((await page.api('PUT', 'members', { ...input, schemaAdministratorPublicKey: bytes(new Uint8Array(32).fill(4)) })).status).toBe(409);
  expect((await page.api('PATCH', '', { lifetime: 'ad_hoc' })).status).toBe(409);
  await page.restart();
  expect(await body(await page.api('GET', 'members'))).toEqual(first);
});

it('binds signed device enrollment to its authenticated account and preserves the request across a real restart', async () => {
  const page = await createTestPage({ application: { kind: 'peer', id: 'membership' }, lifetime: 'resident' });
  await body(await page.api('PUT', 'members', config()));
  const one = await page.participant(), two = await page.participant();
  const info = await body<MembershipInfo>(await one.api('GET', 'members'));
  expect(info.identity).toEqual({ accountId: one.account, requestPrefix: `account:${one.account}:`, administrator: false });
  const signedRequest = await request(info);
  expect((await one.api('POST', 'members/requests', { signedRequest: 'AA' })).status).toBe(400);
  expect((await two.api('POST', 'members/requests', { signedRequest })).status).toBe(403);
  const accepted = await body<MemberRequest>(await one.api('POST', 'members/requests', { signedRequest }));
  expect(accepted).toMatchObject({ accountId: one.account, status: 'requested', capabilityIds: [], revokedCapabilityIds: [] });
  expect(accepted.signedApproval).toBeUndefined();
  expect((await one.api('POST', 'members/approve', { operationId: 'self-approve', requestId: accepted.id, roles: ['reader'], grantFullHistory: true })).status).toBe(403);
  expect((await one.api('POST', 'members/revoke', { operationId: 'self-revoke', capabilityIds: [bytes(new Uint8Array(32))] })).status).toBe(403);
  expect((await one.api('GET', 'members/history?after=0')).status).toBe(403);
  expect((await two.api('GET', `members/requests/${accepted.id}`)).status).toBe(403);
  expect((await body<MembershipInfo>(await two.api('GET', 'members'))).requests).toEqual([]);
  expect((await body<MembershipInfo>(await page.api('GET', 'members'))).requests).toEqual([accepted]);
  await page.restart();
  expect(await body(await one.api('POST', 'members/requests', { signedRequest }))).toEqual(accepted);
  expect(await body(await one.api('GET', `members/requests/${accepted.id}`))).toEqual(accepted);
});

it('requires an owned resident peer page and a complete explicit public configuration', async () => {
  const ordinary = await createTestPage();
  expect((await ordinary.api('PUT', 'members', config())).status).toBe(409);
  const page = await createTestPage({ application: { kind: 'peer', id: 'membership' } });
  expect((await page.api('PUT', 'members', config())).status).toBe(409);
  await body(await page.api('PATCH', '', { lifetime: 'resident' }));
  const { schemaAdministratorPublicKey: _key, ...missing } = config();
  expect((await page.api('PUT', 'members', missing)).status).toBe(400);
  expect((await page.api('PUT', 'members', { ...config(), nativeAuthority: { ...config().nativeAuthority, url: 'http://example.test/' } })).status).toBe(400);
  expect((await body<MembershipInfo>(await page.api('GET', 'members'))).descriptor).toBeNull();
});

it('rechecks roster authorization after asynchronous descriptor preparation', async () => {
  const page = await create({ listener: false, application: { kind: 'peer', id: 'membership' } });
  await apiJson(page, 'PATCH', '', { lifetime: 'resident' });
  await apiJson(page, 'PUT', 'members', config());
  await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token), read = t.db.one.bind(t.db);
    let revoked = false;
    t.db.one = <T>(query: string, ...args: unknown[]): T | null => {
      const value = read<T>(query, ...args);
      if (!revoked && query === 'SELECT value FROM membership_records WHERE key=?' && args[0] === 'membership/identity') {
        revoked = true;
        t.db.run('DELETE FROM tokens WHERE hash=?', principal.credentialHash);
      }
      return value;
    };
    try {
      const url = new URL('https://page.example/_tendril/members');
      await expect(handleMembership(t, new Request(url), url, 'members', principal)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(revoked).toBe(true);
    } finally { t.db.one = read; }
  });
});
