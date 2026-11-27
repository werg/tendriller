import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationSession, openApplicationDevice } from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { createPageGenesis, deviceWrapKey } from '../../session/admission.mjs';
import { queryMultipleSessions } from '../../docs/tutorial/shared/helpers/multi-page.mjs';

test('queryMultipleSessions fans out read-only SQL queries across multiple Chronolog v2 sessions with error isolation', async () => {
  const mkSqlPage = async (topicName, tableName, rows) => {
    const dev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const wrap = await deviceWrapKey(dev.store);
    const created = await createPageGenesis({
      identity: dev.identity,
      wrapKey: wrap.publicKey,
      authority: { mode: 'open', openRead: true, openWrite: true },
      topics: { [topicName]: { module: 'chronolog/sql' } },
    });
    const session = await createApplicationSession({ device: dev, genesis: created.genesisBytes, casNodes: created.casNodes });
    await session.submit({
      operationId: 'init',
      updates: [{
        topic: topicName,
        input: {
          action: 'migrate',
          statements: [
            `CREATE TABLE ${tableName} (id TEXT PRIMARY KEY, label TEXT NOT NULL)`,
            ...rows.map(([id, label]) => ({ sql: `INSERT INTO ${tableName}(id, label) VALUES (?, ?)`, params: [id, label] })),
          ],
        },
      }],
    });
    return { dev, session };
  };

  const p1 = await mkSqlPage('notes_db', 'items', [['n1', 'Buy milk'], ['n2', 'Call Alex']]);
  const p2 = await mkSqlPage('work_db', 'items', [['w1', 'Ship v2']]);

  try {
    const res = await queryMultipleSessions([
      { page: 'personal', session: p1.session },
      { page: 'work', session: p2.session },
      { page: 'broken', async open() { throw Object.assign(new Error('offline'), { code: 'OWNER_UNREACHABLE' }); } },
    ], {
      sql: 'SELECT id, label FROM items ORDER BY id',
      format: 'objects',
      concurrency: 2,
    });

    assert.equal(res.succeeded, 2);
    assert.equal(res.failed, 1);
    assert.equal(res.results[0].page, 'personal');
    assert.equal(res.results[0].ok, true);
    assert.equal(res.results[0].topic, 'notes_db');
    assert.deepEqual(res.results[0].value.rows, [{ id: 'n1', label: 'Buy milk' }, { id: 'n2', label: 'Call Alex' }]);

    assert.equal(res.results[1].page, 'work');
    assert.equal(res.results[1].ok, true);
    assert.equal(res.results[1].topic, 'work_db');
    assert.deepEqual(res.results[1].value.rows, [{ id: 'w1', label: 'Ship v2' }]);

    assert.equal(res.results[2].page, 'broken');
    assert.equal(res.results[2].ok, false);
    assert.equal(res.results[2].error.code, 'OWNER_UNREACHABLE');
  } finally {
    await p1.session.close();
    await p2.session.close();
    await p1.dev.close();
    await p2.dev.close();
  }
});
