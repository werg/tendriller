import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { getGlobalDispatcher } from 'undici';
import { packTarGz } from '../../contract/archive.mjs';
import { prepareDevHostRelease } from '../dev-host-release.mjs';
import { localNetworkSource, startDevHost } from '../dev-host.mjs';

import { FIRST_APP_PROFILES } from '../release-composition.mjs';
const run = promisify(execFile), require = createRequire(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const source = 'a'.repeat(40), tree = 'b'.repeat(40), runtime = 'c'.repeat(64), version = '1.2.3-rc.4';
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dev-host-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function freePort() {
  const probe = createServer();
  await new Promise((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done); });
  const port = probe.address().port; await new Promise(done => probe.close(done));
  return port;
}

// A complete small release graph lets these tests change authenticated archive
// contents independently from their manifest hashes, without network or rebuilds.
async function fixture(t) {
  const directory = await temporary(t), bytes = new Map(), calls = [];
  const base = `https://github.com/werg/tendriller/releases/download/source-${source}/`;
  const artifact = (role, file, content = `public ${role} bytes`) => {
    const value = Buffer.from(content); bytes.set(file, value);
    return { role, file, url: base + file, sha256: hash(value), size: value.length };
  };
  const components = ['sdk', 'runtime', 'engine', 'tools', 'authority', 'session', 'session-sql-browser', 'starter']
    .map(role => artifact(role, `${role}-${version}.tgz`));
  const body = { format: 'tendriller-release-composition-v1', version, contract: 3,
    core: { repository: 'werg/tendriller', source, sourceTree: tree, dirty: false }, runtime, profiles:FIRST_APP_PROFILES,
    chronolog:Object.fromEntries(['authority','session','session-sql-browser'].map(role=>[role,{repository:'werg/chronolog-db',source:'d'.repeat(40),sourceTree:'e'.repeat(40),dirty:false}])),
    components: components.map(({ role, file, sha256, size }) => ({ role, file, sha256, size })) };
  const composition = { ...body, id: hash(JSON.stringify(body)) };
  const kit = packTarGz([{ path: 'package.json', bytes: json({ name: 'local-app', private: true }) },
    { path: 'README.md', bytes: 'Exact first-app fixture.' }]);
  const manifest = { format: 'tendriller-core-release', version, contract: 3, source_commit: source, source_tree: tree, runtime,
    composition: { id: composition.id, file: 'composition.json' }, first_app: { file: `tendriller-first-app-${version}.tgz`, profile: 'events',packages:FIRST_APP_PROFILES.events.packages,build_dependency:'esbuild@0.28.2' },first_apps:{sql:{file:`tendriller-first-app-sql-${version}.tgz`,profile:'sql',packages:FIRST_APP_PROFILES.sql.packages,build_dependency:'esbuild@0.28.2'}},
    artifacts: [...components, artifact('composition', 'composition.json', json(composition)),
      artifact('first-app', `tendriller-first-app-${version}.tgz`, kit),artifact('first-app-sql',`tendriller-first-app-sql-${version}.tgz`,kit), artifact('core-provenance', 'provenance.json'),
      artifact('tools-provenance', 'tools-manifest.json'), artifact('plugin', 'plugin.zip')] };
  const files = new Map([
    ['dist/engine/worker.mjs', Buffer.from('export default { fetch() { return new Response("release"); } };')],
    ['dist/engine/testing-ratelimits.json', json({ ratelimits: [] })],
    ['dist/engine/migrations/0001_accounts.sql', Buffer.from('CREATE TABLE accounts(id TEXT PRIMARY KEY);')],
    ['dist/engine/migrations/0002_agents.sql', Buffer.from('CREATE TABLE agents(id TEXT PRIMARY KEY);')],
    ['dist/engine/migrations/0003_broadcasts.sql', Buffer.from('CREATE TABLE system_broadcasts(seq INTEGER PRIMARY KEY);')],
    ['dist/engine/migrations/0004_account_limits.sql', Buffer.from('SELECT 1;')],
    ['dist/engine/migrations/0005_billing_and_tiers.sql', Buffer.from('SELECT 1;')],
    ['dist/engine/migrations/0006_oauth_connections_and_groups.sql', Buffer.from('SELECT 1;')],
    ['dist/engine/migrations/0007_custom_domains.sql', Buffer.from('SELECT 1;')],
    ['server/public/llms.txt', Buffer.from('Exact public guide.')],
    ['server/src/runtime-release.json', json({ id: 'a'.repeat(64) })],
  ]);
  const proof = { source, sourceTree: tree, dirty: false, storageSchemaRevision: 14,
    files: Object.fromEntries([...files].filter(([path]) => path.startsWith('dist/engine/'))
      .map(([path, content]) => [path.slice('dist/engine/'.length), hash(content)])) };
  const save = () => bytes.set('manifest.json', json(manifest));
  const seal = () => {
    files.set('dist/engine/provenance.json', json(proof));
    const entry = artifact('deployment', 'tendriller-deployment.tgz', packTarGz([...files].map(([path, content]) => ({ path, bytes: content }))));
    const old = manifest.artifacts.find(item => item.role === 'deployment');
    if (old) Object.assign(old, entry); else manifest.artifacts.push(entry);
    save();
  };
  seal();
  const fetcher = async (url, options) => {
    calls.push(url); assert(url.startsWith(base)); assert.equal(options.credentials, 'omit');
    const content = bytes.get(url.slice(base.length));
    return content ? new Response(content) : new Response(null, { status: 404 });
  };
  return { directory, bytes, files, proof, manifest, seal, save, calls, fetcher,
    prepare: options => prepareDevHostRelease({ release: source, directory, fetcher, ...options }) };
}

test('a verified source release extracts its exact Worker and kit without replacing retained host state', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'storage')); await writeFile(join(f.directory, 'storage', 'retained'), 'device and host data');
  await writeFile(join(f.directory, 'host.json'), '{"retained":true}');
  const first = await f.prepare();
  assert.equal(first.manifest.source_commit, source);
  assert.equal(await readFile(join(first.directory, 'dist/engine/worker.mjs'), 'utf8'), f.files.get('dist/engine/worker.mjs').toString());
  assert.equal(await readFile(join(first.kitDirectory, 'README.md'), 'utf8'), 'Exact first-app fixture.');
  await f.prepare({ manifestSha256: first.manifestSha256 });
  await f.prepare({ manifestSha256: first.manifestSha256, artifacts: join(f.directory, 'downloads'),
    fetcher() { assert.fail('verified retained downloads must support offline restart'); } });
  assert.equal(await readFile(join(f.directory, 'storage', 'retained'), 'utf8'), 'device and host data');
  assert.equal(await readFile(join(f.directory, 'host.json'), 'utf8'), '{"retained":true}');
});

test('changed deployment or kit bytes fail before touching an existing release or retained data', async t => {
  for (const role of ['deployment', 'first-app']) await t.test(role, async t => {
    const f = await fixture(t), previous = await f.prepare();
    const worker = await readFile(join(previous.directory, 'dist/engine/worker.mjs'));
    await writeFile(join(f.directory, 'retained'), 'keep');
    const item = f.manifest.artifacts.find(item => item.role === role), changed = Buffer.from(f.bytes.get(item.file));
    changed[changed.length - 1] ^= 1; f.bytes.set(item.file, changed);
    await assert.rejects(f.prepare(), { code: 'release_bytes_mismatch' });
    assert.deepEqual(await readFile(join(previous.directory, 'dist/engine/worker.mjs')), worker);
    assert.equal(await readFile(join(f.directory, 'retained'), 'utf8'), 'keep');
  });
});

test('a retained manifest pin rejects replacement metadata before fetching assets', async t => {
  const f = await fixture(t);
  await assert.rejects(f.prepare({ manifestSha256: '0'.repeat(64) }), /different release manifest/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(stat(join(f.directory, 'release')), { code: 'ENOENT' });
});

test('source mismatch and releases without sealed deployment are rejected', async t => {
  const wrong = await fixture(t); wrong.manifest.source_commit = 'e'.repeat(40); wrong.save();
  await assert.rejects(wrong.prepare(), { code: 'release_identity_mismatch' });
  const old = await fixture(t); old.manifest.artifacts = old.manifest.artifacts.filter(item => item.role !== 'deployment'); old.save();
  await assert.rejects(old.prepare(), /no sealed deployment/);
});

test('authenticated deployment archives still reject foreign paths, missing files and changed engine bytes', async t => {
  for (const [name, change, message] of [
    ['outside public roots', f => f.files.set('outside.txt', Buffer.from('unrelated')), /outside the public release graph/],
    ['missing public guide', f => f.files.delete('server/public/llms.txt'), /missing server\/public\/llms.txt/],
    ['changed packed Worker', f => f.files.set('dist/engine/worker.mjs', Buffer.from('different executable')), /packed engine failed verification/],
  ]) await t.test(name, async t => {
    const f = await fixture(t); change(f); f.seal();
    await assert.rejects(f.prepare(), message);
    await assert.rejects(stat(join(f.directory, 'release')), { code: 'ENOENT' });
  });
});

test('engine provenance must retain the selected clean source, tree and supported schema', async t => {
  for (const [key, value] of [['source', 'e'.repeat(40)], ['sourceTree', 'e'.repeat(40)], ['dirty', true], ['storageSchemaRevision', 10]])
    await t.test(key, async t => {
      const f = await fixture(t); f.proof[key] = value; f.seal();
      await assert.rejects(f.prepare(), /clean matching engine with storage schema 14/);
    });
});

test('an explicitly supplied artifact directory verifies without reaching GitHub', async t => {
  const f = await fixture(t), artifacts = join(f.directory, 'artifacts'); await mkdir(artifacts);
  for (const [file, content] of f.bytes) await writeFile(join(artifacts, file), content);
  const selected = await f.prepare({ artifacts, fetcher() { assert.fail('local assets must not use network'); } });
  assert.equal(await readFile(join(selected.kitDirectory, 'README.md'), 'utf8'), 'Exact first-app fixture.');
});

test('existing state locks and mismatched host identities preserve private state and prevent acquisition', async t => {
  const locked = await temporary(t); await writeFile(join(locked, 'host.lock'), 'retained-pid');
  const never = () => assert.fail('state rejection must happen before release acquisition');
  await assert.rejects(startDevHost({ release: source, state: locked, fetcher: never }), /directory is locked/);
  assert.equal(await readFile(join(locked, 'host.lock'), 'utf8'), 'retained-pid');
  for (const previous of [
    { source: 'b'.repeat(40), serviceOrigin: 'https://service.localhost:8790' },
    { source, serviceOrigin: 'https://service.localhost:8791' },
  ]) {
    const directory = await temporary(t); await writeFile(join(directory, 'host.json'), json(previous));
    await writeFile(join(directory, 'retained'), 'private state');
    await assert.rejects(startDevHost({ release: source, state: directory, fetcher: never }), /another release or origin/);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'host.json'), 'utf8')), previous);
    assert.equal(await readFile(join(directory, 'retained'), 'utf8'), 'private state');
    await assert.rejects(stat(join(directory, 'host.lock')), { code: 'ENOENT' });
  }
});

test('a failed database initialization pins partial state to its source and manifest before a later retry', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  // Let the real Worker start and create persistent D1 storage, then fail on
  // its deliberately incomplete account schema. This is a partial start, not
  // an early metadata or command-line validation rejection.
  const worker = Buffer.from(`import { DurableObject } from 'cloudflare:workers';
    export class Tendril extends DurableObject { fetch() { return new Response('fixture'); } }
    export class Admission extends DurableObject { fetch() { return new Response('fixture'); } }
    export default { fetch() { return new Response('fixture'); } };`);
  f.files.set('dist/engine/worker.mjs', worker); f.proof.files['worker.mjs'] = hash(worker); f.seal();
  const port = await freePort();
  const dispatcher = getGlobalDispatcher();
  await assert.rejects(startDevHost({ release: source, state: f.directory, port, fetcher: f.fetcher }), /no such table: service_state/);
  assert.equal(getGlobalDispatcher(), dispatcher, 'Loading the SQL parser must not replace the caller\'s network dispatcher');
  assert((await stat(join(f.directory, 'storage'))).isDirectory());
  const pin = JSON.parse(await readFile(join(f.directory, 'host.json'), 'utf8'));
  assert.equal(pin.source, source); assert.equal(pin.manifestSha256, hash(f.bytes.get('manifest.json')));
  assert.equal(pin.serviceOrigin, `https://service.localhost:${port}`);
  await assert.rejects(stat(join(f.directory, 'host.lock')), { code: 'ENOENT' });
  await writeFile(join(f.directory, 'storage', 'retained'), 'partial database state');
  await assert.rejects(startDevHost({ release: 'e'.repeat(40), state: f.directory, port,
    fetcher() { assert.fail('A new source cannot acquire assets for pinned partial state'); } }), /another release or origin/);
  f.manifest.replacement = true; f.save();
  await assert.rejects(startDevHost({ release: source, state: f.directory, port, fetcher: f.fetcher }), /different release manifest/);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'host.json'), 'utf8')), pin);
  assert.equal(await readFile(join(f.directory, 'storage', 'retained'), 'utf8'), 'partial database state');
  await assert.rejects(stat(join(f.directory, 'host.lock')), { code: 'ENOENT' });
});

test('the listening host forwards to the packed Worker, serves assets and resumes its synthetic owner database', { timeout: 20_000 }, async t => {
  const f = await fixture(t), port = await freePort();
  const worker = Buffer.from(`import { DurableObject } from 'cloudflare:workers';
    export class Tendril extends DurableObject {}
    export class Admission extends DurableObject {}
    export default { async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path === '/api/readiness') {
        const state = await env.ACCOUNTS.prepare('SELECT mode FROM service_state WHERE id=1').first();
        return Response.json({ creation: { available: state.mode === 'open' },
          build: { sourceCommit: env.SERVICE_SOURCE_COMMIT, compositionId: env.SERVICE_COMPOSITION_ID } });
      }
      if (path === '/fixture/owner') return Response.json(await env.ACCOUNTS.prepare(
        'SELECT a.email, i.provider, count(*) AS total FROM accounts a JOIN identities i ON i.account_id=a.id').first());
      return env.ASSETS.fetch(request);
    } };`);
  const migration = await readFile(resolve(import.meta.dirname, '../../server/migrations/0001_accounts.sql'));
  for (const [path, content] of [['worker.mjs', worker], ['migrations/0001_accounts.sql', migration]]) {
    f.files.set('dist/engine/' + path, content); f.proof.files[path] = hash(content);
  }
  f.seal();
  let running;
  t.after(() => running?.close());
  const undiciUrl = pathToFileURL(require.resolve('undici')).href;
  async function inspect() {
    const script = `import assert from 'node:assert/strict'; import { getGlobalDispatcher } from ${JSON.stringify(undiciUrl)};
      try {
        const base = ${JSON.stringify(`https://service.localhost:${port}`)};
        const ready = await fetch(base + '/api/readiness'); assert.equal(ready.status, 200);
        assert.deepEqual(await ready.json(), { creation: { available: true },
          build: { sourceCommit: ${JSON.stringify(source)}, compositionId: ${JSON.stringify(f.manifest.composition.id)} } });
        const owner = await fetch(base + '/fixture/owner'); assert.equal(owner.status, 200);
        assert.deepEqual(await owner.json(), { email: 'owner@example.test', provider: 'test', total: 1 });
        const asset = await fetch(base + '/llms.txt'); assert.equal(asset.status, 200);
        assert.equal(await asset.text(), 'Exact public guide.');
      } finally { await getGlobalDispatcher().close(); }
    `;
    await run(process.execPath, ['--import', running.preload, '--input-type=module', '-e', script], { timeout: 10_000 });
  }
  running = await startDevHost({ release: source, state: f.directory, port, fetcher: f.fetcher });
  await inspect(); await running.close();
  running = await startDevHost({ release: source, state: f.directory, port, artifacts: join(f.directory, 'downloads'),
    fetcher() { assert.fail('resuming from retained public archives must not use the network'); } });
  await inspect(); await running.close();
  await assert.rejects(stat(join(f.directory, 'host.lock')), { code: 'ENOENT' });
});

test('CLI rejects mutable release refs, invalid ports and incomplete browser options before creating state', async t => {
  const directory = await temporary(t), state = join(directory, 'unused'), command = resolve(import.meta.dirname, '../dev-host.mjs');
  for (const [args, message] of [
    [['--release', 'master'], /full 40-character source commit SHA/],
    [['--release', source, '--port', '65536'], /integer between 1024 and 65535/],
    [['--release', source, '--port', 'NaN'], /integer between 1024 and 65535/],
    [['--release', source, '--headless'], /--headless requires --open/],
  ]) {
    await assert.rejects(run(process.execPath, [command, ...args, '--state', state], { timeout: 10_000 }), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, message); return true;
    });
    await assert.rejects(stat(state), { code: 'ENOENT' });
  }
  const help = await run(process.execPath, [command, '--help'], { timeout: 10_000 });
  assert.match(help.stdout, /--release FULL_SOURCE_SHA/);
});

test('the native preload reaches only the pinned local HTTPS host and rejects remote origins and changed certificates', { timeout: 20_000 }, async t => {
  const directory = await temporary(t);
  const host = new Miniflare({ ...convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, https: true, cf: false,
    workers: [{ name: 'local-preload', modules: true, script: 'export default { fetch(request) { return new Response(new URL(request.url).host); } };',
      compatibilityDate: '2026-11-01' }] }), resourceTmpPath: join(directory, 'work'), enableDevRegistry: false, logRequests: false });
  t.after(() => host.dispose());
  const port = Number((await host.ready).port);
  const certificate = await new Promise((done, reject) => {
    const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    socket.once('error', reject); socket.once('secureConnect', () => {
      const cert = new X509Certificate(socket.getPeerCertificate().raw); socket.destroy(); done(cert);
    });
  });
  const undiciUrl = pathToFileURL(require.resolve('undici')).href;
  const preload = join(directory, 'local-network.mjs'), cert = { pem: certificate.toString(), sha256: hash(certificate.raw) };
  await writeFile(preload, localNetworkSource({ port, cert, undiciUrl }));
  const script = `import assert from 'node:assert/strict'; import { getGlobalDispatcher } from ${JSON.stringify(undiciUrl)};
    try {
      assert.equal(await (await fetch('https://service.localhost:${port}/')).text(), 'service.localhost:${port}');
      assert.equal(await (await fetch('https://aaaaaaaaaaaa.pages.localhost/')).text(), 'aaaaaaaaaaaa.pages.localhost:${port}');
      for (const url of ['https://example.test/', 'http://service.localhost:${port}/', 'https://invalid.pages.localhost/',
        'https://service.localhost:${port === 65535 ? port - 1 : port + 1}/', 'https://service.localhost.evil.invalid/'])
        await assert.rejects(fetch(url), error => /only permits this loopback host/.test(error.cause?.message));
    } finally { await getGlobalDispatcher().close(); }
  `;
  await run(process.execPath, ['--import', preload, '--input-type=module', '-e', script], { timeout: 10_000 });
  await writeFile(preload, localNetworkSource({ port, cert: { ...cert, sha256: '0'.repeat(64) }, undiciUrl }));
  await run(process.execPath, ['--import', preload, '--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import { getGlobalDispatcher } from ${JSON.stringify(undiciUrl)};
    try { await assert.rejects(fetch('https://service.localhost:${port}/'), error => /certificate changed/.test(error.cause?.message)); }
    finally { await getGlobalDispatcher().close(); }
  `], { timeout: 10_000 });
});
