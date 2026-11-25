import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { p, worker, browser, createPhysicalSession } from '../../collaboration/test/physical-fixture.mjs';
const definition=p.defineApplication({id:'ergonomics',version:'1',commands:{add:p.defineCommand({description:'Retain one value',input:{type:'object',properties:{a:{type:'integer'}},required:['a'],additionalProperties:false},prepare:value=>p.program(p.emit('value',value))})},queries:{list:p.defineQuery({description:'Read materialized values',input:{type:'null'},read:view=>({count:view.readEvents({topics:['value']}).events.length})})}});

import { packTarGz, unpackTarGz, listTarGz, readTarGzFile } from '../../contract/archive.mjs';
import { createReleaseDownloader, extractVerifiedTarGz } from '../../contract/release-verify.mjs';
import { probeCapabilities, detectProxyEnvironment } from '../../contract/transport-probe.mjs';
import { acquireAtomicLock, resolveUnixSocketPath, resolveWindowsPipePath } from '../../session/ipc.mjs';
import { connectOrStartNativeSession } from '../../session/native.mjs';
import { buildCompositionV2, COMPOSITION_V2_PROFILES } from '../release-composition.mjs';
import { exportSourceHandoff } from '../../tools/cli/lib/handoff.mjs';
import { createServerlessHostAdapter } from '../../contract/serverless.mjs';
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
  let opened=0;
  const openOwner=async()=>{opened++;return worker.createApplicationOwner(await createPhysicalSession({definition,applicationId:appId}));};
  const connect=browser.connectApplicationOwner;
  // 1. Bounded zero-IPC mode
  const boundedDir = join(dir, 'bounded');
  const bounded = await connectOrStartNativeSession({
    directory: boundedDir, profileId: 'p1', openOwner, connect,
    applicationId: appId, bounded: true,
  });
  assert.equal(bounded.mode, 'bounded');
  assert.equal(existsSync(join(boundedDir, 'endpoint.json')), false);
  await bounded.close();

  // 2. Concurrent shared callers over loopback-tcp with verbatim operationId preservation
  const sharedDir = join(dir, 'shared');
  const [first, second] = await Promise.all([
    connectOrStartNativeSession({
      directory: sharedDir, profileId: 'p1', openOwner, connect,
      applicationId: appId, preferredTransport: 'loopback-tcp',
    }),
    connectOrStartNativeSession({
      directory: sharedDir, profileId: 'p1', openOwner, connect,
      applicationId: appId, preferredTransport: 'loopback-tcp',
    }),
  ]);
  assert.equal([first.startedSupervisor, second.startedSupervisor].filter(Boolean).length, 1);
  assert.equal(first.session.identity.publicKey,second.session.identity.publicKey);
  const operation=await first.session.command('add',{a:42},{operationId:'my-verbatim-op-42'});
  assert.equal(operation.stored,true);await operation.materialized();
  assert.equal((await operation.inspect()).operationId,'my-verbatim-op-42');
  assert.equal((await second.session.query('list',null)).value.count,1);
  assert.equal(opened,2,'one explicit bounded owner plus exactly one shared retained owner');
  const owner = first.startedSupervisor ? first : second;
  const peer = first.startedSupervisor ? second : first;
  await peer.detach();
  await owner.close();
});

test('source handoff blocks secrets and excludes device state', async t => {
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


});

test('local Stdio MCP batch acknowledges locally stored operations without conflating materialization or peer retention', async () => {
  const session=await createPhysicalSession({definition,applicationId:'33'.repeat(32)});
  const pages={list:async()=>[{slug:'notes'}],open:async page=>{assert.equal(page,'notes');return {session};}};
  try {
    const init=await handleStdioMcpMessage(pages,{jsonrpc:'2.0',id:1,method:'initialize',params:{}});
    assert.equal(init.result.serverInfo.name,'tendriller-local-stdio');
    const batch=await handleStdioMcpMessage(pages,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'command_submit_batch',arguments:{page:'notes',commands:[
      {command:'add',input:{a:1},operationId:'stdio-1'},{command:'add',input:{a:2},operationId:'stdio-2'},
    ]}}});
    assert.equal(batch.result.structuredContent.results.length,2);
    for(const result of batch.result.structuredContent.results){assert.equal(result.stored,true);assert.equal(result.finalized,false);assert.deepEqual(result.retained,[]);}
    for(const id of ['stdio-1','stdio-2'])assert.equal((await(await session.operations.get(id)).materialized()).outcome,'accepted');
    assert.equal((await session.query('list',null)).value.count,2);
  } finally {await session.close();}
});
test('ServerlessHostAdapter acknowledges stored operations with independent facts and reads them back', async () => {
  const ops = new Map(), id = '33'.repeat(32);
  const inspection = (operationId, input) => ({ applicationId: id, author: 'author', proposalId: 'p'.repeat(64), operationId, stored: true, pending: 'materializer', materialized: null, retained: [], finalized: false, excluded: false, input });
  const fakeSession = {
    applicationId: id, identity: { publicKey: '44'.repeat(32) }, status: { canAuthor: true },
    async query() { return { applicationId: id, revision: { digest: 'a'.repeat(64) }, value: { count: ops.size } }; },
    async command(_name, input, { operationId }) { const state = inspection(operationId, input); ops.set(operationId, state); return { inspect: () => state }; },
    operations: { get: async operationId => ops.has(operationId) ? { inspect: () => ops.get(operationId) } : null },
  };
  const kv = new Map();
  const adapter = createServerlessHostAdapter({
    applicationId: id, withLock: (_id, work) => work(), retainTask: () => {},
    storage: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, list: async () => [...kv.keys()] },
    authorize: req => req.headers.get('Authorization') === 'Bearer ok', openSession: async () => ({ session: fakeSession }),
  });
  const url = path => `https://worker.test/v1/apps/${id}${path}`, headers = { Authorization: 'Bearer ok', 'Content-Type': 'application/json' };
  assert.equal((await adapter.handleRequest(new Request(url('/health')))).status, 401);
  const stored = await adapter.handleRequest(new Request(url('/commands'), { method: 'POST', headers, body: JSON.stringify({ command: 'add', input: { a: 3 }, operationId: 'srv-1' }) }));
  assert.equal(stored.status, 200);
  const body = await stored.json();
  assert.equal(body.submission, 'stored'); assert.equal(body.operation.stored, true); assert.equal(body.operation.materialized, null); assert.equal(body.operation.finalized, false);
  const inspected = await (await adapter.handleRequest(new Request(url('/operations/srv-1'), { headers }))).json();
  assert.equal(inspected.operationId ?? inspected.operation?.operationId, 'srv-1');
});
