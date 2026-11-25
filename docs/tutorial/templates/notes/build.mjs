// Build this page's publishable graph into pages/<slug>/dist/: npm run build -- <slug>
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applicationDefinitionDigest } from '@chronolog/peer-session';
import { definition as notes } from './domain.mjs';

export async function buildPage(context, { root = new URL('./', import.meta.url), bundle, definition = notes } = {}) {
  const output = new URL('./dist/', root), { page } = context;
  // A failed rebuild must not leave an older graph looking ready to publish.
  await rm(output, { recursive: true, force: true });
  try {
    const descriptor = await context.readPrivate('descriptor.json'), initialized = await context.readPrivate('initialized.json');
    if (initialized.applicationId !== page.applicationId || descriptor.payload?.applicationId !== page.applicationId || !initialized.deviceId)
      throw Error(`Setup records do not identify the same initialized application. Resume npm run init -- ${page.slug}.`);
    if (await applicationDefinitionDigest(definition) !== descriptor.payload.definitionDigest)
      throw Error('The current domain definition differs from the retained initialized descriptor. Restore the original definition for this page; create a new page for a different domain. Keep the existing device, history and descriptor.');
    // This dedicated output is the entire publishable graph. Never publish the
    // workspace: .tendriller/ holds the agent credential, signer and page records.
    await mkdir(output);
    const publicConfiguration = { applicationId: page.applicationId,
      definitionId: definition.id, definitionVersion: definition.version, page_url: page.pageUrl,
      serviceOrigin: context.service, pageId: page.id,
      nativeDeviceId: initialized.deviceId, descriptor };
    await writeFile(new URL('configuration.json', output), JSON.stringify(publicConfiguration, null, 2) + '\n');
    await copyFile(new URL('index.html', root), new URL('index.html', output));
    await bundle({ absWorkingDir: fileURLToPath(root), entryPoints: { page: 'page.mjs', worker: 'worker.mjs', 'pairing-worker': '../../shared/pairing-worker.mjs' },
      outdir: fileURLToPath(output), bundle: true, splitting: true, format: 'esm', platform: 'browser',
      target: 'es2022', outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]' });
    return fileURLToPath(output);
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw new Error(`Page build failed; no publishable dist/ remains. ${cause.message}`, { cause });
  }
}
