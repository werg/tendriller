import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Zero DoltLite assets, zero `domain.js` — `sqlite-cas.wasm` ships inside `@chronolog/peer-session` and reducers live in `$reducers`. */
export async function buildPage(context, { root = new URL('./', import.meta.url), bundle } = {}) {
  const output = new URL('./dist/', root);
  await rm(output, { recursive: true, force: true });
  try {
    const prepared = await context.readPrivate('prepared.json');
    if (prepared.applicationId !== context.page.applicationId || prepared.publisherKey !== context.signer.publicKey) {
      throw Error('Resume this exact page preparation; do not initialize a native data root');
    }
    const pageUrl = new URL(context.page.pageUrl);
    if (!['https:', 'http:'].includes(pageUrl.protocol) || pageUrl.username || pageUrl.password || pageUrl.search || pageUrl.hash) {
      throw Error('Invalid retained page URL');
    }
    await mkdir(output, { recursive: true });
    await writeFile(new URL('configuration.json', output), JSON.stringify({
      applicationId: context.page.applicationId,
      page_url: context.page.pageUrl,
    }, null, 2) + '\n');
    await copyFile(new URL('index.html', root), new URL('index.html', output));
    await bundle({
      absWorkingDir: fileURLToPath(root),
      entryPoints: { page: 'page.mjs', worker: 'worker.mjs' },
      outdir: fileURLToPath(output),
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      outExtension: { '.js': '.mjs' },
      chunkNames: 'chunks/[name]-[hash]',
      logLevel: 'warning',
    });
    return fileURLToPath(output);
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw new Error(`SQL page build failed; no publishable dist/ remains. ${cause.message}`, { cause });
  }
}
