import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createNativeWorkspaceSupervisor } from '@tendriller/core/native-owner';
import { exportWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from '../lib/checkpoint.mjs';
import { openPageDevice, openSharedSigner, openWorkspace, workspacePaths } from '../lib/workspace.mjs';

const run = promisify(execFile);
const cli = process.env.TENDRILLER_TOOLS_TEST_CLI ?? fileURLToPath(new URL('../bin/tendril.mjs', import.meta.url));
const secret = 'a'.repeat(64), passphrase = 'correct horse battery staple';
const SERVICE = 'https://tendriller.test', AGENT = { id: 'ag_' + 'c'.repeat(26), name: 'laptop' }, TOKEN = 'ta_' + 'b'.repeat(32);
const PAGES = { notes: 'aaaaaaaaaaaa', tasks: 'bbbbbbbbbbbb' };
const privateJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

function temporary(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** A workspace with two initialized-like pages: device history, setup records and an effect journal. */
async function workspaceFixture(t) {
  const root = temporary(t, 'checkpoint-source-'), paths = workspacePaths(root);
  const signer = await openSharedSigner(paths.identity, { create: true });
  privateJson(paths.credential, { schemaVersion: 1, service: SERVICE, agent: AGENT, token: TOKEN, publicKey: signer.publicKey, accountState: null });
  writeFileSync(paths.config, JSON.stringify({ schemaVersion: 1, service: SERVICE, agent: AGENT,
    pages: Object.fromEntries(Object.entries(PAGES).map(([slug, id]) => [slug, { id }])) }, null, 2) + '\n');
  for (const [slug, id] of Object.entries(PAGES)) {
    const directory = join(paths.pages, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateJson(join(directory, 'page.json'), { schemaVersion: 1, id, name: slug, page_url: `https://${id}.pages.test/s/x/`,
      application: { id: id[0].repeat(64) }, scopes: [] });
    privateJson(join(directory, 'descriptor.json'), { page: id, epochKey: 'private-' + slug });
    privateJson(join(directory, 'initialized.json'), { at: '2026-11-25T00:00:00.000Z' });
    const device = await openPageDevice({ path: join(directory, 'device.sqlite'), signer, create: true });
    await device.store.put('test-retained/' + slug, new TextEncoder().encode('history of ' + slug));
    await device.close();
  }
  const journal = new DatabaseSync(join(paths.pages, PAGES.notes, 'effects.sqlite'));
  journal.exec("PRAGMA journal_mode=WAL; CREATE TABLE effect(id TEXT PRIMARY KEY, state TEXT); INSERT INTO effect VALUES ('mail-1', 'dispatching')");
  journal.close();
  return { root, paths, signer };
}

async function readHistory(paths, signer, slug) {
  const device = await openPageDevice({ path: join(paths.pages, PAGES[slug], 'device.sqlite'), signer });
  try { return new TextDecoder().decode(await device.store.get('test-retained/' + slug)); }
  finally { await device.close(); }
}

test('a workspace checkpoint moves the agent key, credential and every page, and retires the source', async t => {
  const source = await workspaceFixture(t), outputPath = join(temporary(t, 'checkpoint-file-'), 'move.clcp');
  const exported = await exportWorkspaceCheckpoint({ root: source.root, outputPath, secret });
  assert.equal(exported.retiredSource, true);
  assert.deepEqual(exported.retired, [`page ${PAGES.notes}`, `page ${PAGES.tasks}`, 'the agent signer']);
  assert.deepEqual(exported.pages.map(page => [page.slug, page.device, page.records, page.databases]),
    [['notes', true, 3, ['effects.sqlite']], ['tasks', true, 3, []]]);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  const file = readFileSync(outputPath);
  for (const text of [TOKEN, 'private-notes', 'history of notes']) assert.equal(file.includes(text), false, 'the file is encrypted');

  // The source never resumes: workspace, page devices and the signer all refuse.
  await assert.rejects(openWorkspace({ root: source.root }), { code: 'workspace_retired_by_checkpoint' });
  await assert.rejects(readHistory(source.paths, source.signer, 'notes'), { code: 'DEVICE_RETIRED_BY_CHECKPOINT' });
  await assert.rejects(openSharedSigner(source.paths.identity), { code: 'DEVICE_RETIRED_BY_CHECKPOINT' });
  await assert.rejects(exportWorkspaceCheckpoint({ root: source.root, outputPath: outputPath + '.again', secret }), { code: 'workspace_retired_by_checkpoint' });

  // The target may hold the checkpoint file itself, nothing else.
  const target = temporary(t, 'checkpoint-target-');
  copyFileSync(outputPath, join(target, 'move.clcp'));
  const restored = await restoreWorkspaceCheckpoint({ root: target, inputPath: join(target, 'move.clcp'), secret });
  assert.equal(restored.publicKey, source.signer.publicKey);
  assert.deepEqual(restored.pages.map(page => [page.slug, page.device]), [['notes', true], ['tasks', true]]);
  assert.match(restored.next, /handoff source/u);
  assert.deepEqual(readdirSync(target).sort(), ['.gitignore', '.tendriller', 'move.clcp', 'tendriller.json']);
  const paths = workspacePaths(target);
  assert.deepEqual(readFileSync(paths.config), readFileSync(source.paths.config));
  assert.deepEqual(readFileSync(paths.credential), readFileSync(source.paths.credential));
  assert.equal(statSync(paths.credential).mode & 0o777, 0o600);
  assert.equal(statSync(paths.agent).mode & 0o777, 0o700);
  assert.equal(existsSync(paths.attach), false, 'the local attach binding is regenerated');
  for (const id of Object.values(PAGES))
    for (const name of ['page.json', 'descriptor.json', 'initialized.json'])
      assert.deepEqual(readFileSync(join(paths.pages, id, name)), readFileSync(join(source.paths.pages, id, name)));
  const journal = new DatabaseSync(join(paths.pages, PAGES.notes, 'effects.sqlite'), { readOnly: true });
  try { assert.deepEqual({ ...journal.prepare('SELECT id, state FROM effect').get() }, { id: 'mail-1', state: 'dispatching' }); }
  finally { journal.close(); }

  // Restored page devices open only with the restored signer, which is the registered agent key.
  const workspace = await openWorkspace({ root: target });
  const signer = await workspace.signer();
  assert.equal(signer.publicKey, source.signer.publicKey);
  assert.equal(await readHistory(paths, signer, 'notes'), 'history of notes');
  assert.equal(await readHistory(paths, signer, 'tasks'), 'history of tasks');
  const other = await openSharedSigner(join(temporary(t, 'checkpoint-other-'), 'identity.sqlite'), { create: true });
  await assert.rejects(readHistory(paths, other, 'notes'));
  assert.equal((await workspace.page('tasks')).id, PAGES.tasks);
});

test('a wrong secret or a tampered file restores nothing', async t => {
  const source = await workspaceFixture(t), directory = temporary(t, 'checkpoint-file-'), outputPath = join(directory, 'move.clcp');
  await exportWorkspaceCheckpoint({ root: source.root, outputPath, secret: passphrase });
  const target = join(directory, 'fresh');
  await assert.rejects(restoreWorkspaceCheckpoint({ root: target, inputPath: outputPath, secret: 'wrong passphrase!' }), { code: 'CHECKPOINT_DECRYPT_FAILED' });
  await assert.rejects(restoreWorkspaceCheckpoint({ root: target, inputPath: outputPath, secret }), { code: 'CHECKPOINT_KEY_MISMATCH' });
  assert.equal(existsSync(target), false);
  const tampered = join(directory, 'tampered.clcp'), bytes = readFileSync(outputPath);
  bytes[bytes.length - 40] ^= 1;
  writeFileSync(tampered, bytes);
  mkdirSync(target);
  await assert.rejects(restoreWorkspaceCheckpoint({ root: target, inputPath: tampered, secret: passphrase }), { code: 'CHECKPOINT_DECRYPT_FAILED' });
  assert.deepEqual(readdirSync(target), []);
  const truncated = join(directory, 'truncated.clcp');
  writeFileSync(truncated, readFileSync(outputPath).subarray(0, 20));
  await assert.rejects(restoreWorkspaceCheckpoint({ root: target, inputPath: truncated, secret: passphrase }), { code: 'CHECKPOINT_CORRUPT' });
  assert.deepEqual(readdirSync(target), []);
  const restored = await restoreWorkspaceCheckpoint({ root: target, inputPath: outputPath, secret: passphrase });
  assert.equal(restored.publicKey, source.signer.publicKey);
});

test('restore refuses a non-empty folder and never replaces existing state', async t => {
  const source = await workspaceFixture(t), outputPath = join(temporary(t, 'checkpoint-file-'), 'move.clcp');
  await exportWorkspaceCheckpoint({ root: source.root, outputPath, secret });
  const target = temporary(t, 'checkpoint-target-');
  writeFileSync(join(target, 'notes.txt'), 'keep me');
  await assert.rejects(restoreWorkspaceCheckpoint({ root: target, inputPath: outputPath, secret }), { code: 'CHECKPOINT_TARGET_NOT_EMPTY' });
  assert.deepEqual(readdirSync(target), ['notes.txt']);
  assert.equal(readFileSync(join(target, 'notes.txt'), 'utf8'), 'keep me');
  await assert.rejects(restoreWorkspaceCheckpoint({ root: source.root, inputPath: outputPath, secret }), { code: 'CHECKPOINT_TARGET_NOT_EMPTY' });
});

test('export is refused while the agent program or another device user runs, and nothing is retired', async t => {
  const source = await workspaceFixture(t), outputPath = join(temporary(t, 'checkpoint-file-'), 'move.clcp');
  const supervisor = await createNativeWorkspaceSupervisor({ directory: source.paths.owner, workspaceId: AGENT.id, bindings: [] });
  try { await assert.rejects(exportWorkspaceCheckpoint({ root: source.root, outputPath, secret }), { code: 'AGENT_PROGRAM_RUNNING' }); }
  finally { await supervisor.close(); }
  assert.equal(existsSync(outputPath), false);
  const held = await openPageDevice({ path: join(source.paths.pages, PAGES.tasks, 'device.sqlite'), signer: source.signer });
  try { await assert.rejects(exportWorkspaceCheckpoint({ root: source.root, outputPath, secret }), { code: 'BYTES_STORE_IN_USE' }); }
  finally { await held.close(); }
  assert.equal(existsSync(outputPath), false);
  assert.equal(existsSync(source.paths.retired), false);
  assert.equal(await readHistory(source.paths, source.signer, 'notes'), 'history of notes', 'refused exports leave every device usable');
  writeFileSync(outputPath, 'existing');
  await assert.rejects(exportWorkspaceCheckpoint({ root: source.root, outputPath, secret }), { code: 'CHECKPOINT_OUTPUT_EXISTS' });
  assert.equal(readFileSync(outputPath, 'utf8'), 'existing');
  rmSync(outputPath);
  assert.equal((await exportWorkspaceCheckpoint({ root: source.root, outputPath, secret })).retiredSource, true);
});

test('tendril checkpoint export and restore run inside and into workspaces', async t => {
  const source = await workspaceFixture(t), directory = temporary(t, 'checkpoint-cli-');
  const env = { ...process.env, TENDRIL_WORKSPACE: '', MOVE_SECRET: passphrase, NODE_NO_WARNINGS: '1' };
  const tendril = (cwd, args) => run(process.execPath, [cli, ...args], { cwd, env, timeout: 30_000 });
  await assert.rejects(tendril(join(source.root, '.tendriller'), ['checkpoint', 'export', join(directory, 'x.clcp'), '--device', 'device.sqlite']),
    error => error.code === 64 && /does not accept --device/u.test(error.stderr));
  await assert.rejects(tendril(source.root, ['checkpoint', 'export', join(directory, 'x.clcp')]),
    error => error.code === 64 && /TENDRILLER_CHECKPOINT_SECRET/u.test(error.stderr));
  const exported = JSON.parse((await tendril(join(source.root, '.tendriller'), ['checkpoint', 'export', join(directory, 'move.clcp'), '--secret-env', 'MOVE_SECRET'])).stdout);
  assert.equal(exported.retiredSource, true);
  await assert.rejects(tendril(source.root, ['status']), error => JSON.parse(error.stderr).error.code === 'workspace_retired_by_checkpoint');
  const target = join(directory, 'moved');
  const restored = JSON.parse((await tendril(directory, ['checkpoint', 'restore', join(directory, 'move.clcp'), '--secret-env', 'MOVE_SECRET', '--workspace', target])).stdout);
  assert.equal(restored.workspace, target);
  assert.equal(restored.agent.id, AGENT.id);
  const listed = await (await openWorkspace({ root: target })).pages();
  assert.deepEqual(listed.map(page => [page.slug, page.initialized]), [['notes', true], ['tasks', true]]);
  const usage = (await tendril(directory, ['--help'])).stdout;
  assert.match(usage, /checkpoint export <file> \[--secret-env VAR\]/u);
  assert.doesNotMatch(usage, /--device/u);
});
