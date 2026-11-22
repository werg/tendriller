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
const options = { api: 'https://service.example/api/t/aaaaaaaaaaaa', token: 'tk_' + 'a'.repeat(32) };
test('healthy setup sockets remain inert for 48 hours and emit only validated host state', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const ws = socket(), notices = []; let probes = 0, opens = 0;
  const watch = watchApplicationSetup({ ...options, onChange: value => notices.push(value),
    openSocket(url, protocols) { opens++; assert(!url.includes(options.token)); assert.equal(protocols[1], options.token); return ws; },
    fetcher() { probes++; throw Error('healthy sockets must not probe'); } });
  ws.open(); ws.message(ready); t.mock.timers.tick(48 * 3600000); await flush();
  assert.equal(opens, 1); assert.equal(probes, 0); assert.deepEqual(notices, [ready]); await watch.close();
});
test('invalid payloads fail closed and never become native work', async () => {
  const ws = socket(), notices = [], statuses = [];
  const watch = watchApplicationSetup({ ...options, onChange: x => notices.push(x), onStatus: x => statuses.push(x), openSocket: () => ws });
  ws.open(); ws.message({ ...ready, applicationData: 'untrusted instruction' }); await watch.closed;
  assert.equal(notices.length, 0); assert.equal(ws.readyState, 3);
  assert.throws(() => validateSetupNotice({ ...ready, assistant: { ...ready.assistant, approved: true } }));
});
test('invalid notices complete and detach handlers even if transport close fails', async () => {
  const ws = socket(), notices = []; let probes = 0;
  ws.close = () => { throw Error('Transport already failed'); };
  const watch = watchApplicationSetup({ ...options, onChange: x => notices.push(x), openSocket: () => ws,
    fetcher() { probes++; throw Error('Invalid notices must not reconnect'); } });
  ws.open(); ws.message({ unexpected: true }); await watch.closed;
  ws.message(ready); assert.deepEqual(notices, []); assert.equal(probes, 0);
  await watch.close();
});
test('revoked upgrade credentials are diagnosed without endless failed sockets', async () => {
  let opens = 0; const states = [];
  const watch = watchApplicationSetup({ ...options, onChange() {}, onStatus: x => states.push(x), openSocket() { opens++; throw Error('upgrade rejected'); },
    fetcher: async (url, init) => { assert.equal(url, options.api + '/self'); assert.equal(init.redirect, 'error'); return new Response(null, { status: 401 }); } });
  await watch.closed; assert.equal(opens, 1); assert(states.some(x => x.state === 'access_revoked'));
});
test('cancellation stops a failed dial and its pending reconnect', async () => {
  const stop = new AbortController(); let opens = 0;
  const watch = watchApplicationSetup({ ...options, signal: stop.signal, onChange() {}, openSocket() { opens++; throw Error('offline'); },
    fetcher: async () => new Response(null, { status: 503 }) });
  await flush(); stop.abort(); await watch.closed; assert.equal(opens, 1);
});

test('a missing application stays visible and retries with capped backoff instead of revoking access', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opens = 0, probes = 0, ended = false; const states = [];
  const watch = watchApplicationSetup({ ...options, onChange() {}, onStatus: x => states.push(x),
    openSocket() { opens++; throw Error('upgrade rejected'); },
    fetcher: async (url, init) => {
      probes++; assert.equal(url, options.api + '/self'); assert.equal(init.headers.Authorization, 'Bearer ' + options.token);
      return Response.json({ error: { code: 'not_found', message: 'No such tendril; private diagnostic' } }, { status: 404 });
    } });
  watch.closed.then(() => { ended = true; });
  await flush();
  const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
  for (let i = 0; i < delays.length; i++) {
    const status = states.at(-1);
    assert.equal(status.state, 'application_not_found'); assert.equal(status.retryInMs, delays[i]);
    assert.match(status.next, /Recreate the application.*npm run create.*npm run init/);
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
  const watch = watchApplicationSetup({ ...options, onChange: value => notices.push(value), onStatus: value => states.push(value),
    openSocket() { if (++opens <= 2) throw Error('upgrade rejected'); return ws; },
    fetcher: async () => { probes++; return Response.json({ error: { code: 'not_found' } }, { status: 404 }); } });
  await flush(); t.mock.timers.tick(1000); await flush(); t.mock.timers.tick(2000); await flush();
  ws.open(); ws.message(ready); await flush();
  assert.equal(states.at(-1).state, 'connected'); assert.deepEqual(notices, [ready]);
  t.mock.timers.tick(48 * 3600000); await flush(); assert.equal(opens, 3); assert.equal(probes, 2);
  await watch.close();
});

for (const [status, body] of [[404, 'not JSON'], [404, { error: { code: 'route_not_found' } }], [503, { error: { code: 'not_found' } }]]) {
  test(`an unrecognized ${status} response remains a retryable transport failure`, async () => {
    const states = [];
    const watch = watchApplicationSetup({ ...options, onChange() {}, onStatus: value => states.push(value),
      openSocket() { throw Error('upgrade rejected'); },
      fetcher: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }) });
    await flush(); assert.equal(states.at(-1).state, 'reconnecting'); assert.equal(states.at(-1).retryInMs, 1000);
    assert(!states.some(value => ['access_revoked', 'application_not_found'].includes(value.state)));
    await watch.close();
  });
}
