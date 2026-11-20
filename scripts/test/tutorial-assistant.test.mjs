import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tutorial-assistant-'));
  for (const name of ['assistant.mjs', 'session.mjs', 'local.mjs', 'domain.mjs']) await copyFile(join(root, 'docs/tutorial', name), join(directory, name));
  for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session']]) {
    await mkdir(join(directory, 'node_modules', scope), { recursive: true });
    await symlink(resolve(root, source), join(directory, 'node_modules', scope, name));
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, module: await import(pathToFileURL(join(directory, 'assistant.mjs')).href) };
}

test('assistant preparation retains one private key and event permissions are opt-in', async t => {
  const { directory, module } = await fixture(t), calls = [], original = globalThis.fetch;
  await mkdir(join(directory, '.tendriller'), { mode: 0o700 });
  await writeFile(join(directory, '.tendriller/handle.json'), JSON.stringify({ api: 'https://staging.example.test/api/t/aaaaaaaaaaaa',
    token: 'test-only-token', application: { id: 'a'.repeat(64) } }), { mode: 0o600 });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json({ reviewUrl: 'https://staging.example.test/connections/aaaaaaaaaaaa' });
  };
  t.after(() => { globalThis.fetch = original; });
  await module.prepareAssistant();
  const key = await readFile(join(directory, '.tendriller/assistant-key.json'), 'utf8');
  await module.prepareAssistant();
  await module.prepareAssistant({ events: true });
  assert.deepEqual(calls[0].body.events, []);
  assert.deepEqual(calls[0].body.queries, ['notes']);
  assert.deepEqual(calls[0].body.commands, ['addNote']);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[2].body.events[0].name, 'note.added');
  assert.deepEqual(calls[2].body.adapterHashes, calls[0].body.adapterHashes);
  assert.equal(await readFile(join(directory, '.tendriller/assistant-key.json'), 'utf8'), key);
  assert.equal((await stat(join(directory, '.tendriller/assistant-key.json'))).mode & 0o777, 0o600);
});

function runtime({ events = false, failConnect = false, failClose = false } = {}) {
  const calls = [], reports = [], closed = Promise.withResolvers();
  const session = { applicationId: 'a'.repeat(64) };
  const dependencies = {
    prepare: async options => { assert.equal(options.events, events); return { options: { api: 'https://staging.example.test/api/t/aaaaaaaaaaaa' }, review: { reviewUrl: 'https://staging.example.test/review' } }; },
    open: async () => ({ session, close: async () => { calls.push('owner_closed'); } }),
    tools: value => { assert.equal(value, session); return {}; },
    connect: () => {
      if (failConnect) throw Object.assign(Error('approval unavailable'), { code: 'APPROVAL_UNAVAILABLE' });
      return { closed: closed.promise,
        waitUntilOnline: async () => { calls.push('online'); if (!events) setImmediate(() => closed.resolve()); },
        close: async () => { calls.push('adapter_closed'); closed.resolve(); if (failClose) throw Error('adapter cleanup failed'); } };
    },
    forward: async () => { calls.push('events_forwarded'); },
    report: value => { reports.push(value); },
  };
  return { dependencies, calls, reports };
}

test('ordinary assistant connection reports observed states without forwarding events or promising wake', async t => {
  const { module } = await fixture(t), { dependencies, calls, reports } = runtime();
  await module.runAssistant({}, dependencies);
  assert.deepEqual(calls, ['online', 'adapter_closed', 'owner_closed']);
  assert.deepEqual(reports.map(value => value.state), ['proposal_prepared', 'participant_running', 'adapter_online', 'stopped']);
  assert.equal(reports[0].connected, false);
  assert.equal(reports[1].futureWakeVerified, false);
  assert.equal(reports[2].roundTripVerified, false);
  assert.equal(reports[3].connected, false);
});

test('requested event forwarding shares one owner and closes it even if adapter cleanup fails', async t => {
  const { module } = await fixture(t), { dependencies, calls } = runtime({ events: true, failClose: true });
  await assert.rejects(module.runAssistant({ events: true }, dependencies), { name: 'AggregateError', message: 'Assistant participant cleanup failed' });
  assert.deepEqual(calls, ['online', 'events_forwarded', 'adapter_closed', 'owner_closed']);
});

test('failed connection closes the owned supervisor without reporting online', async t => {
  const { module } = await fixture(t), { dependencies, calls, reports } = runtime({ failConnect: true });
  await assert.rejects(module.runAssistant({}, dependencies), { code: 'APPROVAL_UNAVAILABLE' });
  assert.deepEqual(calls, ['owner_closed']);
  assert.equal(reports.some(value => value.state === 'adapter_online'), false);
  assert.equal(reports.at(-1).state, 'stopped');
});
