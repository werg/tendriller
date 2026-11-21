import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSqliteEffectJournal } from '../../session/native.mjs';
import { createEffectDispatcher } from '../local.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'effect-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { path: join(root, 'effects.sqlite'), applicationId: 'test-application', providerId: 'mail-provider' };
}
const command = { effectId: 'notify-review', fence: { generation: 'selected', requestId: 'review', claimVersion: 2 }, input: { subject: 'Review' } };

test('a lost provider receipt is retained independently and reconciles without a second dispatch', async t => {
  const options = await fixture(t); let journal = await createSqliteEffectJournal(options), calls = 0, providerKey;
  t.after(() => journal.close());
  let effects = createEffectDispatcher({ journal, authorize: async () => {}, dispatch: async value => {
    calls++; providerKey = value.idempotencyKey; throw Error('provider accepted but connection was lost');
  } });
  await assert.rejects(effects.execute(command), error => error.code === 'EFFECT_OUTCOME_UNKNOWN');
  assert.equal((await journal.inspect(command.effectId)).status, 'outcomeUnknown');
  assert.equal(providerKey, journal.idempotencyKey(command.effectId));
  assert.equal((await lstat(options.path)).mode & 0o777, 0o600);
  await journal.close(); journal = await createSqliteEffectJournal(options);
  effects = createEffectDispatcher({ journal, authorize: async () => {}, dispatch: async () => { calls++; return {}; } });
  assert.equal((await effects.execute(command)).status, 'outcomeUnknown'); assert.equal(calls, 1);
  effects = createEffectDispatcher({ journal, authorize: async () => {}, dispatch: async () => { calls++; return {}; },
    reconcile: async (id, record) => { assert.equal(id, command.effectId); assert.equal(record.idempotencyKey, providerKey); return { providerReceipt: 'already-sent' }; } });
  assert.equal((await effects.execute(command)).status, 'completed');
  assert.equal((await journal.inspect(command.effectId)).receipt.providerReceipt, 'already-sent');
  assert.equal((await effects.execute(command)).status, 'completed'); assert.equal(calls, 1);
  await assert.rejects(effects.execute({ ...command, fence: { ...command.fence, generation: 'recovered' } }), error => error.code === 'EFFECT_ID_CONFLICT');
  await assert.rejects(effects.execute({ ...command, input: { subject: 'different effect' } }), error => error.code === 'EFFECT_ID_CONFLICT');
  assert.notEqual(providerKey, (await createSqliteEffectJournal({ ...options, path: join(options.path + '.separate', 'effects.sqlite'), applicationId: 'other-app' })
    .then(async other => { try { return other.idempotencyKey(command.effectId); } finally { await other.close(); } })));
});

test('concurrent processes or dispatchers share admission, preserve terminal receipts and reject unsafe storage', async t => {
  const options = await fixture(t), first = await createSqliteEffectJournal({ ...options, maxRecords: 1 }), second = await createSqliteEffectJournal(options);
  t.after(() => Promise.all([first.close(), second.close()]));
  let calls = 0, complete;
  const waiting = new Promise(resolve => { complete = resolve; });
  const a = createEffectDispatcher({ journal: first, authorize: async () => {}, dispatch: async () => { calls++; await waiting; return { sent: true }; } });
  const b = createEffectDispatcher({ journal: second, authorize: async () => {}, dispatch: async () => { calls++; return { sent: true }; } });
  const pending = a.execute(command); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await b.execute(command)).status, 'outcomeUnknown'); assert.equal(calls, 1);
  complete(); assert.equal((await pending).status, 'completed');
  await assert.rejects(first.transact(command.effectId, record => ({ record: { ...record, status: 'outcomeUnknown' }, value: null })), error => error.code === 'EFFECT_RECEIPT_CONFLICT');
  assert.equal((await first.inspect(command.effectId)).status, 'completed');
  await assert.rejects(first.transact('capacity', () => ({ record: { effectId: 'capacity', fence: {}, payload: '{}', status: 'dispatching' }, value: null })), error => error.code === 'EFFECT_JOURNAL_FULL');
  await assert.rejects(first.transact('async-work', async () => ({ record: {}, value: null })), error => error.code === 'EFFECT_JOURNAL_ASYNC_UPDATE');
  assert.equal((await first.list()).records.length, 1);
  await assert.rejects(createSqliteEffectJournal({ ...options, providerId: 'different-provider' }), error => error.code === 'EFFECT_JOURNAL_SCOPE_CHANGED');
  const { DatabaseSync } = await import('node:sqlite'), foreignPath = join(options.path + '.separate', 'application.sqlite');
  const foreign = await createSqliteEffectJournal({ ...options, path: foreignPath }); await foreign.close();
  const db = new DatabaseSync(foreignPath); db.exec('CREATE TABLE application_domain(id TEXT)'); db.close();
  await assert.rejects(createSqliteEffectJournal({ ...options, path: foreignPath }), error => error.code === 'EFFECT_JOURNAL_SEPARATE_STORE_REQUIRED');
});

test('abrupt process loss retains dispatching intent and reopens only for receipt reconciliation', { timeout: 15_000 }, async t => {
  const options = await fixture(t);
  const source = `import {createSqliteEffectJournal} from ${JSON.stringify(new URL('../../session/native.mjs', import.meta.url).href)};
import {createEffectDispatcher} from ${JSON.stringify(new URL('../local.mjs', import.meta.url).href)};
const {options,command}=JSON.parse(process.env.TENDRILLER_EFFECT_TEST);
const journal=await createSqliteEffectJournal(options);
setInterval(()=>{},1000);
await createEffectDispatcher({journal,authorize:async()=>{},dispatch:async()=>{process.stdout.write('dispatching\\n');return new Promise(()=>{});}}).execute(command);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TENDRILLER_EFFECT_TEST: JSON.stringify({ options, command }) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let error = ''; child.stderr.on('data', data => { error += data; });
  const closed = once(child, 'close');
  await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw Error(error); })]);
  child.kill('SIGKILL'); assert.equal((await closed)[1], 'SIGKILL');
  const journal = await createSqliteEffectJournal(options); t.after(() => journal.close());
  assert.equal((await journal.inspect(command.effectId)).status, 'dispatching');
  let sends = 0;
  const effects = createEffectDispatcher({ journal, authorize: async () => {}, dispatch: async () => { sends++; return {}; }, reconcile: async () => ({ providerReceipt: 'recovered-receipt' }) });
  assert.equal((await effects.execute(command)).status, 'completed'); assert.equal(sends, 0);
});
