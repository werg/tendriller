import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const assets = ['manifest.json', 'sqlite3.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js'];
export async function buildPage(context, { root = new URL('./', import.meta.url), engine = new URL('./engine/', root), bundle, verifyWasmBuild } = {}) {
  const output = new URL('./dist/', root), readPrivate = context.readPrivate;
  // A failed build must never leave a previous publication ready to upload.
  await rm(output, { recursive: true, force: true });
  try {
    const configuration=await readPrivate('host-configuration.json'),prepared=await readPrivate('prepared.json');
    if(prepared.applicationId!==context.page.applicationId||prepared.publisherKey!==context.signer.publicKey||prepared.executionManifestDigest!==configuration.executionManifestDigest)throw Error('Resume this exact page preparation; do not initialize a native data root');
    const pageUrl=new URL(context.page.pageUrl);
    if(!['https:','http:'].includes(pageUrl.protocol)||pageUrl.username||pageUrl.password||pageUrl.search||pageUrl.hash)throw Error('Invalid retained page URL');
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
    await writeFile(new URL('configuration.json', output), JSON.stringify({ applicationId: context.page.applicationId,
      page_url: context.page.pageUrl, executionManifestDigest: configuration.executionManifestDigest }, null, 2) + '\n');
    await copyFile(new URL('index.html', root), new URL('index.html', output));
    await bundle({ absWorkingDir: fileURLToPath(root), entryPoints: { page: 'page.mjs', worker: 'worker.mjs' },
      outdir: fileURLToPath(output), bundle: true, splitting: true, format: 'esm', platform: 'browser',
      target: 'es2022', outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]', logLevel: 'warning' });
    return fileURLToPath(output);
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw new Error(`SQL page build failed; no publishable dist/ remains. Complete init, install the matching --sql-browser package and put its four exact WASM assets in this page’s engine/. ${cause.message}`, { cause });
  }
}
