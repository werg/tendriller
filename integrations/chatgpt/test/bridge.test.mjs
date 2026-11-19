import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionBridge } from '../bridge.mjs';

const id = 'a'.repeat(64), deviceId = 'b'.repeat(64), generation = 'c'.repeat(64);
const revision = { applicationId: id, historyId: 'bridge-test', generation,
  controlRevision: 0, materializationRevision: '0', point: { generation, sequence: 0, root: 'd'.repeat(64) } };
function fixture(options = {}) {
  const calls = [], grant = { publicKey: deviceId, reader: true, writer: true };
  let closed = 0, releases = 0, opens = 0;
  const states = new Map();
  const session = {
    applicationId: id, historyId: revision.historyId, deviceId,
    status: { phase: 'ready', database: 'ready', generation, connectedPeers: 1 },
    describe: () => ({ id: 'test', version: '1', capabilities: {},
      commands: [{ name: 'say', input: { type: 'string' } }, { name: 'danger', input: { type: 'string' } }],
      queries: [{ name: 'messages', input: { type: 'null' } }, { name: 'private', input: { type: 'null' } }] }),
    async query(name, input) { calls.push({ query: name, input }); return { revision, value: ['hello'] }; },
    async command(name, input, metadata) {
      calls.push({ command: name, input, metadata });
      const old = states.get(metadata.operationId);
      if (old && old.input !== input) throw Error('OPERATION_CONFLICT');
      states.set(metadata.operationId, { status: 'saved', operationId: metadata.operationId, input });
      return { get: async () => states.get(metadata.operationId) };
    },
    operations: { get: async operationId => states.get(operationId) ?? null },
    async readView() { return { revision,
      readEvents: async input => {
        calls.push({ read: input });
        return { revision, cursor: 'cursor-1', hasMore: false, events: [{ id: 'source:0',
          operationId: 'request', attemptId: 'attempt', author: deviceId, topic: 'assistant', payload: { question: 'private' } }] };
      }, release: async () => { releases++; } }; },
    async close() { closed++; },
  };
  const control = { async application() { calls.push({ authorization: true }); return {
    descriptor: { payload: { applicationId: id } }, controls: [{ payload: { grants: [grant] } }],
  }; } };
  const bridge = createSessionBridge({ applications: [{ id, label: 'Kitchen',
    openSession: async () => { opens++; return { session, control }; }, allowedCommands: ['say'], allowedQueries: ['messages'],
    eventTopics: ['assistant'], eventProjection: () => ({ name: 'assistant.help_requested', data: { request_id: 'request' } }), ...options }] });
  return { bridge, session, control, grant, calls, counts: () => ({ closed, releases, opens }) };
}

test('configured listing is inert; declared tools and commands require narrow allowlists', async () => {
  const f = fixture();
  assert.deepEqual(f.bridge.listApplications(), [{ id, label: 'Kitchen' }]);
  assert.equal(f.counts().opens, 0);
  const described = await f.bridge.describeApplication(id);
  assert.deepEqual(described.commands.map(value => value.name), ['say']);
  assert.deepEqual(described.queries.map(value => value.name), ['messages']);
  await assert.rejects(f.bridge.command(id, 'danger', 'bad', { operationId: 'bad' }), { code: 'BRIDGE_OPERATION_FORBIDDEN' });
  await assert.rejects(f.bridge.query(id, 'private', null), { code: 'BRIDGE_OPERATION_FORBIDDEN' });
  await assert.rejects(f.bridge.query('0'.repeat(64), 'messages', null), { code: 'BRIDGE_APPLICATION_UNAVAILABLE' });
  assert.equal(f.calls.some(value => value.command), false);
  await f.bridge.close(); await f.bridge.close();
  assert.deepEqual(f.counts(), { closed: 1, releases: 0, opens: 1 });
});

test('each access refreshes native authority; revocation and unavailable control fail closed', async () => {
  const f = fixture();
  assert.deepEqual((await f.bridge.query(id, 'messages', null)).value, ['hello']);
  f.grant.reader = false;
  await assert.rejects(f.bridge.query(id, 'messages', null), { code: 'BRIDGE_GRANT_REQUIRED' });
  f.grant.reader = true; f.grant.writer = false;
  await assert.rejects(f.bridge.command(id, 'say', 'hello', { operationId: 'once' }), { code: 'BRIDGE_GRANT_REQUIRED' });
  f.control.application = async () => { throw Error('CONTROL_UNAVAILABLE'); };
  await assert.rejects(f.bridge.query(id, 'messages', null), /CONTROL_UNAVAILABLE/);
  assert.equal(f.calls.filter(value => value.query).length, 1);
  await f.bridge.close();
});

test('command passes original retry identity and native revision unchanged, returning saved state', async () => {
  const f = fixture();
  const result = await f.bridge.command(id, 'say', 'hello', { operationId: 'once', basedOn: revision });
  assert.equal(result.status, 'saved');
  await f.bridge.command(id, 'say', 'hello', { operationId: 'once', basedOn: revision });
  assert.deepEqual(f.calls.filter(value => value.command).map(value => value.metadata), [
    { operationId: 'once', basedOn: revision }, { operationId: 'once', basedOn: revision },
  ]);
  await assert.rejects(f.bridge.command(id, 'say', 'different', { operationId: 'once' }), /OPERATION_CONFLICT/);
  await assert.rejects(f.bridge.command(id, 'say', 'hello', { operationId: 'other', basedOn: { ...revision, applicationId: '0'.repeat(64) } }), { code: 'BRIDGE_REVISION_SCOPE_MISMATCH' });
  assert.equal((await f.bridge.operation(id, 'once')).operationId, 'once');
  await f.bridge.close();
});

test('events use coherent native views, projected egress and immutable native provenance', async () => {
  const f = fixture();
  const batch = await f.bridge.readEvents(id);
  assert.equal(batch.cursor, 'cursor-1');
  assert.deepEqual(batch.events[0], { name: 'assistant.help_requested', data: { request_id: 'request' },
    sourceEventId: 'source:0', sourceOperationId: 'request', sourceAuthor: deviceId, sourceAttemptId: 'attempt', revision });
  assert.equal(JSON.stringify(batch).includes('private'), false);
  assert.equal(f.counts().releases, 1);
  assert.deepEqual(f.calls.find(value => value.read).read, { topics: ['assistant'], limit: 128 });
  await f.bridge.close();
});

test('views release after projection failure, oversized egress and recovery; recovery never silently rewinds', async () => {
  for (const eventProjection of [() => { throw Error('PROJECT_FAILED'); },
    () => ({ name: 'assistant.help_requested', data: { huge: 'x'.repeat(20000) } })]) {
    const f = fixture({ eventProjection });
    await assert.rejects(f.bridge.readEvents(id));
    assert.equal(f.counts().releases, 1);
    await f.bridge.close();
  }
  const f = fixture();
  let released = false;
  f.session.readView = async () => ({ readEvents: () => { throw Object.assign(Error('APPLICATION_VIEW_RECOVERED'), { revision }); }, release: () => { released = true; } });
  await assert.rejects(f.bridge.readEvents(id, { cursor: 'old' }), /APPLICATION_VIEW_RECOVERED/);
  assert.equal(released, true);
  await f.bridge.close();
});
