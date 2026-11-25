import assert from 'node:assert/strict';
import test from 'node:test';
import * as log from '@chronolog/peer-session';
import { checklist, intake } from '../../test/e2e/specimens/sql-domains.mjs';

// The SQL specimen domains are authored-time CRDT domains: the schema is an ordinary authorized `initialize`
// transaction, never definition metadata, and every table read tolerates a device that has not yet received it.
const sqlOf = program => program.steps.filter(step => typeof step.sql === 'string').map(step => step.sql);
const rows = (tables, answers) => ({ async query(sql, parameters = []) {
  if (sql.includes('sqlite_master') && sql.includes('name=?')) return { rows: tables.has(parameters[0]) ? [[1]] : [] };
  if (sql.includes('count(*) FROM sqlite_master')) return { rows: [[tables.size]] };
  return { rows: answers(sql, parameters) };
} });

test('specimen domains declare no schema and create tables only through the ordinary initialize command', () => {
  for (const definition of [checklist(log), intake(log, 'a'.repeat(64))]) {
    assert.equal(Object.hasOwn(definition, 'schema'), false);
    const initialize = definition.commands.initialize.prepare(null);
    assert.ok(sqlOf(initialize).every(sql => sql.startsWith('CREATE TABLE')), 'initialize is DDL only');
    assert.ok(sqlOf(initialize).length >= 1);
    for (const [name, command] of Object.entries(definition.commands))
      if (name !== 'initialize') assert.ok(!sqlOf(command.prepare(name === 'add' ? { id: 1, title: 't' } : name === 'submit' ? { body: 'b', revision: 0 } : name === 'reserve' || name === 'cancel' ? 'slot' : 1))
        .some(sql => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql)), `${name} never changes the schema`);
  }
});

test('collective-owned rows use the current group collective, not a removed application collective', () => {
  assert.equal('APPLICATION_COLLECTIVE_ID' in log, false);
  const group = log.bytesToHex(log.GROUP_COLLECTIVE_ID);
  const add = sqlOf(checklist(log).commands.add.prepare({ id: 1, title: 'task' })).join(' ');
  assert.ok(add.includes(`X'${group}'`) && add.includes('chronolog_owner'));
});

test('queries derive empty views before initialize arrives and rows after, and SQL readiness needs no table', async () => {
  const board = checklist(log).queries.board, ready = checklist(log).queries.ready, answer = intake(log, 'a'.repeat(64)).queries.answer;
  assert.deepEqual(await board.read(rows(new Set(), () => assert.fail('no application table exists yet')), null), []);
  assert.deepEqual(await board.read(rows(new Set(['tasks']), () => [[1, 'task', null, 0]]), null), [[1, 'task', null, 0]]);
  assert.deepEqual(await ready.read(rows(new Set(), () => []), null), [[0]], 'engine qualification before initialize');
  assert.deepEqual(await answer.read(rows(new Set(), () => assert.fail('no answer table yet')), null), []);
  assert.deepEqual(await answer.read(rows(new Set(['answer']), () => [['body', 2]]), null), [['body', 2]]);
});
