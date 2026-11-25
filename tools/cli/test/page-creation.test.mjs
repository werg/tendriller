import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspacePage } from '../lib/page-creation.mjs';

const service = 'https://selected.example', agent = { id: 'ag_' + 'a'.repeat(26) }, other = 'f'.repeat(64), PAGE = 'bbbbbbbbbbbb';
const listed = (id, applicationId, extra = {}) => ({ id, name: 'Notes', page_url: `https://${id}.pages.example/`, api: `${service}/api/agent/pages/${id}`, application: { id: applicationId }, scopes: [], ...extra });

/** A workspace-shaped fixture: write-once private records in memory, a registry and a scripted host. */
function fixture({ granted = [], failCreate = false, loseCreateReply = false } = {}) {
  const files = new Map(), calls = { create: [], register: [], claim: 0 }, hostPages = [...granted];
  const store = {
    async read(name, optional) { if (files.has(name)) return structuredClone(files.get(name)); if (optional) return null; throw Object.assign(Error('ENOENT ' + name), { code: 'ENOENT' }); },
    async save(name, value) {
      // Write-once: an identical retry is accepted, a different record is refused.
      if (files.has(name) && JSON.stringify(files.get(name)) !== JSON.stringify(value)) throw Object.assign(Error('Refusing to replace ' + name), { code: 'private_record_exists' });
      files.set(name, structuredClone(value)); return value;
    },
    // Atomic exclusive create: exactly one concurrent caller wins.
    async claim(name, value) { calls.claim++; await Promise.resolve(); if (files.has(name)) return false; files.set(name, structuredClone(value)); return true; },
  };
  const config = { service, agent, pages: {} };
  const workspace = { config,
    async registerPage(slug, page) { calls.register.push(page.id); config.pages[slug] = { id: page.id }; return { ...page, slug }; },
    async page(slug) { return { ...hostPages.find(page => page.id === config.pages[slug].id), slug }; } };
  const client = { pages: {
    async *all() { yield* hostPages; },
    async create(body) {
      calls.create.push(body);
      if (failCreate) throw Object.assign(new Error('refused'), { status: 403 });
      const page = listed(PAGE, body.application.id, { name: body.name }); hostPages.push(page);
      if (loseCreateReply) throw Object.assign(new Error('The connection closed before the reply'), { code: 'ECONNRESET' });
      return page;
    } } };
  const create = (extra = {}) => createWorkspacePage({ workspace, client, store, slug: 'notes', name: 'Notes', ...extra });
  return { files, calls, store, workspace, client, hostPages, config, create, intent: () => files.get('intent.json') };
}

test('the exact creation intent, with a stable random application identity, is retained before the host is asked to create', async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(f.create(), /refused/);
  assert.deepEqual(Object.keys(f.intent()).sort(), ['agentId', 'applicationId', 'name', 'schemaVersion', 'service']);
  assert.equal(f.intent().schemaVersion, 1); assert.equal(f.intent().service, service); assert.equal(f.intent().agentId, agent.id); assert.equal(f.intent().name, 'Notes');
  assert.match(f.intent().applicationId, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.calls.create, [{ name: 'Notes', application: { id: f.intent().applicationId } }]);
  assert.deepEqual(f.files.get('dispatched.json'), { applicationId: f.intent().applicationId });
});

test('a requested mode is retained in the intent and sent; a requested application identity is used exactly', async () => {
  const f = fixture(), page = await f.create({ mode: 'dashboard', application: { id: other } });
  assert.equal(page.id, PAGE); assert.equal(f.intent().mode, 'dashboard'); assert.equal(f.intent().applicationId, other);
  assert.deepEqual(f.calls.create, [{ name: 'Notes', mode: 'dashboard', application: { id: other } }]);
  for (const bad of [{ mode: 'hosted' }, { application: { id: 'AB'.repeat(32) } }, { application: { id: other, extra: true } }, { name: '' }])
    await assert.rejects(fixture().create(bad), error => error.code === 'invalid_page_creation');
  await assert.rejects(fixture().create({ slug: 'Not A Slug' }), error => error.code === 'invalid_slug');
});

test('a same-named page of another application is never adopted, and creation proceeds with the retained application identity', async () => {
  const f = fixture({ granted: [listed('cccccccccccc', other)] }), page = await f.create();
  assert.notEqual(page.id, 'cccccccccccc'); assert.deepEqual(f.calls.register, [PAGE]);
  assert.equal(f.calls.create.length, 1); assert.notEqual(f.calls.create[0].application.id, other);
});

test('more than one granted page with the retained application identity is rejected without adopting or creating', async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(f.create(), /refused/);
  f.hostPages.push(listed('dddddddddddd', f.intent().applicationId), listed('eeeeeeeeeeee', f.intent().applicationId));
  const before = f.calls.create.length;
  await assert.rejects(f.create(), error => error.code === 'page_creation_ambiguous');
  assert.deepEqual(f.calls.register, []); assert.equal(f.calls.create.length, before);
});

test('a page of the retained application on another service origin is rejected, never adopted', async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(f.create(), /refused/);
  f.hostPages.push(listed('dddddddddddd', f.intent().applicationId, { api: 'https://another.example/api/agent/pages/dddddddddddd' }));
  await assert.rejects(f.create(), error => error.code === 'page_creation_service_mismatch');
  assert.deepEqual(f.calls.register, []);
});

test('a lost create reply resumes the same page by its exact application identity on the next attempt', async () => {
  const f = fixture({ loseCreateReply: true });
  await assert.rejects(f.create(), /connection closed/);
  assert.equal(f.hostPages.length, 1, 'the host did create the page');
  const page = await f.create();
  assert.equal(page.id, PAGE); assert.equal(f.calls.create.length, 1, 'no second page was created');
  assert.equal(f.hostPages.length, 1); assert.deepEqual(f.calls.register, [PAGE]);
});

test('an unresolved lost reply never creates another page and names the uncertainty and the inspection to perform', async () => {
  const f = fixture({ loseCreateReply: true });
  await assert.rejects(f.create(), /connection closed/);
  f.hostPages.length = 0; // the page cannot be seen by this agent right now
  for (let attempt = 0; attempt < 3; attempt++)
    await assert.rejects(f.create(), error => error.code === 'page_creation_uncertain' && /tendril page list/.test(error.message) && /No second page was created/.test(error.message));
  assert.equal(f.calls.create.length, 1); assert.deepEqual(f.calls.register, []);
});

test('an existing intent with a different name or mode fails before any host request and is never silently changed', async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(f.create(), /refused/);
  const original = structuredClone(f.intent()), requests = f.calls.create.length;
  let listed = 0; f.client.pages.all = async function* () { listed++; };
  await assert.rejects(f.create({ name: 'A different name on retry' }), error => error.code === 'page_creation_intent_mismatch');
  await assert.rejects(f.create({ mode: 'dashboard' }), error => error.code === 'page_creation_intent_mismatch');
  assert.equal(listed, 0, 'no network request before the mismatch'); assert.equal(f.calls.create.length, requests);
  assert.deepEqual(f.intent(), original);
});

test('an intent from another service or agent, or a mismatched dispatch marker, is refused before creating anything', async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(f.create(), /refused/);
  f.config.service = 'https://elsewhere.example';
  await assert.rejects(f.create(), error => error.code === 'page_creation_intent_mismatch');
  f.config.service = service; f.config.agent = { id: 'ag_' + 'z'.repeat(26) };
  await assert.rejects(f.create(), error => error.code === 'page_creation_intent_mismatch');
  f.config.agent = agent; f.files.set('dispatched.json', { applicationId: other });
  const before = f.calls.create.length;
  await assert.rejects(f.create(), error => error.code === 'page_creation_intent_mismatch');
  assert.equal(f.calls.create.length, before);
});

test('an already registered page is returned only when it matches the retained intent', async () => {
  const f = fixture(), page = await f.create();
  assert.equal((await f.create()).id, page.id); assert.equal(f.calls.create.length, 1);
  f.files.set('intent.json', { ...f.intent(), applicationId: other });
  await assert.rejects(f.create(), error => error.code === 'page_creation_intent_mismatch');
});

test('concurrent repeats of one reviewed request send exactly one create and every caller resolves the same page', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.create(), f.create(), f.create()]);
  assert.equal(f.calls.create.length, 1, 'the atomic dispatch claim admits a single create');
  assert.equal(f.hostPages.length, 1);
  for (const result of results) assert(result.status === 'fulfilled' ? result.value.id === PAGE : result.reason.code === 'page_creation_uncertain', 'a losing caller either recovers the exact page or reports the uncertainty');
  assert(results.some(result => result.status === 'fulfilled'));
  assert.equal(f.intent().applicationId, f.hostPages[0].application.id, 'the first captured identity won');
});

test('a cancelled signal stops before any record or request', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(Error('stop'));
  await assert.rejects(f.create({ signal: controller.signal }), /stop/);
  assert.equal(f.files.size, 0); assert.equal(f.calls.create.length, 0);
});
