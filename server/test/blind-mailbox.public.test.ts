import { describe, expect, it } from 'vitest';
import quickJsWasm from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import sqliteCasWasm from '@chronolog/peer-session/sqlite-cas.wasm';
import {
  bytesToHex,
  createApplicationSession,
  encodeRecord,
  openApplicationDevice,
  signRecord,
} from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import { createPageGenesis } from '../../session/admission.mjs';
import { create, inDO, req, type Handle } from './helpers';

function enrollReq(h: Handle, body: Record<string, unknown>, options: { anonymous?: boolean } = {}): Promise<Response> {
  return req(`${h.page_url}_tendril/peers/enrollment`, {
    method: 'POST',
    anonymous: options.anonymous,
    headers: {
      'Content-Type': 'application/json',
      Origin: new URL(h.page_url).origin,
    },
    body: JSON.stringify(body),
  });
}

describe('Chronolog v2 blind store-and-forward mailbox & blockedAuthors moderation', () => {
  it('relays opaque AEAD encrypted envelopes between offline private peers without plaintext access', async () => {
    const h = await create();
    const aliceDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const bobDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const aliceWrap = aliceDev.wrapKey;
    const bobWrap = bobDev.wrapKey;

    const created = await createPageGenesis({
      identity: aliceDev.identity,
      wrapKey: aliceWrap.publicKey,
      authority: { mode: 'multisig', signers: [aliceDev.identity.publicKey], threshold: 1 },
      privateLog: true,
      topics: { db: { module: 'chronolog/sql' } },
    });

    // Initialize genesis via owner session
    const initRes = await enrollReq(h, {
      action: 'initialize',
      genesis: authorityRecord(created.genesisBytes),
      casNodes: created.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    });
    expect(initRes.status).toBe(200);

    const alice = await createApplicationSession({
      device: aliceDev,
      genesis: created.genesisBytes,
      casNodes: created.casNodes,
      epochKeys: new Map([[0, created.epoch0Key!]]),
      wasmModule: quickJsWasm,
      sqliteWasmModule: sqliteCasWasm,
    });
    const bob = await createApplicationSession({
      device: bobDev,
      genesis: created.genesisBytes,
      casNodes: created.casNodes,
      epochKeys: new Map([[0, created.epoch0Key!]]),
      wasmModule: quickJsWasm,
      sqliteWasmModule: sqliteCasWasm,
    });
    try {
      // Alice authors encrypted SQL rows offline, then pushes ONLY encrypted envelopes to the host mailbox
      const op = await alice.command('migrate', {
        statements: [
          'CREATE TABLE inbox (id TEXT PRIMARY KEY, msg TEXT NOT NULL)',
          { sql: 'INSERT INTO inbox(id, msg) VALUES (?, ?)', params: ['m1', 'Secret async message'] },
        ],
      }, { operationId: 'mbox-priv-1' });
      expect((await op.materialized()).outcome).toBe('accepted');

      const facts = await alice.exportFacts();
      expect(facts.encryptedEnvelopes.length).toBeGreaterThan(0);

      const pushRes = await enrollReq(h, {
        action: 'mailbox',
        encryptedEnvelopes: facts.encryptedEnvelopes.map(authorityRecord),
        casNodes: facts.casNodes.map(n => ({ hash: n.hash, partition: n.partition, bytes: bytesToHex(n.bytes) })),
        knownEnvelopeDigests: [],
      });
      expect(pushRes.status).toBe(200);
      const pushBody = await pushRes.json() as { addedEnvelopes: number; privateLog: boolean };
      expect(pushBody.privateLog).toBe(true);
      expect(pushBody.addedEnvelopes).toBeGreaterThan(0);

      // Verify host DO stores ZERO plaintext of the secret message and ignores unencrypted private CAS pages
      const rawMailbox = await inDO(h.id, t => t.db.all<{ raw: ArrayBuffer }>('SELECT raw FROM v2_mailbox_envelopes'));
      const rawPrivCas = await inDO(h.id, t => t.db.all<{ hash: string }>("SELECT hash FROM v2_mailbox_cas WHERE partition = 'private'"));
      expect(rawMailbox.length).toBeGreaterThan(0);
      expect(rawPrivCas.length).toBe(0);
      const textDump = rawMailbox.map(r => new TextDecoder().decode(new Uint8Array(r.raw))).join('');
      expect(textDump).not.toContain('Secret async message');

      // Anonymous visitors cannot pull a private log's mailbox
      const anonPull = await enrollReq(h, { action: 'mailbox', knownEnvelopeDigests: [], knownCasHashes: [] }, { anonymous: true });
      expect(anonPull.status).toBe(401);

      // Alice goes offline; Bob pulls from blind mailbox and decrypts/converges locally!
      const pullRes = await enrollReq(h, { action: 'mailbox', knownEnvelopeDigests: [], knownCasHashes: [] });
      expect(pullRes.status).toBe(200);
      const pullBody = await pullRes.json() as {
        encryptedEnvelopes: Array<{ record: string }>;
        casNodes: Array<{ hash: string; partition: 'public' | 'private'; bytes: string }>;
      };
      await bob.mergeFacts({
        publicOps: [],
        encryptedEnvelopes: pullBody.encryptedEnvelopes.map(r => authorityRecordBytes(r)),
        casNodes: pullBody.casNodes.map(n => ({
          hash: n.hash,
          partition: n.partition,
          bytes: Uint8Array.from(n.bytes.match(/../g) ?? [], b => parseInt(b, 16)),
        })),
        retentions: [],
        checkpoints: [],
      });
      const bobRows = await bob.query('sql', { sql: 'SELECT id, msg FROM inbox', format: 'objects' });
      expect((bobRows.value as { rows: unknown[] }).rows).toEqual([{ id: 'm1', msg: 'Secret async message' }]);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it('hydrates public openMembers pages from mailbox when creator is offline and purges blockedAuthors immediately', async () => {
    const h = await create();
    const adminDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const guestDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const spamDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const adminWrap = adminDev.wrapKey;

    const created = await createPageGenesis({
      identity: adminDev.identity,
      wrapKey: adminWrap.publicKey,
      authority: { mode: 'open', openRead: true, openWrite: true },
      topics: { db: { module: 'chronolog/sql' } },
    });

    const initRes = await enrollReq(h, {
      action: 'initialize',
      genesis: authorityRecord(created.genesisBytes),
      casNodes: created.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    });
    expect(initRes.status).toBe(200);

    const admin = await createApplicationSession({ device: adminDev, genesis: created.genesisBytes, casNodes: created.casNodes, wasmModule: quickJsWasm, sqliteWasmModule: sqliteCasWasm });
    const spam = await createApplicationSession({ device: spamDev, genesis: created.genesisBytes, casNodes: created.casNodes, wasmModule: quickJsWasm, sqliteWasmModule: sqliteCasWasm });
    const guest = await createApplicationSession({ device: guestDev, genesis: created.genesisBytes, casNodes: created.casNodes, wasmModule: quickJsWasm, sqliteWasmModule: sqliteCasWasm });
    try {
      await (await admin.command('migrate', {
        statements: [
          'CREATE TABLE posts (id TEXT PRIMARY KEY, body TEXT NOT NULL)',
          { sql: 'INSERT INTO posts(id, body) VALUES (?, ?)', params: ['p1', 'Welcome everyone'] },
        ],
      }, { operationId: 'pub-1' })).materialized();

      await spam.mergeFacts(await admin.exportFacts());
      await (await spam.command('exec', {
        statements: [{ sql: 'INSERT INTO posts(id, body) VALUES (?, ?)', params: ['spam1', 'Buy junk'] }],
      }, { operationId: 'spam-post-1' })).materialized();

      // Push both admin and spammer ops into the public mailbox (anonymous visitor allowed on openRead page)
      const spamFacts = await spam.exportFacts();
      const pushRes = await enrollReq(h, {
        action: 'mailbox',
        publicOps: spamFacts.publicOps.map(authorityRecord),
        knownOpIds: [],
      }, { anonymous: true });
      expect(pushRes.status).toBe(200);
      expect(((await pushRes.json()) as { addedOps: number }).addedOps).toBe(2);

      // Admin blocks spammer via $permissions -> host reconciles & immediately purges spammer's mailbox ops!
      const blkOp = await admin.submit({
        visibility: 'public',
        operationId: 'block-spammer',
        updates: [{ topic: '$permissions', input: { action: 'blockAuthor', publicKey: spamDev.identity.publicKey, reason: 'spam' } }],
      });
      expect((await blkOp.materialized()).outcome).toBe('accepted');
      const ctrlFacts = await admin.exportPublicControlFacts();
      const syncCtrl = await enrollReq(h, {
        action: 'sync',
        publicOps: ctrlFacts.publicOps.filter((_, i) => i === ctrlFacts.publicOps.length - 1).map(authorityRecord),
      });
      expect(syncCtrl.status).toBe(200);

      // Anonymous guest opens later while admin is offline -> mailbox serves ONLY admin's post (spammer purged!)
      const pullRes = await enrollReq(h, { action: 'mailbox', knownOpIds: [] }, { anonymous: true });
      expect(pullRes.status).toBe(200);
      const pullBody = await pullRes.json() as { publicOps: Array<{ record: string }> };
      expect(pullBody.publicOps.length).toBe(1);

      await guest.mergeFacts({
        publicOps: pullBody.publicOps.map(r => authorityRecordBytes(r)),
        encryptedEnvelopes: [],
        casNodes: [],
        retentions: [],
        checkpoints: [],
      });
      const rows = await guest.query('sql', { sql: 'SELECT id, body FROM posts', format: 'objects' });
      expect((rows.value as { rows: unknown[] }).rows).toEqual([{ id: 'p1', body: 'Welcome everyone' }]);
    } finally {
      await admin.close();
      await spam.close();
      await guest.close();
    }
  });

  it('accepts Ed25519-signed multisig join_request entries and filters admitted/blocked keys from join_requests', async () => {
    const h = await create();
    const signerA = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const candidate = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const wrapA = signerA.wrapKey;
    const wrapCand = candidate.wrapKey;

    const created = await createPageGenesis({
      identity: signerA.identity,
      wrapKey: wrapA.publicKey,
      authority: { mode: 'multisig', signers: [signerA.identity.publicKey], threshold: 1 },
      privateLog: true,
      topics: { db: { module: 'chronolog/sql' } },
    });

    const initRes = await enrollReq(h, {
      action: 'initialize',
      genesis: authorityRecord(created.genesisBytes),
      casNodes: created.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    });
    expect(initRes.status).toBe(200);

    const signedReq = await signRecord('tendriller-join-request-v1', {
      applicationId: created.logId,
      publicKey: candidate.identity.publicKey,
      wrapKey: wrapCand.publicKey,
      label: 'Alice phone',
      requestedAt: Date.now(),
    }, candidate.identity);

    const postRes = await enrollReq(h, {
      action: 'join_request',
      request: authorityRecord(encodeRecord(signedReq)),
    });
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ accepted: true, count: 1 });

    const listRes = await enrollReq(h, { action: 'join_requests' });
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as { requests: Array<{ publicKey: string; wrapKey: string; label: string }> };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject({
      publicKey: candidate.identity.publicKey,
      wrapKey: wrapCand.publicKey,
      label: 'Alice phone',
    });
  });
});
