import { build } from 'esbuild';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { project, readPrivate } from './local.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = new URL('./page/', import.meta.url);
const { handle } = await project();
const descriptor = await readPrivate('descriptor.json');
const initialized = await readPrivate('initialized.json');
// This dedicated output is the entire publishable graph. Never publish the
// project directory: .tendriller contains the handle, signer and bootstrap key.
await rm(output, { recursive: true, force: true });
await mkdir(output);
const publicConfiguration = { applicationId: handle.application.id, page_url: handle.page_url,
  serviceOrigin: new URL(handle.api).origin, pageId: handle.id,
  nativeDeviceId: initialized.deviceId, descriptor };
await writeFile(new URL('configuration.json', output), JSON.stringify(publicConfiguration, null, 2) + '\n');
await copyFile(new URL('./index.html', import.meta.url), new URL('index.html', output));
await build({ absWorkingDir: root, entryPoints: { page: 'page.mjs', worker: 'worker.mjs', 'pairing-worker': 'pairing-worker.mjs' },
  outdir: fileURLToPath(output), bundle: true, splitting: true, format: 'esm', platform: 'browser',
  target: 'es2022', outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]' });
console.log('Built page/. It contains public application configuration and browser code; private project state stays outside it.');
