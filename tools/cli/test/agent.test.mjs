import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent } from '../lib/agent.mjs';

const PAGE = 'aaaaaaaaaaaa';

function fixture({ removed = false, admit = () => { throw Object.assign(Error('admission refused'), { code: 'SUPERVISOR_PAGE_EXISTS' }); } } = {}) {
  const events = [], reports = [], stop = new AbortController();
  const sessionStop = new AbortController();
  const owner = { session: { signal: sessionStop.signal, describe: () => ({ id: 'fixture', version: '1' }), onStatus: () => () => {},
    async *changes() { await new Promise(resolve => sessionStop.signal.addEventListener('abort', resolve, { once: true })); } },
    async close() { events.push('owner-closed'); sessionStop.abort(); } };
  const supervisor = { socketPath: '/tmp/fixture.sock',
    addPage: async (id, value) => { events.push(['addPage', id, value === owner]); return admit(); },
    removePage: async id => { events.push(['removePage', id]); return removed; },
    close: async () => { events.push('supervisor-closed'); } };
  const hub = { events: () => () => {}, onStatus: () => () => {}, connect() {}, close() { events.push('hub-closed'); } };
  const client = { hub, pages: { all: async function* () { yield { id: PAGE }; } }, close() {} };
  const workspace = { root: '/w', paths: { owner: '/tmp/fixture-owner', pages: '/nonexistent-pages' }, config: { agent: { id: 'ag_fixture' } },
    client: async () => client, attachBinding: async () => ({ id: 'terminal', token: 'td_n_' + 'a'.repeat(64) }),
    pages: async () => [{ id: PAGE, slug: 'notes', initialized: true, module: true }],
    pageContext: async () => ({}), pageModule: async () => ({ openPage: async () => owner }) };
  const running = runAgent(workspace, { signal: stop.signal, report: value => reports.push(value), openOwnerSupervisor: async () => supervisor });
  return { events, reports, stop, running, owner };
}
const until = async (predicate, label) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(label); };

test('a page whose supervisor admission fails closes the owner it opened when removePage finds nothing to remove', async () => {
  const f = fixture({ removed: false });
  await until(() => f.reports.some(value => value.state === 'page_failed'), 'the failed admission is reported');
  assert.equal(f.reports.find(value => value.state === 'page_failed').code, 'SUPERVISOR_PAGE_EXISTS');
  assert.deepEqual(f.events.filter(value => Array.isArray(value)), [['addPage', PAGE, true], ['removePage', PAGE]]);
  assert.equal(f.events.filter(value => value === 'owner-closed').length, 1, 'the opened owner is closed exactly once, never leaked');
  f.stop.abort(); await f.running;
  assert.equal(f.events.filter(value => value === 'owner-closed').length, 1);
  assert(f.events.includes('supervisor-closed') && f.events.includes('hub-closed'));
});

test('when the supervisor already removed the failed page it owns the close, so the agent does not close the owner twice', async () => {
  const f = fixture({ removed: true });
  await until(() => f.reports.some(value => value.state === 'page_failed'), 'the failed admission is reported');
  assert.equal(f.events.filter(value => value === 'owner-closed').length, 0);
  f.stop.abort(); await f.running;
});
