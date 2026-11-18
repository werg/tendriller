import { afterEach, expect, it, vi } from 'vitest';
import { evictDurableObject } from 'cloudflare:test';
import {
  createPeerIdentity, participantGrant, bytesDigest, signPublicationManifest, signTransitionRequest,
  encodePeerValue, decodePeerValue, type AuthorityBundle,
} from '@chronolog/peer-generation/control';
import { authenticateAgentToken } from '../src/access';
import { exchangePeerControl } from '../src/peer-generations';
import { exchangePeerPublication, type PeerPublicationReceipt } from '../src/peer-publications';
import { exchangeDiscovery } from '../src/discovery';
import { handlePeers } from '../src/peers';
import { create, inDO, stub } from './helpers';
import { peerApiJson } from './peer-exchange';

afterEach(() => vi.restoreAllMocks());

async function configured() {
  const author = await createPeerIdentity();
  const page = await create({ application: { id: crypto.randomUUID().replaceAll('-', '').repeat(2) } });
  const authority = await peerApiJson<AuthorityBundle>(page, 'control/configure', {
    historyId: 'control-cost', executionManifestDigest: '12'.repeat(32),
    definition: { id: 'control-cost', version: '1', schema: null, commands: [], queries: [] },
    schemaAdministrator: author.publicKey, epoch: 0, keyDigest: '34'.repeat(32),
    members: [{ grant: participantGrant(author.publicKey, { administrator: true, publisher: true }) }],
  });
  const data = new TextEncoder().encode('<main>Retained publication</main>'), hash = await bytesDigest(data);
  const descriptor = authority.descriptor.payload;
  const publication = await signPublicationManifest({ applicationId: descriptor.applicationId, historyId: descriptor.historyId,
    profile: descriptor.profile, controlRevision: 0, author: author.publicKey, operationId: 'first', revision: 0, previous: null,
    definitionDigest: descriptor.definitionDigest, executionManifestDigest: descriptor.executionManifestDigest,
    entry: 'index.html', files: [{ path: 'index.html', type: 'text/html', hash, size: data.length }] }, author);
  const receipt = await peerApiJson<PeerPublicationReceipt>(page, 'publication/publish', {
    publication, assets: [{ hash, bytes: btoa(String.fromCharCode(...data)) }],
  });
  return { page, author, authority, receipt };
}

it('serves warm control, definition and publication reads with zero local SQL and signature verification while checking fresh policy', async () => {
  const { page, authority, receipt } = await configured();
  const measured = await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token);
    const read = () => exchangePeerControl(t, principal, 'read') as Promise<AuthorityBundle>;
    const definition = () => exchangePeerControl(t, principal, 'definition') as Promise<{ definition: { version: string } }>;
    const publication = () => exchangePeerPublication(t, principal, 'read', {}) as Promise<PeerPublicationReceipt>;
    const control = await read(), metadata = await definition(), retained = await publication();
    // No response may mutate the next request's retained verification result.
    Object.assign(control.descriptor.payload, { historyId: 'poisoned' }); metadata.definition.version = 'poisoned';
    Object.assign(retained.publication.payload, { entry: 'poisoned.html' });
    const counts = { queries: 0, rowsRead: 0, rowsWritten: 0, policyQueries: 0 };
    const exec = t.ctx.storage.sql.exec.bind(t.ctx.storage.sql), database = t.env.ACCOUNTS;
    const sql = vi.spyOn(t.ctx.storage.sql, 'exec').mockImplementation((query, ...bindings) => {
      counts.queries++;
      const cursor = exec(query, ...bindings);
      return new Proxy(cursor, { get(value, field) {
        if (field === 'toArray') return () => {
          const rows = value.toArray(); counts.rowsRead += value.rowsRead; counts.rowsWritten += value.rowsWritten; return rows;
        };
        return Reflect.get(value, field, value);
      } });
    });
    const verify = vi.spyOn(crypto.subtle, 'verify');
    t.env.ACCOUNTS = new Proxy(database, { get(target, key) {
      if (key === 'prepare') return (query: string) => { counts.policyQueries++; return target.prepare(query); };
      return Reflect.get(target, key, target);
    } });
    try {
      for (let i = 0; i < 20; i++) {
        expect(await read()).toEqual(authority);
        expect((await definition()).definition.version).toBe('1');
        expect(await publication()).toEqual(receipt);
      }
      return { ...counts, signatureVerifications: verify.mock.calls.length };
    } finally { t.env.ACCOUNTS = database; sql.mockRestore(); verify.mockRestore(); }
  });
  expect(measured).toEqual({ queries: 0, rowsRead: 0, rowsWritten: 0, policyQueries: 80, signatureVerifications: 0 });
  console.info('Warm control read work for 60 requests', measured);
});

it.each(['signing identity', 'registry', 'definition', 'publication'] as const)('invalidates warm verification when retained %s changes', async kind => {
  const { page } = await configured();
  await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token);
    await exchangePeerControl(t, principal, 'read');
    await exchangePeerControl(t, principal, 'definition');
    await exchangePeerPublication(t, principal, 'read', {});
    if (kind === 'signing identity') {
      t.db.run('DELETE FROM participant_records WHERE key=?', 'peer-generation/identity');
      await expect(exchangePeerControl(t, principal, 'read')).rejects.toMatchObject({ status: 503, code: 'peer_control_state_missing' });
    } else if (kind === 'registry') {
      const row = t.db.one<{ key: string; value: ArrayBuffer }>("SELECT key,value FROM participant_records WHERE key LIKE 'peer-generation/registry/%'")!;
      const value = decodePeerValue(new Uint8Array(row.value)) as AuthorityBundle;
      Object.assign(value.controls[0], { signature: '00'.repeat(64) });
      t.db.run('UPDATE participant_records SET value=? WHERE key=?', encodePeerValue(value).buffer, row.key);
      await expect(exchangePeerControl(t, principal, 'read')).rejects.toMatchObject({ status: 403, code: 'peer_signature_invalid' });
    } else if (kind === 'definition') {
      const value = t.db.get<any>('peer_generation_configuration', null);
      t.db.set('peer_generation_configuration', { ...value, definition: { ...value.definition, version: 'tampered' } });
      await expect(exchangePeerControl(t, principal, 'definition')).rejects.toMatchObject({ status: 503, code: 'peer_definition_state_mismatch' });
    } else {
      const value = t.db.get<PeerPublicationReceipt>('peer_publication_head', null!);
      t.db.set('peer_publication_head', { ...value, publication: { ...value.publication, signature: '00'.repeat(64) } });
      await expect(exchangePeerPublication(t, principal, 'read', {})).rejects.toMatchObject({ status: 403, code: 'peer_signature_invalid' });
    }
  });
});

it('does not expose cached publication receipts through new publish results, exact retries or submitted manifests', async () => {
  const { page, author, receipt } = await configured();
  const publication = await signPublicationManifest({ ...receipt.publication.payload,
    operationId: 'next', revision: 1, previous: receipt.publication.id }, author);
  await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token), input = { publication: structuredClone(publication), assets: [] };
    const published = await exchangePeerPublication(t, principal, 'publish', input) as PeerPublicationReceipt;
    const expected = structuredClone(published);
    Object.assign(published.publication.payload, { entry: 'poisoned-result.html' });
    Object.assign(input.publication.payload, { entry: 'poisoned-input.html' });
    expect(await exchangePeerPublication(t, principal, 'read', {})).toEqual(expected);
    const retry = await exchangePeerPublication(t, principal, 'publish', { publication, assets: [] }) as PeerPublicationReceipt;
    Object.assign(retry.publication.payload, { entry: 'poisoned-retry.html' });
    expect(await exchangePeerPublication(t, principal, 'read', {})).toEqual(expected);
  });
});

it('rebuilds verified state after rollback and actual object eviction', async () => {
  const { page, authority, receipt } = await configured();
  await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token);
    await exchangePeerControl(t, principal, 'read'); await exchangePeerPublication(t, principal, 'read', {});
    expect(() => t.transaction(() => {
      t.db.run('DELETE FROM participant_records');
      t.db.del('peer_publication_head');
      throw new Error('rollback');
    })).toThrow('rollback');
    const verify = vi.spyOn(crypto.subtle, 'verify');
    try {
      expect(await exchangePeerControl(t, principal, 'read')).toEqual(authority);
      expect(await exchangePeerPublication(t, principal, 'read', {})).toEqual(receipt);
      expect(verify.mock.calls.length).toBeGreaterThan(0);
    } finally { verify.mockRestore(); }
  });
  await evictDurableObject(stub(page.id));
  expect(await peerApiJson(page, 'control/read')).toEqual(authority);
  expect(await peerApiJson(page, 'publication/read')).toEqual(receipt);
});

it.each(['suspension', 'ownership change'] as const)('checks fresh owner policy and local identity immediately before a prepared control commit after %s', async change => {
  const { page, authority, author } = await configured();
  const request = await signTransitionRequest({ applicationId: authority.descriptor.payload.applicationId, profile: 'peer-generation-v1',
    policy: 'eligible-members-v1', transitionId: 'in-flight-change', requester: author.publicKey, coordinator: author.publicKey,
    expectedGeneration: null, controlRevision: 0, reason: 'create', base: null }, author);
  await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token), database = t.env.ACCOUNTS;
    await exchangePeerControl(t, principal, 'read');
    let checked = false;
    t.env.ACCOUNTS = { prepare(sql: string) {
      const statement = database.prepare(sql);
      if (!sql.includes('FROM tendrils t')) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { async first() {
          checked = true;
          if (change === 'suspension') await database.prepare('UPDATE accounts SET suspended_at=? WHERE id=?')
            .bind(t.now(), t.db.get('owner_account', '')).run();
          const result = await bound.first();
          if (change === 'ownership change') t.db.set('owner_account', 'changed-after-policy-read');
          return result;
        } };
      } };
    } } as D1Database;
    try {
      await expect(exchangePeerControl(t, principal, 'select', { request })).rejects.toMatchObject({ status: 403 });
      expect(checked).toBe(true);
      const row = t.db.one<{ value: ArrayBuffer }>("SELECT value FROM participant_records WHERE key LIKE 'peer-generation/registry/%'")!;
      expect((decodePeerValue(new Uint8Array(row.value)) as AuthorityBundle).generations).toEqual([]);
    } finally { t.env.ACCOUNTS = database; }
  });
});

it('keeps duplicate discovery withdrawals and bootstrap settings read-only while still removing expired hints', async () => {
  const page = await create();
  await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token), url = new URL('https://tendril.internal/peers/bootstrap');
    const bootstrap = { version: 2, endpoints: [] };
    const put = () => handlePeers(t, new Request(url, { method: 'PUT', body: JSON.stringify(bootstrap) }), url, 'peers/bootstrap', principal);
    expect((await put()).status).toBe(200);
    const set = vi.spyOn(t.db, 'set');
    try {
      for (let i = 0; i < 20; i++) {
        await exchangeDiscovery(t, principal, 'withdraw', { peerId: 'absent' });
        expect((await put()).status).toBe(200);
      }
      expect(set).not.toHaveBeenCalled();
      await exchangeDiscovery(t, principal, 'advertise', { advertisement: { peerId: 'expired', storageId: 'store:expired',
        routes: [{ kind: 'rendezvous', channel: 'join:expired' }] } });
      t.skew += 120_000;
      set.mockClear();
      await exchangeDiscovery(t, principal, 'withdraw', { peerId: 'absent' });
      expect(set).toHaveBeenCalledOnce();
      expect(t.db.get('peer_directory', null)).toEqual([]);
    } finally { set.mockRestore(); }
  });
});
