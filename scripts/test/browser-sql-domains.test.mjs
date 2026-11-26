import assert from 'node:assert/strict';
import test from 'node:test';
import * as log from '@chronolog/peer-session';
import { checklist, intake, CHECKLIST_REDUCER, INTAKE_REDUCER } from '../../test/e2e/specimens/sql-domains.mjs';

test('specimen domains declare no static schema and target Chronolog v2 topics', () => {
  for (const definition of [checklist(log), intake(log)]) {
    assert.equal(Object.hasOwn(definition, 'schema'), false);
    const initUpdates = definition.commands.initialize.prepare(null);
    assert.equal(Array.isArray(initUpdates), true);
    assert.equal(initUpdates[0].input.kind, 'initialize');
  }
  assert.ok(CHECKLIST_REDUCER.includes("from 'chronolog:sqlite'"));
  assert.ok(INTAKE_REDUCER.includes("from 'chronolog:sqlite'"));
});

test('legacy v1 collective IDs are removed in Chronolog v2', () => {
  assert.equal('APPLICATION_COLLECTIVE_ID' in log, false);
  assert.equal('GROUP_COLLECTIVE_ID' in log, false);
});

test('specimen queries delegate cleanly to topic view.query snapshots', async () => {
  const calls = [];
  const fakeView = {
    async query(topic, input) {
      calls.push([topic, input]);
      if (input?.kind === 'ready') return [[0]];
      if (input?.kind === 'board') return [[1, 'task', null, 0]];
      return [['body', 2]];
    },
  };
  assert.deepEqual(await checklist(log).queries.ready.read(fakeView, null), [[0]]);
  assert.deepEqual(await checklist(log).queries.board.read(fakeView, null), [[1, 'task', null, 0]]);
  assert.deepEqual(await intake(log).queries.answer.read(fakeView, null), [['body', 2]]);
  assert.equal(calls.length, 3);
});
