import assert from 'node:assert/strict';
import test from 'node:test';
import { watchApplicationSetup, validateSetupNotice } from '../setup-watch.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const ready = { type: 'setup', version: 1, assistant: { proposalId: null, approved: false, revision: null } };
function socket() {
  const ws = new EventTarget(); ws.readyState = 0;
  ws.close = (code = 1000) => { ws.readyState = 3; ws.dispatchEvent(Object.assign(new Event('close'), { code })); };
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
