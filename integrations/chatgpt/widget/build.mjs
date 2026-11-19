import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('./app.mjs', import.meta.url))],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, minify: true });
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = await readFile(new URL('./template.html', import.meta.url), 'utf8');
await writeFile(new URL('./index.html', import.meta.url), template.replace('<!-- WIDGET_BUNDLE -->', `<script type="module">${script}</script>`));
