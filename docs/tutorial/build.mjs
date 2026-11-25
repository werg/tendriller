import { build } from 'esbuild';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { project, readPrivate } from './local.mjs';
const root = fileURLToPath(new URL('.', import.meta.url)), output = new URL('./page/', import.meta.url);
const { handle } = await project(), configuration = await readPrivate('host-configuration.json');
// Only this authored output is publishable. Signers and setup handles stay outside it.
await rm(output, { recursive: true, force: true });
try {
  await mkdir(output);
  await writeFile(new URL('configuration.json', output), JSON.stringify({ applicationId: handle.application.id, page_url: handle.page_url,
    serviceOrigin: new URL(handle.api).origin, pageId: handle.id, executionManifestDigest: configuration.executionManifestDigest }, null, 2) + '\n');
  await copyFile(new URL('./index.html', import.meta.url), new URL('index.html', output));
  await build({ absWorkingDir: root, entryPoints: { page: 'page.mjs', worker: 'worker.mjs' },
    outdir: fileURLToPath(output), bundle: true, splitting: true, format: 'esm', platform: 'browser',
    target: 'es2022', outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]' });
  console.log('Built the complete public page/ graph. Publish before the owner browser key exists.');
} catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
