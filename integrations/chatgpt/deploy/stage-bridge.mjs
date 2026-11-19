import { mkdir, copyFile, chmod, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync, backup } from 'node:sqlite';
import { absolutePath, within, privateFile, json, fail } from './common.mjs';
import { verifyRelease } from './preflight.mjs';

const runtimeFiles = new Set(['package.json', 'domain.mjs', 'projection.mjs', 'session.mjs', 'bridge-session.mjs', 'local.mjs', 'private-records.mjs']);

/** Snapshot one explicitly stopped dedicated device; never copy creator state. */
export async function stageBridge({ source, release, destination, expectedBridgeKey, sourceStopped = false }) {
  [source, release, destination].forEach(value => absolutePath(value));
  if (sourceStopped !== true) fail('DEPLOYMENT_STOP_SOURCE_DEVICE_FIRST');
  if (!/^[a-f0-9]{64}$/u.test(expectedBridgeKey ?? '')) fail('DEPLOYMENT_VERIFIED_BRIDGE_PUBLIC_KEY_REQUIRED');
  if (within(source, destination) || within(destination, source) || within(release, destination)) fail('DEPLOYMENT_STAGING_PATHS_MUST_BE_SEPARATE');
  const manifestPath = join(release, 'RELEASE.json'); await verifyRelease(manifestPath);
  const manifest = await json(manifestPath), from = join(source, '.tendriller');
  for (const name of ['handle.json', 'descriptor.json', 'bridge-device.sqlite']) await privateFile(join(from, name));
  const handle = await json(join(from, 'handle.json')), descriptor = await json(join(from, 'descriptor.json'));
  if (!/^[a-f0-9]{64}$/u.test(descriptor.payload?.applicationId ?? '') || descriptor.payload.applicationId !== handle.application?.id) fail('DEPLOYMENT_APPLICATION_SCOPE_MISMATCH');
  const files = Object.keys(manifest.files).filter(name => name.startsWith('bridge-template/'));
  if (![...runtimeFiles].every(name => files.includes(`bridge-template/${name}`)) ||
      !files.includes('bridge-template/node_modules/@chronolog/peer-session/native.mjs') ||
      !files.includes('bridge-template/node_modules/@tendriller/core/package.json')) fail('DEPLOYMENT_BRIDGE_TEMPLATE_INCOMPLETE');
  await mkdir(destination, { mode: 0o700 });
  for (const name of files) {
    const local = relative('bridge-template', name);
    if (!runtimeFiles.has(local) && !local.startsWith('node_modules/@chronolog/peer-session/') && !local.startsWith('node_modules/@tendriller/core/')) continue;
    const target = join(destination, local); await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    await copyFile(join(release, name), target); await chmod(target, 0o600);
  }
  const privateDirectory = join(destination, '.tendriller'); await mkdir(privateDirectory, { mode: 0o700 });
  // These are the only imported control records. initial-input.json, creator
  // device.sqlite, enrollment journals and any unrelated files stay behind.
  for (const name of ['handle.json', 'descriptor.json']) {
    await copyFile(join(from, name), join(privateDirectory, name)); await chmod(join(privateDirectory, name), 0o600);
  }
  const sourceDatabase = new DatabaseSync(join(from, 'bridge-device.sqlite'), { readOnly: true });
  const devicePath = join(privateDirectory, 'bridge-device.sqlite');
  try { await backup(sourceDatabase, devicePath); } finally { sourceDatabase.close(); }
  await chmod(devicePath, 0o600);
  const { openNativeDevice } = await import(pathToFileURL(join(destination, 'node_modules/@chronolog/peer-session/native.mjs')).href);
  const device = await openNativeDevice({ path: devicePath });
  try { if (device.identity.publicKey !== expectedBridgeKey) fail('DEPLOYMENT_BRIDGE_IDENTITY_MISMATCH'); }
  finally { await device.close(); }
  const result = { format: 'tendriller-bridge-stage/v1', applicationId: descriptor.payload.applicationId,
    publicKey: expectedBridgeKey, coreSource: manifest.core.source, chronologSource: manifest.chronolog.source,
    destination, staged: true, deployed: false };
  await writeFile(join(destination, 'STAGED.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, release: { type: 'string' }, destination: { type: 'string' },
      'expected-bridge-key': { type: 'string' }, 'source-stopped': { type: 'boolean', default: false } } });
    console.log(JSON.stringify(await stageBridge({ source: values.source, release: values.release, destination: values.destination,
      expectedBridgeKey: values['expected-bridge-key'], sourceStopped: values['source-stopped'] })));
  } catch (error) { console.error(error.code ?? 'DEPLOYMENT_STAGING_FAILED'); process.exitCode = 1; }
}
