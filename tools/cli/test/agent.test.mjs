import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// A real temporary private root and real recursive file watching: registering a page or writing its explicit
// provisioning marker must be discovered by the running agent program without a restart, and nothing is opened
// (no device, page context or module) until the page is explicitly provisioned.
test('the agent discovers a newly registered page and its later provisioning marker without a restart, then disposes its watch', async t => {
  const secret = await mkdtemp(join(tmpdir(), 'agent-watch-')), sessionStop = new AbortController();
  t.after(() => rm(secret, { recursive: true, force: true }));
  const registered = [], reports = [], opened = [], calls = { pages: 0, contexts: 0, modules: 0, addPage: [] }, stop = new AbortController();
  const pageDirectory = id => join(secret, 'pages', id);
  const owner = { session: { signal: sessionStop.signal, definition: { id: 'fixture', version: '1' }, onStatus: () => () => {},
    async *changes() { await new Promise(resolve => sessionStop.signal.addEventListener('abort', resolve, { once: true })); } },
  async close() { opened.push('owner-closed'); sessionStop.abort(); } };
  const supervisor = { socketPath: '/tmp/fixture.sock', addPage: async id => { calls.addPage.push(id); return { publicKey: 'b'.repeat(64), applicationId: 'c'.repeat(64) }; },
    // The real supervisor closes the owner it admitted when the page is removed.
    removePage: async () => { await owner.close(); return true; }, close: async () => {} };
  const client = { hub: { events: () => () => {}, onStatus: () => () => {}, connect() {}, close() {} },
    pages: { all: async function* () { for (const page of registered) yield { id: page.id }; } }, close() {} };
  const workspace = { root: '/w', paths: { owner: '/tmp/fixture-owner', secret, pages: join(secret, 'pages') }, config: { agent: { id: 'ag_fixture' } },
    client: async () => client, attachBinding: async () => ({ id: 'terminal', token: 'td_n_' + 'a'.repeat(64) }),
    async pages() { calls.pages++; return registered.map(page => ({ ...page, module: true, initialized: existsSync(join(pageDirectory(page.id), 'initialized.json')) })); },
    async pageContext() { calls.contexts++; return {}; }, async pageModule() { calls.modules++; return { openPage: async () => owner }; } };
  // Start with no page directory and no registered page at all.
  assert.equal(existsSync(join(secret, 'pages')), false);
  const running = runAgent(workspace, { signal: stop.signal, report: value => reports.push(value), openOwnerSupervisor: async () => supervisor });
  await until(() => reports.some(value => value.running === true), 'the agent program started with no pages');
  assert.equal(reports.filter(value => value.page).length, 0);
  // Register a new page: only its private page record appears, exactly like `tendril page new`.
  const id = 'bbbbbbbbbbbb';
  await mkdir(pageDirectory(id), { recursive: true });
  registered.push({ id, slug: 'late' });
  await writeFile(join(pageDirectory(id), 'page.json'), JSON.stringify({ schemaVersion: 1, id }), { mode: 0o600 });
  await until(() => reports.some(value => value.state === 'awaiting_initialization' && value.page === id), 'the new page is reported as awaiting initialization');
  assert.deepEqual({ contexts: calls.contexts, modules: calls.modules, addPage: calls.addPage }, { contexts: 0, modules: 0, addPage: [] },
    'an unprovisioned page opens no page context, module, device or owner');
  // Explicit provisioning writes the marker; the running agent opens the page without restarting.
  await writeFile(join(pageDirectory(id), 'initialized.json'), JSON.stringify({ provisioned: true }), { mode: 0o600 });
  await until(() => reports.some(value => value.state === 'running' && value.page === id), 'the provisioned page opens in the same agent program');
  assert.deepEqual(calls.addPage, [id]);
  assert.equal(calls.contexts, 1); assert.equal(calls.modules, 1);
  assert.equal(reports.filter(value => value.running === true).length, 1, 'no restart: one start report only');
  // Shutdown disposes the file subscription: later page records are never rediscovered.
  stop.abort(); await running;
  assert(opened.includes('owner-closed'));
  const pagesAfterStop = calls.pages, reportsAfterStop = reports.length;
  const other = 'cccccccccccc'; await mkdir(pageDirectory(other), { recursive: true });
  registered.push({ id: other, slug: 'after-stop' });
  await writeFile(join(pageDirectory(other), 'page.json'), '{}'); await writeFile(join(pageDirectory(other), 'initialized.json'), '{}');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(calls.pages, pagesAfterStop, 'no rescan after shutdown');
  assert.equal(reports.length, reportsAfterStop, 'nothing is reported after shutdown');
  assert.deepEqual(calls.addPage, [id]);
});
