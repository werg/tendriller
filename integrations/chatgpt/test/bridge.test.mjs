import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeSessionOpener, createSessionBridge } from '../bridge.mjs';
import { createNativeFixture, loadNativePackage } from './native-fixture.mjs';

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

test('selected-history lookup distinguishes absent events and exhausted scan budgets', async () => {
  const f = fixture();
  const detail = await f.bridge.getEvent(id, 'source:0');
  assert.equal(detail.event.payload.question, 'private');
  assert.equal(detail.projection.data.request_id, 'request');
  assert.equal((await f.bridge.verifySource(id, 'source:0', revision)).selected, true);
  assert.equal(await f.bridge.getEvent(id, 'missing:0'), null);
  assert.equal((await f.bridge.verifySource(id, 'missing:0', revision)).selected, false);
  f.session.readView = async () => ({ readEvents: async () => ({ revision, cursor: 'more', events: [], hasMore: true }), release() {} });
  await assert.rejects(f.bridge.getEvent(id, 'source:0', { maxBatches: 1 }), { code: 'BRIDGE_EVENT_SCAN_LIMIT' });
  await f.bridge.close();
});

test('recovery racing projection cannot export excluded captured events', async () => {
  let f;
  f = fixture({ eventProjection: () => {
    f.session.status = { ...f.session.status, generation: 'e'.repeat(64) };
    return { name: 'assistant.help_requested', data: { request_id: 'request' } };
  } });
  await assert.rejects(f.bridge.readEvents(id), { code: 'APPLICATION_VIEW_RECOVERED' });
  assert.equal(f.counts().releases, 1);
  await f.bridge.close();
});

test('observer backpressure follows cursor commit; a recovery notice ends observation until explicit restart', async () => {
  const f = fixture();
  const notice = { generation: 'e'.repeat(64), unknownLoss: true };
  f.session.changes = async function* () {
    yield { kind: 'applied', revision };
    yield { kind: 'recovery', revision: { ...revision, generation: notice.generation }, recovery: notice };
  };
  const iterator = f.bridge.observe(id)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.kind, 'events');
  assert.equal(first.value.cursor, 'cursor-1');
  assert.equal(f.calls.filter(value => value.read).length, 1);
  const next = await iterator.next();
  assert.equal(next.value.kind, 'recovery');
  assert.equal(next.value.previousCursor, 'cursor-1');
  assert.equal(next.value.resetRequired, true);
  assert.equal((await iterator.next()).done, true);
  await f.bridge.close();
});

test('observer resumes stale cursor with recovery evidence, not silent replay', async () => {
  const f = fixture();
  f.session.changes = async function* () { yield { kind: 'applied', revision }; };
  f.session.inspectRecovery = async () => [{ generation, unknownLoss: false }];
  f.session.readView = async () => ({ readEvents: () => { throw Object.assign(Error('APPLICATION_VIEW_RECOVERED'), { revision }); }, release() {} });
  const observed = [];
  for await (const value of f.bridge.observe(id, { cursor: 'stale' })) observed.push(value);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].kind, 'recovery');
  assert.equal(observed[0].previousCursor, 'stale');
  assert.equal(observed[0].recovery.unknownLoss, false);
  await f.bridge.close();
});

test('native opener resumes the existing device and composes maintained participation ports', async () => {
  const f = fixture(), calls = [], descriptor = { payload: { applicationId: id } };
  const host = { peers: { application: () => f.control.application(), exchange: async message => message } };
  const device = { close: async () => calls.push('device-closed') };
  f.session.connectControlParticipant = input => { calls.push(input); return f.control; };
  f.session.participate = async input => { calls.push(input); };
  const opener = createNativeSessionOpener({ host, definition: {}, devicePath: '/private/existing.sqlite', pinnedDescriptor: descriptor,
    loadModules: async () => ({
      peer: { verifyAuthorityBundle: async (authority, pin) => { assert.deepEqual(pin, descriptor); assert.equal(authority.descriptor.payload.applicationId, id); } },
      native: { openNativeDevice: async input => { calls.push(input); return device; },
        openNativeApplication: async input => { assert.equal(input.device, device); return f.session; } },
      peers: { createPeerIntroductions: input => { calls.push(input); return { discovery: {}, transport: {} }; } },
      websocket: { openWebSocketConnection: async (relay, options) => ({ relay, options }) },
    }),
  });
  const owned = await opener();
  assert.equal(owned.session, f.session);
  assert.deepEqual(calls[0], { path: '/private/existing.sqlite' });
  const introductions = calls.find(value => value.identity === deviceId);
  await assert.rejects(introductions.openDirectConnection(), { code: 'BRIDGE_NATIVE_RTC_NOT_CONFIGURED' });
  const relay = { ready: Promise.resolve() };
  const connection = await introductions.openRelayConnection({ relay });
  assert.equal(connection.relay, relay);
  assert.equal(calls.some(value => value.control === f.control && value.discovery && value.transport), true);
  await owned.session.close();
});

// Run against the exact, independently packed public artifact, not source-private
// modules. Its optional path is explicit because this repository does not vendor
// a native session package or pretend the prerelease is available from npm.
test('real native peers preserve signed attempts across bridge restart and selected-history recovery',
  { skip: !process.env.CHRONOLOG_SESSION_PACKAGE, timeout: 30000 }, async () => {
    const { peer } = await loadNativePackage();
      const definition = peer.defineApplication({ id: 'bridge-test', version: '1', commands: {
        say: peer.defineCommand({ description: 'Retain a test request', input: { type: 'string', minLength: 1, maxLength: 128 },
          prepare: message => peer.program(peer.emit('assistant', { type: 'help.requested', question: message })) }),
      }, queries: {
        messages: peer.defineQuery({ description: 'Read selected assistance facts', input: { type: 'null' },
          read: view => view.readEvents({ topics: ['assistant'] }).events }),
      } });
    const fixture = await createNativeFixture(definition);
    const { open, select, registry, devices } = fixture;
    const cleanup = [];
    try {
      let a = await open(0); const b = await open(1);
      const buildBridge = () => createSessionBridge({ applications: [{ id, openSession: async () => a,
        allowedQueries: ['messages'], allowedCommands: ['say'], eventTopics: ['assistant'],
        eventProjection: event => ({ name: 'assistant.help_requested', data: { request_id: event.operationId } }),
      }] });
      let bridge = buildBridge(); cleanup.push(() => bridge.close());
      const link = await peer.connectApplications(a.session, b.session); cleanup.push(() => link.close());
      await bridge.command(id, 'say', 'retained request', { operationId: 'once' });
      await a.session.operations.wait('once', { signal: AbortSignal.timeout(5000) });
      await link.synchronize();
      const first = await bridge.query(id, 'messages', null);
      assert.equal(first.value.length, 1);
      assert.equal(first.value[0].author, a.session.deviceId);
      const saved = await a.session.operations.inspect('once');
      await bridge.command(id, 'say', 'retained request', { operationId: 'once' });
      assert.deepEqual((await a.session.operations.inspect('once')).attempt, saved.attempt);
      assert.equal((await bridge.query(id, 'messages', null)).value.length, 1);
      assert.equal((await b.session.query('messages', null)).value[0].operationId, 'once');
      await link.close();
      await bridge.close();
      a = await open(0, true); bridge = buildBridge();
      assert.equal((await bridge.query(id, 'messages', null)).value.length, 1);
      assert.deepEqual((await a.session.operations.inspect('once')).attempt, saved.attempt);
      const base = await b.session.recoveryPoint();
      await bridge.command(id, 'say', 'excluded tail', { operationId: 'tail' });
      await a.session.operations.wait('tail', { signal: AbortSignal.timeout(5000) });
      const before = await bridge.readEvents(id), tail = before.events.find(event => event.sourceOperationId === 'tail');
      assert(tail);
      await select(devices[1], base, 'recover');
      await b.session.adopt(await registry.read());
      const recoveredLink = await peer.connectApplications(a.session, b.session); cleanup.push(() => recoveredLink.close());
      await recoveredLink.synchronize();
      assert.equal((await bridge.verifySource(id, tail.sourceEventId, before.revision)).selected, false);
      assert.equal(await bridge.getEvent(id, tail.sourceEventId), null);
      assert.equal((await bridge.operation(id, 'tail')).status, 'abandoned');
      assert.equal((await bridge.verifySource(id, first.value[0].id, first.revision)).selected, true);
      await assert.rejects(bridge.readEvents(id, { cursor: before.cursor }), /APPLICATION_VIEW_RECOVERED/);
      assert.equal((await bridge.query(id, 'messages', null)).value.length, 1);
    } finally {
      for (const close of cleanup.reverse()) await close();
      await fixture.close();
    }
  });
