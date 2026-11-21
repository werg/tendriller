import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { packTarGz, unpackTarGz, listTarGz, readTarGzFile } from '../../contract/archive.mjs';
import { createReleaseDownloader, extractVerifiedTarGz } from '../../contract/release-verify.mjs';
import { probeCapabilities, detectProxyEnvironment } from '../../contract/transport-probe.mjs';
import { createServerlessHostAdapter } from '../../contract/serverless.mjs';
import { acquireAtomicLock, resolveUnixSocketPath, resolveWindowsPipePath } from '../../session/ipc.mjs';
import { createPersistentOutbox } from '../../session/outbox.mjs';
import { connectOrStartNativeSession } from '../../session/native.mjs';
import { buildCompositionV2, COMPOSITION_V2_PROFILES } from '../release-composition.mjs';
import { exportSourceHandoff, exportSqliteCheckpoint, restoreSqliteCheckpoint } from '../../tools/cli/lib/handoff.mjs';
import { handleStdioMcpMessage } from '../../tools/cli/lib/mcp-stdio.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('pure-JS tar.gz packs, lists, reads, and rejects path traversal cleanly', () => {
  const archive = packTarGz([
    { path: 'nested/hello.txt', bytes: 'hello world' },
    { path: 'package.json', bytes: JSON.stringify({ name: 'demo' }) },
  ]);
  assert.deepEqual(listTarGz(archive), ['nested/hello.txt', 'package.json']);
  assert.equal(new TextDecoder().decode(readTarGzFile(archive, 'nested/hello.txt')), 'hello world');
  assert.throws(() => packTarGz([{ path: '../escape.txt', bytes: 'bad' }]), { code: 'ARCHIVE_PATH_UNSAFE' });
});

test('shared release verifier enforces hashes, redirect allowlists, and nondestructive extraction', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-release-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = packTarGz([
    { path: 'index.mjs', bytes: 'export const v = 2;\n' },
    { path: '.tendriller/device.sqlite', bytes: 'should-not-overwrite' },
  ]);
  const hash = sha256(archive);

  const downloader = createReleaseDownloader('https://github.com/werg/tendriller/releases/download/source-' + 'a'.repeat(40), {
    fetcher: async url => {
      if (url.includes('github.com')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/kit.tgz' } });
      return new Response(archive, { status: 200, headers: { 'content-length': String(archive.byteLength) } });
    },
  });
  const verified = await downloader.download('kit.tgz', hash, archive.byteLength, true);
  assert.equal(sha256(verified), hash);

  const badRedirect = createReleaseDownloader('https://github.com/werg/tendriller/releases/download/source-' + 'a'.repeat(40), {
    fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/kit.tgz' } }),
  });
  await assert.rejects(badRedirect.download('kit.tgz', hash, archive.byteLength, true), { code: 'release_redirect_forbidden' });

  // Pre-seed private device store and verify nondestructive extraction preserves it.
  mkdirSync(join(dir, '.tendriller'), { recursive: true });
  writeFileSync(join(dir, '.tendriller/device.sqlite'), 'original-device');
  const extracted = extractVerifiedTarGz(verified, dir, {
    expectedSha256: hash,
    preserveExisting: rel => rel.startsWith('.tendriller/'),
  });
  assert.deepEqual(extracted.written, ['index.mjs']);
  assert.deepEqual(extracted.preserved, ['.tendriller/device.sqlite']);
  assert.equal(readFileSync(join(dir, '.tendriller/device.sqlite'), 'utf8'), 'original-device');
});

test('capability probe reports structured runtime, storage, IPC, proxy, and unknown network fields', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = await probeCapabilities({ projectPath: dir, checkNetwork: false });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.runtime.wasm, true);
  assert.equal(report.storage.writableProjectPath, true);
  assert.equal(report.storage.atomicRenameAndLock, true);
  assert.equal(report.storage.sameSessionSaveReopen, true);
  assert.equal(report.storage.postReplacementSurvival, 'unknown');
  assert.equal(report.networking.https443, 'unknown');
  assert.equal(report.lifecycle.ipc.available, true);
  assert.ok(report.recommendedRoutes.some(r => r.route === 'bounded-local-participant' && r.available === true));
  const proxy = detectProxyEnvironment({ HTTPS_PROXY: 'http://proxy.internal:8080', NO_PROXY: 'localhost' });
  assert.equal(proxy.configured, true);
  assert.equal(proxy.httpsProxy, '[configured]');
});

test('standalone zero-dependency bootstrapper probes, extracts nondestructively, and refuses tampered hashes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-boot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bootstrap = join(root, 'scripts/tendriller-bootstrap.mjs');
  const probeOut = JSON.parse(execFileSync(process.execPath, [bootstrap, '--probe-only'], { encoding: 'utf8' }));
  assert.equal(probeOut.ok, true);
  assert.equal(probeOut.readiness, 'probe_complete');

  const kitPath = join(dir, 'kit.tgz');
  const projectDir = join(dir, 'project');
  mkdirSync(join(projectDir, '.tendriller'), { recursive: true });
  writeFileSync(join(projectDir, '.tendriller/handle.json'), '{"keep":true}');
  const bytes = packTarGz([{ path: 'README.md', bytes: 'starter' }, { path: '.tendriller/handle.json', bytes: '{"clobber":true}' }]);
  writeFileSync(kitPath, bytes);

  const okOut = JSON.parse(execFileSync(process.execPath, [
    bootstrap, '--archive-file', kitPath, '--expected-sha256', sha256(bytes), '--project', projectDir, '--profile', 'events-relay-only',
  ], { encoding: 'utf8' }));
  assert.equal(okOut.ok, true);
  assert.equal(okOut.readiness, 'project_prepared');
  assert.equal(okOut.profileConfigured, false);
  assert.equal(readFileSync(join(projectDir, '.tendriller/handle.json'), 'utf8'), '{"keep":true}');

  // Tampered hash exits with semantic code 3 (INTEGRITY_FAILURE).
  assert.throws(() => execFileSync(process.execPath, [
    bootstrap, '--archive-file', kitPath, '--expected-sha256', '0'.repeat(64), '--project', projectDir,
  ], { encoding: 'utf8' }), error => error.status === 3);
});

test('composition v2 supports all four explicit profiles including relay-only', () => {
  assert.deepEqual(Object.keys(COMPOSITION_V2_PROFILES).sort(), ['events-full', 'events-relay-only', 'sql-full', 'sql-portable-relay-only']);
  const comp = buildCompositionV2({
    version: '0.3.0-rc.17',
    contract: 3,
    runtime: 'a'.repeat(64),
    core: { repository: 'werg/tendriller', source: 'b'.repeat(40), sourceTree: 'c'.repeat(40), dirty: false },
    chronolog: { session: { source: 'd'.repeat(40) } },
    profiles: {
      'events-relay-only': { sql: false, nativeRtc: false, components: [] },
      'sql-portable-relay-only': { sql: true, nativeRtc: false, wasmSql: true, components: [] },
    },
  });
  assert.equal(comp.format, 'tendriller-release-composition-v2');
  assert.match(comp.id, /^[a-f0-9]{64}$/);
  assert.equal(comp.profiles['events-relay-only'].nativeRtc, false);
  assert.equal(comp.profiles['sql-portable-relay-only'].wasmSql, true);
});

test('persistent pre-submission outbox preserves operation IDs and rejects payload conflicts', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-outbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outbox = await createPersistentOutbox(join(dir, 'state'));
  const first = await outbox.record({ operationId: 'op-1', appId: 'a'.repeat(64), deviceId: 'd'.repeat(64), command: 'addNote', input: { text: 'hi' } });
  assert.equal(first.status, 'recorded');
  const repeat = await outbox.record({ operationId: 'op-1', appId: 'a'.repeat(64), deviceId: 'd'.repeat(64), command: 'addNote', input: { text: 'hi' } });
  assert.equal(repeat.payloadHash, first.payloadHash);
  await assert.rejects(outbox.record({ operationId: 'op-1', appId: 'a'.repeat(64), deviceId: 'd'.repeat(64), command: 'addNote', input: { text: 'changed' } }),
    { code: 'OUTBOX_OPERATION_CONFLICT' });
  await outbox.mark('op-1', 'applied');
  assert.equal((await outbox.list({ pendingOnly: true })).length, 0);
});

test('cross-platform IPC naming, atomic lock stale recovery, and INSTANCE_UNRESPONSIVE safety', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-ipc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(resolveWindowsPipePath(dir), /^\\\\\.\\pipe\\tendriller-[a-f0-9]{32}$/);
  const longDir = join(dir, 'a'.repeat(60), 'b'.repeat(60));
  assert.ok(Buffer.byteLength(resolveUnixSocketPath(longDir)) <= 100);

  // Write a stale lock owned by a dead PID and verify automatic reclamation.
  const stateDir = join(dir, 'stale');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, 'owner.lock'), JSON.stringify({
    version: 1, lockId: 'dead', pid: 999999999, hostId: hostname(), startedAt: 1, heartbeatAt: 1, leaseTtlMs: 1000,
  }), { mode: 0o600 });
  const reclaimed = await acquireAtomicLock(stateDir, { probeReachable: async () => false });
  // While we hold the lock in this live process with unreachable IPC, a second acquire MUST fail with INSTANCE_UNRESPONSIVE.
  await assert.rejects(acquireAtomicLock(stateDir, { probeReachable: async () => false }), { code: 'INSTANCE_UNRESPONSIVE' });
  await reclaimed.release();
});

test('connectOrStartNativeSession supports bounded zero-IPC mode and concurrent shared startup convergence over loopback TCP', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-cos-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const appId = '11'.repeat(32);
  const deviceId = '22'.repeat(32);
  const seenOps = [];
  const fakeOwnerFactory = async () => {
    const endpoints = [];
    const session = {
      applicationId: appId,
      deviceId,
      signal: new AbortController().signal,
      describe: () => ({ id: 'demo', version: '1' }),
    };
    return {
      ownerInstanceId: 'owner-1',
      session,
      endpoints: () => endpoints,
      attach(endpoint, policy) {
        const onMessage = event => {
          const { port } = event.data;
          port.addEventListener('message', msg => {
            if (msg.data?.method === 'command') seenOps.push(msg.data.args[2].operationId);
            port.postMessage({ id: msg.data?.id ?? 1, result: { ok: true, op: msg.data?.args?.[2]?.operationId }, snapshot: { status: { phase: 'ready' } } });
          });
          port.start();
          port.postMessage({ ready: { applicationId: appId, deviceId, endpoint: { identity: policy.identity } } });
        };
        endpoint.addEventListener('message', onMessage);
        return () => endpoint.removeEventListener('message', onMessage);
      },
      async close() {},
    };
  };
  const fakeConnect = async (endpoint, opts) => {
    const channel = new MessageChannel();
    let readyData;
    const readyPromise = new Promise(done => {
      channel.port1.addEventListener('message', event => { if (event.data?.ready) done(event.data.ready); }, { once: true });
    });
    channel.port1.start();
    endpoint.postMessage({ protocol: 'test', handshake: { applicationId: opts.applicationId }, port: channel.port2 });
    readyData = await readyPromise;
    const signal = new AbortController().signal;
    return {
      applicationId: readyData.applicationId,
      deviceId: readyData.deviceId,
      endpoint: readyData.endpoint,
      signal,
      callCommand(operationId) {
        return new Promise(done => {
          channel.port1.addEventListener('message', event => { if (event.data?.id === 7) done(event.data.result); }, { once: true });
          channel.port1.postMessage({ id: 7, method: 'command', args: ['add', {}, { operationId }] });
        });
      },
      async detach() { channel.port1.close(); },
    };
  };

  // 1. Bounded zero-IPC mode
  const boundedDir = join(dir, 'bounded');
  const bounded = await connectOrStartNativeSession({
    directory: boundedDir, profileId: 'p1', openOwner: fakeOwnerFactory, connect: fakeConnect,
    applicationId: appId, definitionId: 'demo', definitionVersion: '1', bounded: true,
  });
  assert.equal(bounded.mode, 'bounded');
  assert.equal(existsSync(join(boundedDir, 'endpoint.json')), false);
  await bounded.close();

  // 2. Concurrent shared callers over loopback-tcp with verbatim operationId preservation
  const sharedDir = join(dir, 'shared');
  const [first, second] = await Promise.all([
    connectOrStartNativeSession({
      directory: sharedDir, profileId: 'p1', openOwner: fakeOwnerFactory, connect: fakeConnect,
      applicationId: appId, definitionId: 'demo', definitionVersion: '1', preferredTransport: 'loopback-tcp',
    }),
    connectOrStartNativeSession({
      directory: sharedDir, profileId: 'p1', openOwner: fakeOwnerFactory, connect: fakeConnect,
      applicationId: appId, definitionId: 'demo', definitionVersion: '1', preferredTransport: 'loopback-tcp',
    }),
  ]);
  assert.equal([first.startedSupervisor, second.startedSupervisor].filter(Boolean).length, 1);
  const res = await first.session.callCommand('my-verbatim-op-42');
  assert.equal(res.op, 'my-verbatim-op-42');
  assert.deepEqual(seenOps, ['my-verbatim-op-42']);
  const owner = first.startedSupervisor ? first : second;
  const peer = first.startedSupervisor ? second : first;
  await peer.detach();
  await owner.close();
});

test('source handoff blocks secrets and SQLite checkpoint encrypts, restores, and retires source', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-handoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proj = join(dir, 'app');
  mkdirSync(join(proj, '.tendriller'), { recursive: true });
  writeFileSync(join(proj, 'index.html'), '<h1>Hi</h1>');
  writeFileSync(join(proj, '.tendriller/device.sqlite'), 'private-bytes');
  const handoff = exportSourceHandoff(proj, join(dir, 'handoff.tgz'));
  assert.deepEqual(listTarGz(readFileSync(handoff.output)), ['handoff-manifest.json', 'index.html']);

  // Secret detection blocks accidental token leakage
  writeFileSync(join(proj, 'leak.mjs'), `export const k = 'td_a_${'f'.repeat(64)}';`);
  assert.throws(() => exportSourceHandoff(proj, join(dir, 'leak.tgz')), { code: 'handoff_secret_detected' });

  // SQLite checkpoint export + restore + anti-split-brain retirement
  const srcDbPath = join(dir, 'src.sqlite');
  const dstDbPath = join(dir, 'dst.sqlite');
  const db = new DatabaseSync(srcDbPath);
  db.exec('CREATE TABLE stored_bytes(key TEXT PRIMARY KEY, value BLOB NOT NULL)');
  db.prepare('INSERT INTO stored_bytes(key, value) VALUES(?, ?)').run('peer-session/device/v1', Buffer.from('identity-payload'));
  db.close();

  const secret = 'b'.repeat(64);
  const exported = await exportSqliteCheckpoint({ devicePath: srcDbPath, outputPath: join(dir, 'cp.clcp'), secret, retireSource: true });
  assert.equal(exported.retiredSource, true);
  await assert.rejects(exportSqliteCheckpoint({ devicePath: srcDbPath, outputPath: join(dir, 'cp2.clcp'), secret }), { code: 'DEVICE_RETIRED_BY_CHECKPOINT' });

  const restored = await restoreSqliteCheckpoint({ inputPath: exported.output, devicePath: dstDbPath, secret });
  assert.equal(restored.restoredEntries, 1);
  const reopened = new DatabaseSync(dstDbPath);
  const row = reopened.prepare('SELECT value FROM stored_bytes WHERE key=?').get('peer-session/device/v1');
  reopened.close();
  assert.equal(Buffer.from(row.value).toString('utf8'), 'identity-payload');
});

test('local Stdio MCP handler and ServerlessHostAdapter execute unified five-step workflows', async () => {
  const ops = new Map();
  const fakeSession = {
    applicationId: '33'.repeat(32),
    deviceId: '44'.repeat(32),
    status: { phase: 'ready', database: 'ready', role: 'coordinator', generation: 'g1', coordinator: '44'.repeat(32), connectedPeers: 0 },
    describe: () => ({ id: 'demo', version: '1', commands: [{ name: 'add' }], queries: [{ name: 'list' }] }),
    async query(name) { return { revision: { generation: 'g1', sequence: ops.size }, value: { name, count: ops.size } }; },
    async command(name, input, { operationId }) {
      const applied = { status: 'applied', outcome: 'accepted', operationId, sequence: ops.size + 1, generation: 'g1', command: name, input };
      ops.set(operationId, applied);
      return { get: async () => applied, applied: async () => applied };
    },
    operations: { get: async id => ops.get(id) ?? null },
  };

  // Stdio MCP
  const init = await handleStdioMcpMessage({ session: fakeSession, mode: 'own' }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'tendriller-local-stdio');
  const batch = await handleStdioMcpMessage({ session: fakeSession, mode: 'own' }, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'command_submit_batch', arguments: { commands: [
      { command: 'add', input: { a: 1 }, operationId: 'stdio-1' },
      { command: 'add', input: { a: 2 }, operationId: 'stdio-2' },
    ] } },
  });
  assert.equal(batch.result.structuredContent.results.length, 2);
  assert.equal(batch.result.structuredContent.results[0].lifecycle, 'applied');

  // ServerlessHostAdapter
  const kv = new Map();
  const adapter = createServerlessHostAdapter({
    applicationId: '33'.repeat(32),
    storage: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, list: async () => [...kv.keys()] },
    authorize: req => req.headers.get('Authorization') === 'Bearer ok',
    openSession: async () => ({ session: fakeSession }),
  });
  const unauth = await adapter.handleRequest(new Request(`https://worker.test/v1/apps/${'33'.repeat(32)}/health`));
  assert.equal(unauth.status, 401);
  const cmdRes = await adapter.handleRequest(new Request(`https://worker.test/v1/apps/${'33'.repeat(32)}/commands`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ok', 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'add', input: { a: 3 }, operationId: 'srv-1' }),
  }));
  assert.equal(cmdRes.status, 200);
  assert.equal((await cmdRes.json()).lifecycle, 'applied');
  const inspectRes = await adapter.handleRequest(new Request(`https://worker.test/v1/apps/${'33'.repeat(32)}/operations/srv-1`, {
    headers: { Authorization: 'Bearer ok' },
  }));
  assert.equal((await inspectRes.json()).lifecycle, 'applied');
});
