import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationSession, openApplicationDevice } from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { createPageGenesis } from '../../session/admission.mjs';
import { definition, imports, topics } from '../../docs/tutorial/templates/knowledge/domain.mjs';
import { embedTextLocal, buildSafeFtsQuery } from '../../docs/tutorial/shared/helpers/hybrid-memory.mjs';

test('knowledge starter supports encrypted FTS5 + sqlite-vec hybrid search, write RLS, and bit-exact multi-peer convergence', async () => {
  const devA = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const devB = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const wrapA = devA.wrapKey;
  const wrapB = devB.wrapKey;

  const created = await createPageGenesis({
    identity: devA.identity,
    wrapKey: wrapA.publicKey,
    authority: { mode: 'open', openRead: true, openWrite: true },
    imports,
    topics,
  });

  const peerA = await createApplicationSession({
    device: devA,
    genesis: created.genesisBytes,
    casNodes: created.casNodes,
    definition,
  });
  const peerB = await createApplicationSession({
    device: devB,
    genesis: created.genesisBytes,
    casNodes: created.casNodes,
    definition,
  });

  try {
    const initOp = await peerA.command('initialize', null, { operationId: 'init-1', authorTimestampMs: 1_700_000_000_000n });
    assert.equal((await initOp.materialized()).outcome, 'accepted');

    const op1 = await peerA.command('upsertMemory', {
      id: 'mem-coffee',
      title: 'Espresso extraction recipe',
      body: '18g finely ground dark roast, 36g yield in 28 seconds at 93C.',
      tags: ['coffee', 'kitchen'],
    }, { operationId: 'op-1', authorTimestampMs: 1_700_000_001_000n });
    assert.equal((await op1.materialized()).outcome, 'accepted');

    const op2 = await peerA.command('upsertMemory', {
      id: 'mem-crdt',
      title: 'Chronolog v2 architecture',
      body: 'Merkle-paged SQLite-CAS with FTS5 full-text search and sqlite-vec vector indexing.',
      tags: ['architecture', 'chronolog'],
    }, { operationId: 'op-2', authorTimestampMs: 1_700_000_002_000n });
    assert.equal((await op2.materialized()).outcome, 'accepted');

    // Hybrid, keyword, and semantic search all find the right top result
    const hybrid = (await peerA.query('search', { query: 'SQLite vector indexing', mode: 'hybrid' })).value;
    assert.equal(hybrid.initialized, true);
    assert.equal(hybrid.total, 2);
    assert.equal(hybrid.items[0].id, 'mem-crdt');
    assert.ok(hybrid.items[0].score > 0);

    const kw = (await peerA.query('search', { query: 'espresso', mode: 'keyword' })).value;
    assert.equal(kw.items[0].id, 'mem-coffee');

    const sem = (await peerA.query('search', { query: 'dark roast espresso yield', mode: 'semantic' })).value;
    assert.equal(sem.items[0].id, 'mem-coffee');
    assert.equal(typeof sem.items[0].vectorDistance, 'number');

    // Punctuation-heavy query never throws FTS5 syntax error
    assert.equal(buildSafeFtsQuery('c++: "foo-bar"*'), '"c"* OR "foo"* OR "bar"*');
    const punct = (await peerA.query('search', { query: 'c++: "espresso-93C"*', mode: 'hybrid' })).value;
    assert.ok(Array.isArray(punct.items));

    // Sync to Peer B, let Peer B author an EARLIER out-of-order memory AND try unauthorized overwrite
    await peerB.mergeFacts(await peerA.exportFacts());
    const lateEarlier = await peerB.command('upsertMemory', {
      id: 'mem-garden',
      title: 'Tomato watering schedule',
      body: 'Water deeply every morning before sunrise during July heatwaves.',
      tags: ['garden'],
    }, { operationId: 'op-b-early', authorTimestampMs: 1_700_000_001_500n });
    assert.equal((await lateEarlier.materialized()).outcome, 'accepted');

    // Write RLS: Peer B cannot overwrite or delete Peer A's memory without memory_grants
    const tamper = await peerB.command('upsertMemory', {
      id: 'mem-coffee',
      title: 'Hacked recipe',
      body: 'Unauthorized overwrite attempt',
    }, { operationId: 'op-b-tamper', authorTimestampMs: 1_700_000_003_000n });
    assert.equal((await tamper.materialized()).outcome, 'rejected');

    const delTamper = await peerB.command('deleteMemory', { id: 'mem-coffee' }, { operationId: 'op-b-del', authorTimestampMs: 1_700_000_003_500n });
    assert.equal((await delTamper.materialized()).outcome, 'rejected');

    // Grant Peer B writes, then let Peer B enrich Peer A's embedding!
    const grant = await peerA.command('grantMemoryWrites', { publicKey: devB.identity.publicKey }, { operationId: 'op-grant', authorTimestampMs: 1_700_000_004_000n });
    assert.equal((await grant.materialized()).outcome, 'accepted');
    await peerB.mergeFacts(await peerA.exportFacts());
    const enrich = await peerB.command('upsertEmbedding', {
      id: 'mem-crdt',
      embedding: embedTextLocal('merkle sqlite-cas vector search chronolog', 64),
      embedModel: 'agent-enriched-64',
    }, { operationId: 'op-b-embed', authorTimestampMs: 1_700_000_005_000n });
    assert.equal((await enrich.materialized()).outcome, 'accepted');

    // Full bidirectional convergence: BOTH peers must derive the exact same SQLite-CAS dbRoot!
    await peerA.mergeFacts(await peerB.exportFacts());
    const schemaA = (await peerA.query('schema', null)).value;
    const schemaB = (await peerB.query('schema', null)).value;
    assert.equal(schemaA.dbRoot, schemaB.dbRoot);
    assert.ok(typeof schemaA.dbRoot === 'string' && schemaA.dbRoot.length === 64);
    assert.equal((await peerA.query('overview', null)).value.total, 3);
  } finally {
    await peerA.close();
    await peerB.close();
    await devA.close();
    await devB.close();
  }
});
