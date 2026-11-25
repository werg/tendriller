import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applicationDefinitionDigest } from '@chronolog/peer-session';

export async function buildPage({ root = new URL('./', import.meta.url), project, readPrivate, bundle, definition } = {}) {
  const output = new URL('./page/', root);
  // A failed rebuild must not leave an older graph looking ready to publish.
  await rm(output, { recursive: true, force: true });
  try {
    const { handle } = await project();
    const descriptor = await readPrivate('descriptor.json'), initialized = await readPrivate('initialized.json');
    if (!handle.application?.id || initialized.applicationId !== handle.application.id ||
        descriptor.payload?.applicationId !== handle.application.id || !initialized.deviceId)
      throw Error('Setup records do not identify the same initialized application. Resume npm run init in the original project.');
    if (await applicationDefinitionDigest(definition) !== descriptor.payload.definitionDigest)
      throw Error('The current domain definition differs from the retained initialized descriptor. Restore the original definition for this application; use a fresh project for a different domain. Keep the existing signer, history and descriptor.');
    // This dedicated output is the entire publishable graph. Never publish the
    // project directory: .tendriller contains the handle, signer and bootstrap key.
    await mkdir(output);
    const publicConfiguration = { applicationId: handle.application.id,
      definitionId: definition.id, definitionVersion: definition.version, page_url: handle.page_url,
      serviceOrigin: new URL(handle.api).origin, pageId: handle.id,
      nativeDeviceId: initialized.deviceId, descriptor };
    await writeFile(new URL('configuration.json', output), JSON.stringify(publicConfiguration, null, 2) + '\n');
    await copyFile(new URL('index.html', root), new URL('index.html', output));
    await bundle({ absWorkingDir: fileURLToPath(root), entryPoints: { page: 'page.mjs', worker: 'worker.mjs', 'pairing-worker': 'pairing-worker.mjs' },
      outdir: fileURLToPath(output), bundle: true, splitting: true, format: 'esm', platform: 'browser',
      target: 'es2022', outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]' });
    return fileURLToPath(output);
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw new Error(`Page build failed; no publishable page/ remains. ${cause.message}`, { cause });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { project, readPrivate } = await import('./local.mjs');
    const { definition } = await import('./domain.mjs');
    const { build } = await import('esbuild');
    await buildPage({ project, readPrivate, definition, bundle: build });
    console.log('Built page/. It contains public application configuration and browser code; private project state stays outside it.');
  } catch (error) {
    await rm(new URL('./page/', import.meta.url), { recursive: true, force: true });
    console.error(error.message); process.exitCode = 1;
  }
}
