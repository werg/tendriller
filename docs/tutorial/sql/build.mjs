import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readPrivate } from './local.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'page');
mkdirSync(out, { recursive: true });
copyFileSync(join(here, 'index.html'), join(out, 'index.html'));
await build({
  entryPoints: { page: join(here, 'page.mjs'), worker: join(here, 'worker.mjs') },
  outdir: out,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});
try {
  const handle = await readPrivate('handle.json');
  const descriptor = await readPrivate('descriptor.json');
  writeFileSync(join(out, 'configuration.json'), JSON.stringify({
    page_url: handle.page_url,
    applicationId: handle.application.id,
    descriptor,
  }, null, 2) + '\n');
} catch {
  // Allow static preview build before setup/init.
}
console.log(JSON.stringify({ built: out, files: ['index.html', 'page.mjs', 'worker.mjs'] }));
