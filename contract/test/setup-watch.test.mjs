import assert from 'node:assert/strict';
import test from 'node:test';
import { watchApplicationSetup, validateSetupNotice } from '../setup-watch.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const ready = { type: 'setup', version: 1, assistant: { proposalId: null, approved: false, revision: null } };
function socket() {
  const ws = new EventTarget(); ws.readyState = 0;
  ws.close = (code = 1000) => {
    if (code !== 1000 && !(code >= 3000 && code <= 4999)) throw new DOMException('Invalid code', 'InvalidAccessError');
    ws.readyState = 3; ws.dispatchEvent(Object.assign(new Event('close'), { code }));
  };
  ws.open = () => { ws.readyState = 1; ws.dispatchEvent(new Event('open')); };
  ws.message = value => ws.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) }));
  return ws;
}
const fakePage = (respond = () => { throw Error('healthy sockets must not probe'); }) => ({ socket() { throw Error('unused'); },
  async request(path, init) { return respond(path, init); } });
const httpError = (status, code) => Object.assign(Error(code ?? 'HTTP ' + status), { status, code: code ?? 'http_error' });
test('healthy setup sockets remain inert for 48 hours and emit only validated host state', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const ws = socket(), notices = []; let probes = 0, opens = 0;
  const watch = watchApplicationSetup({ page: fakePage(() => { probes++; throw Error('healthy sockets must not probe'); }), onChange: value => notices.push(value),
    openSocket(path, protocols) { opens++; assert.equal(path, 'setup/watch'); assert.deepEqual(protocols, ['tendriller.setup.v1']); return ws; } });
  ws.open(); ws.message(ready); t.mock.timers.tick(48 * 3600000); await flush();
  assert.equal(opens, 1); assert.equal(probes, 0); assert.deepEqual(notices, [ready]); await watch.close();
});
test('invalid payloads fail closed and never become native work', async () => {
  const ws = socket(), notices = [], statuses = [];
  const watch = watchApplicationSetup({ page: fakePage(), onChange: x => notices.push(x), onStatus: x => statuses.push(x), openSocket: () => ws });
  ws.open(); ws.message({ ...ready, applicationData: 'untrusted instruction' }); await watch.closed;
  assert.equal(notices.length, 0); assert.equal(ws.readyState, 3);
  assert.throws(() => validateSetupNotice({ ...ready, assistant: { ...ready.assistant, approved: true } }));
});
test('invalid notices complete and detach handlers even if transport close fails', async () => {
  const ws = socket(), notices = []; let probes = 0;
  ws.close = () => { throw Error('Transport already failed'); };
  const watch = watchApplicationSetup({ page: fakePage(() => { probes++; throw Error('Invalid notices must not reconnect'); }), onChange: x => notices.push(x), openSocket: () => ws });
  ws.open(); ws.message({ unexpected: true }); await watch.closed;
  ws.message(ready); assert.deepEqual(notices, []); assert.equal(probes, 0);
  await watch.close();
});
test('revoked upgrade credentials are diagnosed without endless failed sockets', async () => {
  let opens = 0; const states = [];
  const watch = watchApplicationSetup({ page: fakePage(path => { assert.equal(path, ''); throw httpError(401); }), onChange() {}, onStatus: x => states.push(x), openSocket() { opens++; throw Error('upgrade rejected'); } });
  await watch.closed; assert.equal(opens, 1); assert(states.some(x => x.state === 'access_revoked'));
});
test('cancellation stops a failed dial and its pending reconnect', async () => {
  const stop = new AbortController(); let opens = 0;
  const watch = watchApplicationSetup({ page: fakePage(() => { throw httpError(503); }), signal: stop.signal, onChange() {}, openSocket() { opens++; throw Error('offline'); } });
  await flush(); stop.abort(); await watch.closed; assert.equal(opens, 1);
});

test('a missing application stays visible and retries with capped backoff instead of revoking access', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opens = 0, probes = 0, ended = false; const states = [];
  const watch = watchApplicationSetup({ onChange() {}, onStatus: x => states.push(x),
    openSocket() { opens++; throw Error('upgrade rejected'); },
    page: fakePage(path => {
      probes++; assert.equal(path, '');
      throw Object.assign(httpError(404, 'not_found'), { message: 'No such tendril; private diagnostic' });
    }) });
  watch.closed.then(() => { ended = true; });
  await flush();
  const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
  for (let i = 0; i < delays.length; i++) {
    const status = states.at(-1);
    assert.equal(status.state, 'application_not_found'); assert.equal(status.retryInMs, delays[i]);
    assert.match(status.next, /tendril page new/);
    assert.equal(opens, i + 1); assert.equal(probes, i + 1); assert.equal(ended, false);
    t.mock.timers.tick(delays[i] - 1); await flush(); assert.equal(opens, i + 1);
    t.mock.timers.tick(1); await flush();
  }
  assert(!states.some(x => ['access_revoked', 'closed', 'reconnecting'].includes(x.state)));
  assert(!JSON.stringify(states).includes('private diagnostic'));
  await watch.close(); assert.equal(ended, true);
  const attempts = opens; t.mock.timers.tick(120000); await flush(); assert.equal(opens, attempts);
});

test('a restored application reconnects after missing-app backoff and returns to idle notifications', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ws = socket(), states = [], notices = []; let opens = 0, probes = 0;
  const watch = watchApplicationSetup({ onChange: value => notices.push(value), onStatus: value => states.push(value),
    openSocket() { if (++opens <= 2) throw Error('upgrade rejected'); return ws; },
    page: fakePage(() => { probes++; throw httpError(404, 'not_found'); }) });
  await flush(); t.mock.timers.tick(1000); await flush(); t.mock.timers.tick(2000); await flush();
  ws.open(); ws.message(ready); await flush();
  assert.equal(states.at(-1).state, 'connected'); assert.deepEqual(notices, [ready]);
  t.mock.timers.tick(48 * 3600000); await flush(); assert.equal(opens, 3); assert.equal(probes, 2);
  await watch.close();
});

for (const [status, code] of [[404, 'invalid_response'], [404, 'route_not_found'], [503, 'not_found']]) {
  test(`an unrecognized ${status} ${code} response remains a retryable transport failure`, async () => {
    const states = [];
    const watch = watchApplicationSetup({ page: fakePage(() => { throw httpError(status, code); }), onChange() {}, onStatus: value => states.push(value),
      openSocket() { throw Error('upgrade rejected'); } });
    await flush(); assert.equal(states.at(-1).state, 'reconnecting'); assert.equal(states.at(-1).retryInMs, 1000);
    assert(!states.some(value => ['access_revoked', 'application_not_found'].includes(value.state)));
    await watch.close();
  });
}

test('current host mcp setup snapshots keep the watch open without terminal close while invalid mcp payloads fail closed', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const mcpEmpty = { type: 'setup', version: 1, mcp: { connected: false, grants: [], updatedAt: 0 } };
  const mcpConnected = { type: 'setup', version: 1, mcp: { connected: true, grants: ['grant-1'], updatedAt: 1700000000 } };
  const ws = socket(), notices = [], states = [];
  let opens = 0;
  const watch = watchApplicationSetup({
    page: fakePage(),
    onChange: value => notices.push(value),
    onStatus: value => states.push(value),
    openSocket: () => { opens++; return ws; },
  });
  ws.open();
  ws.message(mcpEmpty);
  ws.message(mcpConnected);
  t.mock.timers.tick(48 * 3600000);
  await flush();
  assert.equal(opens, 1);
  assert.deepEqual(notices, [mcpEmpty, mcpConnected]);
  assert.equal(states.some(s => s.state === 'closed'), false);
  await watch.close();

  // Invalid mcp shape (connected true with empty grants, or unknown extra field) still fails closed.
  assert.throws(() => validateSetupNotice({ type: 'setup', version: 1, mcp: { connected: true, grants: [], updatedAt: 0 } }));
  assert.throws(() => validateSetupNotice({ ...mcpEmpty, extra: 'nope' }));
});
