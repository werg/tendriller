import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../lib/preview.mjs';

async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'owned-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<!doctype html><head><title>Authored</title></head><body><script src="./page.mjs" type="module"></script></body>');
  await writeFile(join(root, 'page.mjs'), 'export const value = 1;');
  if (options?.bootstrap) await writeFile(join(root, options.bootstrap), 'export async function openPreview() { throw Error("Supply the owned application session"); }');
  const server = await startServer(root, options); t.after(() => server.stopPreview());
  return { root, server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('static authored preview has no simulated application or hosted data endpoints', async t => {
  const f = await fixture(t), page = await (await fetch(f.origin)).text();
  assert.match(page, /<title>Authored<\/title>/); assert.doesNotMatch(page, /tendrilReady|WebSocket|state_reset/);
  const info = await (await fetch(f.origin + '/_preview/info')).json();
  assert.equal(info.mode, 'authored-files'); assert.equal(info.bootstrap, null);
  for (const path of ['/_tendril/state', '/_tendril/events', '/_tendril/streams', '/_tendril/scopes']) {
    assert.equal((await fetch(f.origin + path)).status, 404);
    assert.equal((await fetch(f.origin + path, { method: 'POST', body: '{}' })).status, 405);
  }
});

test('live preview imports an authored owned-session bootstrap into the same runtime', async t => {
  const f = await fixture(t, { bootstrap: 'application.mjs' }), text = await (await fetch(f.origin)).text();
  assert.match(text, /openPreview/); assert.match(text, /startRuntime/);
  assert.match(text, /application:owned\.application,signals:owned\.signals/);
  assert.doesNotMatch(text, /fixture_event|state_snapshot|stream_subscribe|\/ws/);
  const info = await (await fetch(f.origin + '/_preview/info')).json();
  assert.equal(info.mode, 'owned-application-session');
  assert.equal((await fetch(f.origin + info.publication.base + 'application.mjs')).status, 200);
});

test('canonical reload pins complete edited assets while old graphs retain their exact bytes', async t => {
  const f = await fixture(t);
  await fetch(f.origin);
  const first = await (await fetch(f.origin + '/_preview/info')).json();
  await writeFile(join(f.root, 'page.mjs'), 'export const value = 2;');
  await fetch(f.origin);
  const second = await (await fetch(f.origin + '/_preview/info')).json();
  assert.notEqual(first.publication.id, second.publication.id);
  assert.equal(await (await fetch(f.origin + first.publication.base + 'page.mjs')).text(), 'export const value = 1;');
  assert.equal(await (await fetch(f.origin + second.publication.base + 'page.mjs')).text(), 'export const value = 2;');
});

test('preview refuses fake-data options, missing bootstrap, symlink assets, and closes incomplete connections', async t => {
  const f = await fixture(t);
  await assert.rejects(startServer(f.root, { state: {} }), /Unknown preview option/);
  await assert.rejects(startServer(f.root, { bootstrap: '../outside.mjs' }), /authored relative/);
  await assert.rejects(startServer(f.root, { bootstrap: 'missing.mjs' }), /bootstrap module/);
  await symlink(join(f.root, 'index.html'), join(f.root, 'link.html'));
  await assert.rejects(startServer(f.root), /symlink/);
  const socket = connect(f.server.address().port, '127.0.0.1');
  await new Promise((done, reject) => { socket.once('connect', done); socket.once('error', reject); });
  const closed = new Promise(done => socket.once('close', done));
  await f.server.stopPreview(); await closed;
  assert.equal(socket.destroyed, true);
});
