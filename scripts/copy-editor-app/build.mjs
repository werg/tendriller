import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the genuine Tendriller copy-editor page into `dist/`.
 * Renders Tendriller's actual live homepage, platform pages, and sign-in page
 * from `server/src/` + `server/src/site-copy.json` with `{ editable: true }`,
 * copies brand assets into `dist/brand/`, and bundles `page.mjs`, `worker.mjs`,
 * and `domain.js`.
 */
export async function buildPage(context, { root = new URL('./', import.meta.url), bundle } = {}) {
  const output = new URL('./dist/', root);
  await rm(output, { recursive: true, force: true });
  try {
    const config = await context.readPrivate('host-configuration.json');
    const prepared = await context.readPrivate('prepared.json');
    if (
      prepared.applicationId !== context.page.applicationId ||
      prepared.publisherKey !== context.signer.publicKey ||
      prepared.executionManifestDigest !== config.executionManifestDigest
    ) {
      throw Error('Resume preparation for this exact workspace page; no native initialization is required');
    }
    const pageUrl = new URL(context.page.pageUrl);
    if (!['https:', 'http:'].includes(pageUrl.protocol) || pageUrl.username || pageUrl.password || pageUrl.search || pageUrl.hash) {
      throw Error('Invalid public page URL');
    }

    const repoRoot = process.env.TENDRILLER_REPO_ROOT
      ? resolve(process.env.TENDRILLER_REPO_ROOT)
      : resolve(fileURLToPath(root), '../../../..');
    const displayOrigin = (process.env.TENDRILLER_COPY_DISPLAY_ORIGIN || 'https://tendriller.dev').replace(/\/+$/, '');
    const displayHost = new URL(displayOrigin).host;

    // Compile live site renderers directly from the repo's server/src/*.ts + site-copy.json.
    const siteBundle = await bundle({
      stdin: {
        contents: `
          export { landingPage } from "./server/src/landing.ts";
          export { AGENT_PLATFORMS, agentPlatformHtml, agentPlatformIndexHtml } from "./server/src/agent-platforms.ts";
          export { signInBody } from "./server/src/accounts/auth.ts";
          export { renderShell } from "./server/src/accounts/ui.ts";
        `,
        resolveDir: repoRoot,
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    const mod = await import('data:text/javascript;base64,' + Buffer.from(siteBundle.outputFiles[0].text).toString('base64'));
    const rewriteBrand = (html) => html.replaceAll('/_tendril/brand/', './brand/');

    const pages = [
      { path: '/', label: 'Home', html: rewriteBrand(mod.landingPage(displayOrigin, { editable: true })) },
      { path: '/agents', label: 'Platforms index', html: rewriteBrand(mod.agentPlatformIndexHtml(displayOrigin, { editable: true })) },
      ...mod.AGENT_PLATFORMS.map((p) => ({
        path: `/agents/${p.slug}`,
        label: p.name,
        html: rewriteBrand(mod.agentPlatformHtml(p.slug, displayOrigin, { editable: true })),
      })),
      { path: '/auth', label: 'Sign in', html: rewriteBrand(mod.renderShell({ title: 'Sign in', body: mod.signInBody('/dashboard', true) })) },
    ];

    await mkdir(output, { recursive: true });
    await mkdir(new URL('./brand/', output), { recursive: true });
    const brandSrc = join(repoRoot, 'server/public/_tendril/brand');
    for (const asset of ['logo.webp', 'logo.png', 'icon-64.png', 'icon-180.png']) {
      const from = join(brandSrc, asset);
      if (existsSync(from)) await copyFile(from, new URL(`./brand/${asset}`, output));
    }

    await writeFile(new URL('site-pages.json', output), JSON.stringify({
      displayOrigin,
      displayHost,
      pages,
    }));

    await writeFile(
      new URL('configuration.json', output),
      JSON.stringify({
        applicationId: context.page.applicationId,
        page_url: context.page.pageUrl,
        serviceOrigin: context.service,
        pageId: context.page.id,
        agentPublicKey: context.signer.publicKey,
      }, null, 2) + '\n',
    );

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
    });
    return fileURLToPath(output);
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw new Error(`Page build failed; no publishable dist/ remains. ${cause.message}`, { cause });
  }
}
