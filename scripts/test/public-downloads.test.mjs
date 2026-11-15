import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

const run = promisify(execFile);
const assets = new URL('../../server/public/', import.meta.url);

test('public helpers run from an empty directory without checkout imports or npm', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tendril-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['tendril-stream', 'tendril-events']) {
    const file = join(dir, `${name}.mjs`);
    await cp(new URL(`${name}.mjs`, assets), file);
    await assert.rejects(run(process.execPath, [file], { cwd: dir }), error => {
      assert.equal(error.code, name === 'tendril-events' ? 64 : 1);
      assert.match(error.stderr, /usage:/i);
      assert.doesNotMatch(error.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
      return true;
    });
  }
});

test('downloaded dashboard setup publishes its complete example and saves private scoped credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tendril-dashboard-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const template = join(dir, 'dashboard');
  await cp(new URL('examples/training-dashboard/', assets), template, { recursive: true });
  const requests = [];
  let base;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    requests.push({ method: req.method, path: req.url, body, authorization: req.headers.authorization });
    const result = req.url === '/api/tendrils' ? { id: 'example', api: base + '/api/t/example', token: 'tk_test_private', page_url: base + '/page/' }
      : req.url.endsWith('/streams') && req.method === 'GET' ? { streams: [] }
      : req.url.endsWith('/producers') && req.method === 'GET' ? { producers: [] }
      : req.url.endsWith('/producers') ? { token: 'tp_test_private' }
      : req.url.endsWith('/files') ? { version: 1 } : {};
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const { stdout, stderr } = await run(process.execPath, [join(template, 'setup.mjs')], { cwd: dir,
    env: { ...process.env, TENDRILLER_SERVICE_BASE: base, TENDRILLER_OWNER: 'owner@example.test', TENDRILLER_DASHBOARD_DIR: join(dir, 'private') } });
  assert.equal(stderr, '');
  assert.match(stdout, /claim.*1 MiB.*8 MiB/);
  assert.doesNotMatch(stdout, /tk_test_private|tp_test_private/);
  const creation = requests.find(request => request.path === '/api/tendrils');
  assert.equal(creation.body.mode, 'dashboard');
  assert.equal(creation.authorization, undefined);
  const publication = requests.find(request => request.path.endsWith('/files'));
  assert.deepEqual(Object.keys(publication.body.files).sort(), ['app.js', 'index.html', 'model.mjs']);
  assert.match(publication.body.files['index.html'], /_tendril\/snippets\/chart\.js/);
  assert.equal(publication.authorization, 'Bearer tk_test_private');
  const config = JSON.parse(await readFile(join(dir, 'private/collector.json'), 'utf8'));
  assert.equal(config.token, 'tp_test_private');
  assert.equal(config.api, base + '/api/t/example');
  assert.equal(config.sources.length, 3);
});
