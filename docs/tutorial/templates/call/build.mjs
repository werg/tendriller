import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

async function bundleDynamicModules(bundle, root, output, folder) {
  const dir = new URL(`./${folder}/`, root);
  if (!existsSync(dir)) return;
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter(item => item.isFile() && /\.(mjs|js)$/.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!entries.length) return;
  const outDir = new URL(`./${folder}/`, output);
  await mkdir(outDir, { recursive: true });
  // Bundle each facet/slot module standalone (splitting: false) so editing one
  // facet changes only its own SHA-256 and triggers a live hot-swap, never a reload.
  for (const item of entries) {
    await bundle({
      absWorkingDir: fileURLToPath(root),
      entryPoints: [`${folder}/${item.name}`],
      outfile: fileURLToPath(new URL(item.name.replace(/\.js$/, '.mjs'), outDir)),
      bundle: true,
      splitting: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    });
  }
}

export async function buildPage(context, { root = new URL('./', import.meta.url), bundle } = {}) {
  const output = new URL('./dist/', root);
  await rm(output, { recursive: true, force: true });
  try {
    const prepared = await context.readPrivate('prepared.json');
    if (prepared.applicationId !== context.page.applicationId || prepared.publisherKey !== context.signer.publicKey) {
      throw Error('Resume preparation for this exact workspace page; no native initialization is required');
    }
    const pageUrl = new URL(context.page.pageUrl);
    if (!['https:', 'http:'].includes(pageUrl.protocol) || pageUrl.username || pageUrl.password || pageUrl.search || pageUrl.hash) {
      throw Error('Invalid public page URL');
    }
    await mkdir(output);
    await writeFile(new URL('configuration.json', output), JSON.stringify({
      applicationId: context.page.applicationId,
      page_url: context.page.pageUrl,
      serviceOrigin: context.service,
      pageId: context.page.id,
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
      assetNames: 'assets/[name]-[hash]',
      loader: { '.wasm': 'file' },
    });
    if (existsSync(new URL('facets.json', root))) {
      await copyFile(new URL('facets.json', root), new URL('facets.json', output));
    }
    await bundleDynamicModules(bundle, root, output, 'facets');
    await bundleDynamicModules(bundle, root, output, 'slots');
    return fileURLToPath(output);
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw new Error(`Page build failed; no publishable dist/ remains. ${cause.message}`, { cause });
  }
}
