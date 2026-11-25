import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { applicationDefinitionDigest } from '@chronolog/peer-session';

const assets = ['manifest.json', 'sqlite3.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js'];
// Build this SQL page into pages/<slug>/dist/: npm run build -- <slug>
export async function buildPage(context, { root = new URL('./', import.meta.url), engine = new URL('./engine/', root), bundle, verifyWasmBuild, definition } = {}) {
  definition ??= (await import('./domain.mjs')).definition;
  verifyWasmBuild ??= (await import('@chronolog/peer-session/sql-browser')).verifyWasmBuild;
  const output = new URL('./dist/', root), readPrivate = context.readPrivate, { page } = context;
  // A failed build must never leave a previous publication ready to upload.
  await rm(output, { recursive: true, force: true });
  try {
    const descriptor = await readPrivate('descriptor.json'), initialized = await readPrivate('initialized.json');
    if (initialized.applicationId !== page.applicationId || descriptor.payload?.applicationId !== page.applicationId || !initialized.deviceId)
      throw Error(`SQL setup records do not identify the same initialized application. Resume npm run init -- ${page.slug}.`);
    if (await applicationDefinitionDigest(definition) !== descriptor.payload.definitionDigest)
      throw Error('The current domain definition differs from the retained initialized descriptor. Restore the original definition for this application; create a new page for a different domain. Keep the existing signer, history and descriptor.');
    const pageUrl = new URL(page.pageUrl);
    if (!['https:', 'http:'].includes(pageUrl.protocol) || pageUrl.username || pageUrl.password || pageUrl.search || pageUrl.hash)
      throw Error('Invalid public page URL in the retained page record.');
    const files = new Map(await Promise.all(assets.map(async name => [name, await readFile(new URL(name, engine))])));
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    const wasm = files.get('sqlite3.wasm');
    if (manifest.wasmSha256 !== createHash('sha256').update(wasm).digest('hex') || manifest.wasmBytes !== wasm.length)
      throw Error('SQL browser engine does not match manifest.json. Restore the exact matching WASM build.');
    if (manifest.loaderSha256 !== createHash('sha256').update(files.get('sqlite3.mjs')).digest('hex'))
      throw Error('SQL browser loader does not match manifest.json. Restore the exact matching engine assets.');
    await verifyWasmBuild(wasm, manifest); // Verify bytes and supported identity with the installed public SQL package.
    await mkdir(new URL('engine/', output), { recursive: true });
    for (const [name, bytes] of files) await writeFile(new URL(`engine/${name}`, output), bytes);
    await writeFile(new URL('configuration.json', output), JSON.stringify({ applicationId: page.applicationId,
      definitionId: definition.id, definitionVersion: definition.version,
      page_url: page.pageUrl, descriptor }, null, 2) + '\n');
    await copyFile(new URL('index.html', root), new URL('index.html', output));
    await bundle({ absWorkingDir: fileURLToPath(root), entryPoints: { page: 'page.mjs', worker: 'worker.mjs' },
      outdir: fileURLToPath(output), bundle: true, splitting: true, format: 'esm', platform: 'browser',
      target: 'es2022', outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]', logLevel: 'warning' });
    return fileURLToPath(output);
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw new Error(`SQL page build failed; no publishable dist/ remains. Complete init, install the matching --sql-browser package and put its four exact WASM assets in pages/${page.slug}/engine/. ${cause.message}`, { cause });
  }
}
