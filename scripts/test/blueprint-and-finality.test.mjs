import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationSession, openApplicationDevice } from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { createPageGenesis, deviceWrapKey } from '../../session/admission.mjs';
import {
  BLUEPRINT_FORMAT,
  createGenesisFromBlueprint,
  exportPageBlueprint,
  validatePageBlueprint,
} from '../../session/blueprint.mjs';
import { runSessionCommand } from '../../tools/cli/lib/session.mjs';

test('PageBlueprint exports reducers + SQL DDL/RLS with ZERO private rows/keys and instantiates a fresh isolated log', async () => {
  const devA = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const devB = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const wrapA = await deviceWrapKey(devA.store);
  const wrapB = await deviceWrapKey(devB.store);

  const customMod = `export default { reduce(s, tx) { return { ok: true, state: { last: tx.payload?.v ?? null } }; }, query(s) { return s ?? { last: null }; } };`;
  const created = await createPageGenesis({
    identity: devA.identity,
    wrapKey: wrapA.publicKey,
    privateLog: true,
    admission: null,
    imports: { '@app/custom': customMod },
    topics: {
      sql: { module: 'chronolog/sql' },
      custom: { module: '@app/custom' },
    },
  });

  const srcSession = await createApplicationSession({
    device: devA,
    genesis: created.genesisBytes,
    casNodes: created.casNodes,
    epochKeys: new Map([[0, created.epoch0Key]]),
  });

  const scratch = mkdtempSync(join(tmpdir(), 'tendril-bp-'));
  let remixedSession;
  try {
    // Populate schema + RLS + SECRET PRIVATE DATA on source log
    await srcSession.submit({
      operationId: 'mig-1',
      updates: [{
        topic: 'sql',
        input: {
          action: 'migrate',
          statements: ['CREATE TABLE secrets (id TEXT PRIMARY KEY, body TEXT NOT NULL, owner TEXT NOT NULL)'],
          policies: { secrets: { insert: 'NEW.owner = actor()', update: 'OLD.owner = actor()' } },
        },
      }],
    });
    await srcSession.submit({
      operationId: 'sec-1',
      updates: [{
        topic: 'sql',
        input: { statements: [{ sql: 'INSERT INTO secrets(id, body, owner) VALUES (?, ?, actor())', params: ['s1', 'TOP_SECRET_PASSWORD_999'] }] },
      }],
    });
    await srcSession.submit({
      operationId: 'cust-1',
      updates: [{ topic: 'custom', input: { v: 'PRIVATE_CUSTOM_VALUE' } }],
    });

    // Export blueprint — must contain ZERO private data!
    const bp = await exportPageBlueprint(srcSession, { title: 'Vault Template' });
    assert.equal(bp.format, BLUEPRINT_FORMAT);
    const serialized = JSON.stringify(bp);
    assert.ok(!serialized.includes('TOP_SECRET_PASSWORD_999'), 'Blueprint must never leak SQL rows');
    assert.ok(!serialized.includes('PRIVATE_CUSTOM_VALUE'), 'Blueprint must never leak custom topic state');
    assert.equal(bp.schemas.length, 1);
    assert.ok(bp.schemas[0].statements.some(s => /CREATE TABLE secrets/i.test(s)));
    assert.equal(bp.schemas[0].policies.secrets.insert, 'NEW.owner = actor()');
    assert.equal(bp.reducers.casModules.length, 1);

    // Tampered CAS module hash must fail validation
    const tampered = structuredClone(bp);
    tampered.reducers.casModules[0].bytesBase64 = Buffer.from('export default {}').toString('base64');
    assert.throws(() => validatePageBlueprint(tampered), err => err?.code === 'BLUEPRINT_HASH_MISMATCH');

    // Instantiate brand-new isolated log on Device B from blueprint
    const forked = await createGenesisFromBlueprint({
      blueprint: bp,
      identity: devB.identity,
      wrapKey: wrapB.publicKey,
      admission: null,
    });
    assert.notEqual(forked.logId, created.logId);
    assert.ok(forked.epoch0Key instanceof Uint8Array);
    assert.equal(forked.initialMigrations.length, 1);

    remixedSession = await createApplicationSession({
      device: devB,
      genesis: forked.genesisBytes,
      casNodes: forked.casNodes,
      epochKeys: new Map([[0, forked.epoch0Key]]),
    });
    for (const mig of forked.initialMigrations) {
      const op = await remixedSession.submit({ operationId: `init-${mig.topic}`, updates: [mig] });
      assert.equal((await op.materialized()).outcome, 'accepted');
    }
    const rows = (await remixedSession.query('sql', { sql: 'SELECT * FROM secrets' })).value.rows;
    assert.equal(rows.length, 0);
    const ins = await remixedSession.submit({
      operationId: 'new-row',
      updates: [{ topic: 'sql', input: { statements: [{ sql: 'INSERT INTO secrets(id, body, owner) VALUES (?, ?, actor())', params: ['r1', 'Fresh data'] }] } }],
    });
    assert.equal((await ins.materialized()).outcome, 'accepted');

    // Test CLI `finality schedule` transitioning none -> signed-frontier
    const sched = await runSessionCommand(
      { session: remixedSession },
      'finality',
      ['schedule'],
      {
        kind: 'signed-frontier',
        signer: devB.identity.publicKey,
        'effective-after': String(Date.now() + 10_000),
        operation: 'fin-sched-1',
        wait: 'materialized',
      },
    );
    assert.equal(sched.materialized?.outcome, 'accepted');
    const finTopic = remixedSession.topic('$finality');
    assert.equal(finTopic.schedule[finTopic.schedule.length - 1].policy.kind, 'signed-frontier');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (remixedSession) await remixedSession.close();
    await srcSession.close();
    await devA.close();
    await devB.close();
  }
});
