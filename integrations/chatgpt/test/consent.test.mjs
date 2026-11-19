import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsentManagementHandler, createConsentService } from '../consent.mjs';

const now = 1_800_000_000_000;
const owner = { id: 'alice', issuer: 'https://identity.example.test', scopes: ['applications:read'] };
const other = { id: 'bob', issuer: owner.issuer, scopes: ['applications:read'] };
const applicationId = 'kitchen-one';
const selection = { applicationId, queries: ['assistanceStatus'], commands: ['replyToAssistance'], events: ['assistant.help_requested'], readEvents: true };

function memoryStore(initial = {}) {
  let state = structuredClone(initial);
  let queue = Promise.resolve();
  return {
    read: async () => structuredClone(state),
    transaction(mutator) {
      const next = queue.then(() => {
        const updated = structuredClone(state);
        const result = mutator(updated);
        assert.equal(typeof result?.then, 'undefined', 'Transaction mutators must remain synchronous');
        state = updated;
        return structuredClone(result);
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}

function fixture(overrides = {}) {
  const store = memoryStore({ otherSubsystem: { untouched: true } });
  const service = createConsentService({ store, clock: () => now, authorizeOwner: async (principal, id) => principal.id === owner.id && id === applicationId, ...overrides });
  return { service, store };
}

test('no default consent exists and token scopes cannot establish application ownership', async () => {
  const { service } = fixture();
  await assert.rejects(service.assertAccess(owner, { applicationId, kind: 'read' }), { code: 'connection_consent_required' });
  await assert.rejects(service.grant({ ...other, scopes: ['pages:publish', 'applications:write'], publisher: true }, selection), { code: 'owner_authorization_required' });
  const absent = fixture({ authorizeOwner: undefined });
  await assert.rejects(absent.service.grant(owner, selection), { code: 'owner_authorization_required' });
  assert.deepEqual(await absent.service.list(owner), []);
});

test('persists narrowly selected consent in its own namespace and resumes it', async () => {
  const { service, store } = fixture();
  const granted = await service.grant(owner, selection);
  assert.equal(granted.status, 'active');
  assert.equal(granted.expiresAt, now + 30 * 86_400_000);
  assert.equal(granted.owner, undefined);
  assert.deepEqual((await store.read()).otherSubsystem, { untouched: true });
  const reopened = createConsentService({ store, clock: () => now });
  assert.equal((await reopened.assertAccess(owner, { applicationId, kind: 'query', name: 'assistanceStatus' })).id, granted.id);
  assert.equal((await reopened.assertAccess(owner, { applicationId, kind: 'event-details', name: 'assistant.help_requested' })).id, granted.id);
  assert.equal((await reopened.list(owner))[0].id, granted.id);
});

test('isolates accounts, issuers, application IDs and named operations', async () => {
  const { service } = fixture();
  const granted = await service.grant(owner, selection);
  for (const principal of [other, { ...owner, issuer: 'https://another-identity.example.test' }]) {
    assert.deepEqual(await service.list(principal), []);
    await assert.rejects(service.assertAccess(principal, { applicationId, kind: 'read' }), { code: 'connection_consent_required' });
    await assert.rejects(service.revoke(principal, { id: granted.id }), { code: 'connection_not_found' });
  }
  await assert.rejects(service.assertAccess(owner, { applicationId: 'other-kitchen', kind: 'read' }), { code: 'connection_consent_required' });
  for (const [kind, name] of [['query', 'allPrivateHistory'], ['command', 'grantPublisher'], ['event', 'assistant.replied'], ['event-details', 'private.photo']]) {
    await assert.rejects(service.assertAccess(owner, { applicationId, kind, name }), { code: 'connection_permission_denied' });
  }
  await assert.rejects(service.assertAccess(owner, { applicationId, kind: 'event-details' }), { code: 'invalid_consent' });
});

test('replaces selections without stacking privilege or changing connection identity', async () => {
  const { service } = fixture();
  const first = await service.grant(owner, selection);
  const second = await service.grant(owner, { applicationId, queries: ['assistanceStatus'] });
  assert.equal(second.id, first.id);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.version, first.version + 1);
  assert.deepEqual(second.commands, []);
  assert.equal((await service.list(owner)).length, 1);
  await assert.rejects(service.assertAccess(owner, { applicationId, kind: 'command', name: 'replyToAssistance' }), { code: 'connection_permission_denied' });
});

test('revocation is idempotent, immediately enforced and still allowed after ownership changes', async () => {
  let owns = true;
  const { service } = fixture({ authorizeOwner: () => owns });
  const grant = await service.grant(owner, selection);
  owns = false;
  const revoked = await service.revoke(owner, { id: grant.id });
  assert.equal(revoked.status, 'revoked');
  assert.deepEqual(await service.revoke(owner, { id: grant.id }), revoked);
  await assert.rejects(service.assertAccess(owner, { applicationId, kind: 'event', name: 'assistant.help_requested' }), { code: 'connection_consent_required' });
  await assert.rejects(service.grant(owner, selection), { code: 'owner_authorization_required' });
});

test('expiry is checked on every read, with no automatic consent renewal', async () => {
  let current = now;
  const { service } = fixture({ clock: () => current });
  await service.grant(owner, { ...selection, expiresAt: now + 1000 });
  current += 1000;
  await assert.rejects(service.assertAccess(owner, { applicationId, kind: 'read' }), { code: 'connection_consent_required' });
  assert.equal((await service.list(owner))[0].status, 'expired');
  await service.grant(owner, { ...selection, expiresAt: null });
  current += 400 * 86_400_000;
  assert.equal((await service.assertAccess(owner, { applicationId, kind: 'read' })).status, 'active');
});

test('refuses wildcards, hidden privilege fields, unbounded grants and detail permission without events', async () => {
  const { service } = fixture();
  for (const input of [
    { applicationId }, { ...selection, principalId: other.id }, { ...selection, publisher: true },
    { ...selection, commands: ['*'] }, { ...selection, queries: Array.from({ length: 101 }, () => 'x') },
    { ...selection, readEvents: 'yes' }, { applicationId, readEvents: true, queries: ['assistanceStatus'] },
    { ...selection, expiresAt: now }, { ...selection, expiresAt: now + 366 * 86_400_000 }, { ...selection, id: 'another-connection' },
  ]) await assert.rejects(service.grant(owner, input), { code: 'invalid_consent' });
  assert.deepEqual(await service.list(owner), []);
  await assert.rejects(service.list({ id: '' }), { status: 401 });
});

test('notification permission alone does not allow detailed event content', async () => {
  const { service } = fixture();
  await service.grant(owner, { applicationId, events: ['assistant.help_requested'] });
  await service.assertAccess(owner, { applicationId, kind: 'event', name: 'assistant.help_requested' });
  await assert.rejects(service.assertAccess(owner, { applicationId, kind: 'event-details', name: 'assistant.help_requested' }), { code: 'connection_permission_denied' });
});

const origin = 'https://mcp.example.test';
const catalog = [{ applicationId, label: '<script>alert("x")</script>', queries: selection.queries, commands: selection.commands, events: selection.events, allowEventDetails: true }];
function management(overrides = {}) {
  const f = fixture();
  let principal = owner;
  let current = now;
  const handler = createConsentManagementHandler({
    service: f.service, authenticate: async () => principal, origin, csrfKey: Buffer.alloc(32, 7),
    applicationsForPrincipal: async () => catalog, clock: () => current, ...overrides,
  });
  return { ...f, handler, principal: next => { principal = next; }, time: next => { current = next; } };
}
async function csrf(f) {
  const response = await f.handler(new Request(`${origin}/connections`));
  assert.equal(response.status, 200);
  const html = await response.text();
  return { html, token: /name="csrf" value="([^"]+)"/.exec(html)?.[1], response };
}
const post = (f, fields, headers = {}) => f.handler(new Request(`${origin}/connections`, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) }));
const grantForm = token => ({ csrf: token, action: 'grant', applicationId, queries: 'assistanceStatus', events: 'assistant.help_requested', days: '7' });

test('management page escapes labels, selects no permissions and rejects framing/caching', async () => {
  const f = management();
  const { html, token, response } = await csrf(f);
  assert.ok(token);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /checked/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.deepEqual(await f.service.list(owner), []);
});

test('management grants only submitted declared permissions and disconnects them', async () => {
  const f = management();
  const { token } = await csrf(f);
  const response = await post(f, grantForm(token));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/connections');
  const [saved] = await f.service.list(owner);
  assert.deepEqual(saved.queries, ['assistanceStatus']);
  assert.deepEqual(saved.commands, []);
  assert.equal(saved.readEvents, false);
  assert.equal(saved.expiresAt, now + 7 * 86_400_000);
  const disconnected = await post(f, { csrf: token, action: 'revoke', id: saved.id });
  assert.equal(disconnected.status, 303);
  assert.equal((await f.service.list(owner))[0].status, 'revoked');
});

test('management rejects cross-origin, missing, forged, expired and cross-account CSRF', async () => {
  const f = management();
  const { token } = await csrf(f);
  assert.equal((await post(f, grantForm(token), { origin: 'https://attacker.example.test' })).status, 403);
  assert.equal((await post(f, grantForm(''))).status, 403);
  assert.equal((await post(f, grantForm(token + 'x'))).status, 403);
  f.principal(other);
  assert.equal((await post(f, grantForm(token))).status, 403);
  f.principal(owner); f.time(now + 300_000);
  assert.equal((await post(f, grantForm(token))).status, 403);
  assert.deepEqual(await f.service.list(owner), []);
});

test('management rechecks the catalog and ownership and rejects hidden privilege injection', async () => {
  const f = management();
  const { token } = await csrf(f);
  for (const fields of [
    { ...grantForm(token), commands: 'grantPublisher' },
    { ...grantForm(token), applicationId: 'other-application' },
    { ...grantForm(token), principalId: other.id },
    { ...grantForm(token), days: '365000' },
  ]) assert.ok([400,403,404].includes((await post(f, fields)).status));
  const duplicate = new URLSearchParams(grantForm(token)); duplicate.append('applicationId', applicationId);
  assert.equal((await post(f, duplicate)).status, 400);
  const forbidden = management({ service: fixture({ authorizeOwner: () => false }).service });
  const ownedToken = (await csrf(forbidden)).token;
  assert.equal((await post(forbidden, grantForm(ownedToken))).status, 403);
  assert.deepEqual(await f.service.list(owner), []);
});

test('management bounds request bodies and refuses unsafe adapters/configuration', async () => {
  const f = management();
  const { token } = await csrf(f);
  assert.equal((await post(f, { ...grantForm(token), queries: 'x'.repeat(20_000) })).status, 413);
  assert.equal((await post(f, grantForm(token), { 'content-type': 'application/json' })).status, 415);
  assert.equal((await f.handler(new Request(`${origin}/elsewhere`))).status, 404);
  assert.equal((await f.handler(new Request(`${origin}/connections`, { method: 'DELETE' }))).status, 405);
  assert.throws(() => management({ csrfKey: Buffer.alloc(4) }), TypeError);
  assert.throws(() => management({ origin: 'http://mcp.example.test' }), TypeError);
  assert.throws(() => management({ authenticate: undefined }), TypeError);
  assert.throws(() => management({ path: '//attacker.example.test' }), TypeError);
});
