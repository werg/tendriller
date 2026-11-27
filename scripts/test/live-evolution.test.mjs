import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationSession, openApplicationDevice } from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { createPageGenesis } from '../../session/admission.mjs';
import {
  dryRunReducerModule,
  evolveSqlSchema,
  publishReducerModule,
  runPersonalDdl,
} from '../../docs/tutorial/shared/helpers/live-evolution.mjs';
import { runSessionCommand } from '../../tools/cli/lib/session.mjs';

test('dryRunReducerModule rejects broken ES Modules before touching live logs', async () => {
  await assert.rejects(
    () => dryRunReducerModule({
      specifier: '@app/broken',
      source: 'export default { reduce( { broken syntax',
    }),
    err => err?.code === 'REDUCER_DRYRUN_FAILED',
  );
});

test('hot-publishing a new ES Module reducer and evolving SQL schema + personal DDL converge across peers without redeploy', async () => {
  const adminDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const writerDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const adminWrap = adminDev.wrapKey;

  const created = await createPageGenesis({
    identity: adminDev.identity,
    wrapKey: adminWrap.publicKey,
    authority: { mode: 'open', openRead: true, openWrite: true },
    topics: { sql: { module: 'chronolog/sql' } },
  });

  const admin = await createApplicationSession({ device: adminDev, genesis: created.genesisBytes, casNodes: created.casNodes });
  const peer = await createApplicationSession({ device: writerDev, genesis: created.genesisBytes, casNodes: created.casNodes });
  const scratch = mkdtempSync(join(tmpdir(), 'tendril-live-evo-'));

  try {
    // 1. Live SQL migration via evolveSqlSchema
    const m1 = await evolveSqlSchema(admin, {
      topic: 'sql',
      statements: ['CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL)'],
      policies: { tasks: { insert: 'NEW.owner = actor()', update: 'OLD.owner = actor()', delete: 'OLD.owner = actor()' } },
      expectedSchemaVersion: 0,
      operationId: 'mig-1',
    });
    assert.equal((await m1.operation.materialized()).outcome, 'accepted');

    // Optimistic version guard rejects stale expectedSchemaVersion
    await assert.rejects(
      () => evolveSqlSchema(admin, { topic: 'sql', statements: ['ALTER TABLE tasks ADD COLUMN priority INTEGER'], expectedSchemaVersion: 0 }),
      err => err?.code === 'SCHEMA_VERSION_MISMATCH',
    );

    // 2. CLI sql migrate-file adds column live
    const sqlFile = join(scratch, '002_priority.sql');
    writeFileSync(sqlFile, 'ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0;\n');
    const cliMig = await runSessionCommand(
      { session: admin },
      'sql',
      ['migrate-file', sqlFile],
      { topic: 'sql', operation: 'mig-2', wait: 'materialized' },
    );
    assert.equal(cliMig.materialized?.outcome, 'accepted');

    // 3. Hot-publish a brand-new ES Module topic reducer live via publishReducerModule
    const counterSource = `
      export default {
        reduce(state, tx) {
          const cur = state && typeof state === 'object' ? state : { count: 0 };
          const delta = Number(tx.payload?.delta ?? 1);
          return { ok: true, state: { count: cur.count + delta } };
        },
        query(state) { return state || { count: 0 }; },
      };
    `;
    const pub = await publishReducerModule(admin, {
      specifier: '@app/counter',
      source: counterSource,
      topicBindings: { counter: { module: '@app/counter' } },
      operationId: 'red-1',
      sampleInput: { delta: 2 },
    });
    assert.equal((await pub.operation.materialized()).outcome, 'accepted');

    // Submit an op to the hot-added topic!
    const inc = await admin.submit({ updates: [{ topic: 'counter', input: { delta: 5 } }], operationId: 'cnt-1' });
    assert.equal((await inc.materialized()).outcome, 'accepted');
    assert.deepEqual((await admin.query('counter', null)).value, { count: 5 });

    // Also test CLI `reducers publish` for a second hot module
    const taggerPath = join(scratch, 'tagger.mjs');
    writeFileSync(taggerPath, `export default { reduce(s, tx) { return { ok: true, state: { tag: tx.payload?.tag || 'v1' } }; }, query(s) { return s; } };\n`);
    const cliPub = await runSessionCommand(
      { session: admin },
      'reducers',
      ['publish', '@app/tagger', taggerPath],
      { bind: 'tagger=@app/tagger', operation: 'red-2', wait: 'materialized' },
    );
    assert.equal(cliPub.operation.materialized?.outcome, 'accepted');

    // 4. Sync to peer — peer executes hot-added reducer & evolved schema with ZERO redeploy!
    await peer.mergeFacts(await admin.exportFacts());
    assert.deepEqual((await peer.query('counter', null)).value, { count: 5 });
    const peerSchema = (await peer.query('sql', { kind: 'schema' })).value;
    assert.ok(peerSchema.tables.find(t => t.name === 'tasks')?.columns.includes('priority'));

    // 5. Non-admin writer creates a personal dynamic table via runPersonalDdl, cannot drop admin's `tasks` table!
    const personal = await runPersonalDdl(peer, {
      topic: 'sql',
      statements: 'CREATE TABLE my_scratch (k TEXT PRIMARY KEY, v TEXT)',
      operationId: 'user-ddl-1',
    });
    assert.equal((await personal.materialized()).outcome, 'accepted');

    const badDrop = await runPersonalDdl(peer, {
      topic: 'sql',
      statements: 'DROP TABLE tasks',
      operationId: 'user-ddl-bad',
    });
    assert.equal((await badDrop.materialized()).outcome, 'rejected');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    await admin.close();
    await peer.close();
    await adminDev.close();
    await writerDev.close();
  }
});
