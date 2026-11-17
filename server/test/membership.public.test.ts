import { expect, it } from 'vitest';
import { decodeSignedGenesis, encodeSignedEnrollmentRequest, loadOrCreateEnrollmentIdentity,
  membershipDescriptor, prepareEnrollmentRequest, provisionMembership, createMembershipLedgerClient,
  type DurableOperationStore } from '@chronolog/membership';
import type { MembershipConfiguration, MembershipInfo, MemberProgram, MemberRequest } from '../../contract/members.mjs';
import { createTestPage } from './public-fixture';
import { api, apiJson, create, inDO } from './helpers';
import { authenticateAgentToken } from '../src/access';
import { handleMembership } from '../src/membership';
import { changeLifetime } from '../src/lifetime';

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
async function request(info: MembershipInfo, writerProgram?: MemberProgram) {
  const store = privateStore(), identity = await loadOrCreateEnrollmentIdentity(store, 'device');
  const descriptor = await membershipDescriptor(decodeSignedGenesis(decode(info.descriptor!.genesis)), decode(info.descriptor!.groupRoute));
  const transportAuthor = '@' + btoa(String.fromCharCode(...identity.signing.publicKeyBytes)) + '.ed25519';
  const signed = await prepareEnrollmentRequest({ descriptor, store, requestId: info.identity.requestPrefix + crypto.randomUUID(),
    identity: identity.signing, readerPublicKey: identity.reader.publicKeyBytes, transportAuthor,
    requestedRoles: writerProgram === undefined ? ['reader'] : ['reader', 'writer'],
    ...(writerProgram === undefined ? {} : { writerProgram }) });
  return bytes(encodeSignedEnrollmentRequest(signed));
}

it('constructs signed membership requests in the actual workerd runtime without following redirects', async () => {
  const native = await loadOrCreateEnrollmentIdentity(privateStore(), 'native');
  const provisioned = await provisionMembership({ store: privateStore(), executionManifestDigest: new Uint8Array(32).fill(1),
    schemaAdministratorPublicKey: native.signing.publicKeyBytes,
    nativeAuthority: { historyId: 'h_' + 'b'.repeat(32), publicKey: native.signing.publicKeyBytes } });
  let requests = 0;
  const client = createMembershipLedgerClient({ ...provisioned, url: 'https://resident.example/_chronolog/membership',
    fetch: async (input, init) => {
      // workerd rejects redirect:error before networking. Construct the real
      // platform request so a packaged client regression cannot hide in a stub.
      const outbound = new Request(input, init);
      expect(outbound.redirect).toBe('manual');
      expect(outbound.method).toBe('POST');
      expect((await outbound.arrayBuffer()).byteLength).toBeGreaterThan(0);
      requests++;
      return new Response(null, { status: 307, headers: { Location: 'https://different.example/receive' } });
    } });
  await expect(client.read({ after: 0, limit: 128 })).rejects.toThrow('MEMBERSHIP_LEDGER_REDIRECT');
  expect(requests).toBe(1);
});

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
  expect(genesis.manifest.initialCapabilities).toEqual([]);
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

it.each([
  { name: 'writer without explicit rights', roles: ['reader', 'writer'], program: false },
  { name: 'program rights without writer', roles: ['reader'], program: true },
  { name: 'writer without reader access', roles: ['writer'], program: true },
  { name: 'duplicate reader roles', roles: ['reader', 'reader'], program: false },
])('rejects $name before retaining an administrative action', async ({ roles, program }) => {
  const page = await create({ listener: false, application: { kind: 'peer', id: 'membership' } });
  await apiJson(page, 'PATCH', '', { lifetime: 'resident' });
  const info = await apiJson<MembershipInfo>(page, 'PUT', 'members', config());
  const writerProgram: MemberProgram = { sql: false, topics: ['conversation'], signals: ['typing'] };
  const signedRequest = await request(info, writerProgram);
  const enrollment = await apiJson<MemberRequest>(page, 'POST', 'members/requests', { signedRequest });
  const rejected = await api(page, 'POST', 'members/approve', {
    operationId: 'explicit-rights', requestId: enrollment.id, roles, grantFullHistory: true,
    ...(program ? { writerProgram } : {}),
  });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ error: { code: 'bad_request' } });
  const after = await apiJson<MembershipInfo>(page, 'GET', 'members');
  expect(after.pendingActions).toBe(0);
  expect(after.requests).toEqual([enrollment]);
  await inDO(page.id, t => { expect(t.db.all('SELECT * FROM membership_actions')).toEqual([]); });
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

it('keeps a stalled enrollment body outside the administration queue and rechecks access when it arrives', async () => {
  const page = await create({ listener: false, application: { kind: 'peer', id: 'membership' } });
  await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token);
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
    const requestUrl = new URL('https://page.example/_tendril/members/requests');
    const pending = handleMembership(t, new Request(requestUrl, { method: 'POST', body: stream }), requestUrl, 'members/requests', principal);
    const rejected = expect(pending).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    try {
      const infoUrl = new URL('https://page.example/_tendril/members');
      const response = await handleMembership(t, new Request(infoUrl), infoUrl, 'members', principal);
      expect((await response.json<MembershipInfo>()).requests).toEqual([]);
      t.db.run('DELETE FROM tokens WHERE hash=?', principal.credentialHash);
      body.enqueue(new TextEncoder().encode('{}')); body.close();
      await rejected;
    } finally {
      // A failing test must not retain the pending body until its real deadline.
      try { body.error(new Error('test finished')); } catch { /* Already closed. */ }
    }
  });
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


it('rechecks a downgrade begun during administrator key preparation before persisting those keys', async () => {
  const page = await create({ listener: false, application: { kind: 'peer', id: 'membership' } });
  await apiJson(page, 'PATCH', '', { lifetime: 'resident' });
  await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token), read = t.db.one.bind(t.db);
    let changed = false, downgrade: Promise<void> | undefined;
    t.db.one = <T>(query: string, ...args: unknown[]): T | null => {
      const value = read<T>(query, ...args);
      if (!changed && query === 'SELECT value FROM membership_records WHERE key=?' && args[0] === 'membership/identity') {
        changed = true;
        downgrade = changeLifetime(t, 'ad_hoc');
      }
      return value;
    };
    try {
      const url = new URL('https://page.example/_tendril/members');
      const req = new Request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config()) });
      await expect(handleMembership(t, req, url, 'members', principal)).rejects.toMatchObject({ status: 409, code: 'resident_required' });
      expect(changed).toBe(true); await downgrade;
      expect(t.db.get('membership_configuration', null)).toBeNull();
      expect(t.db.all('SELECT * FROM membership_records')).toEqual([]);
    } finally { t.db.one = read; }
  });
});
