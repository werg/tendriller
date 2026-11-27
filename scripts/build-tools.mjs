import { ARCHIVE_METADATA } from './archive-metadata.mjs';
// Optional Node artifacts consume the built public packages. They are never
// imported by the Worker or the browser runtime.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { assets, manifest as runtimeManifest } from '../tools/preview/lib/preview-bundle.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const out = join(dist, 'tools');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'bin'), { recursive: true });
mkdirSync(join(out, 'lib'), { recursive: true });
const notices = new Map();
const inputs = new Set();

function recordNotices(files) {
  for (const file of Object.keys(files)) {
    const absolute = resolve(root, file).replaceAll('\\', '/');
    const marker = absolute.lastIndexOf('/node_modules/');
    if (marker < 0) continue;
    const parts = absolute.slice(marker + 14).split('/');
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (name.startsWith('@tendriller/')) continue;
    const directory = absolute.slice(0, marker) + '/node_modules/' + name;
    if (!existsSync(join(directory, 'package.json'))) continue;
    const dependency = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const key = `${dependency.name}@${dependency.version}`;
    if (notices.has(key)) continue;
    let names = readdirSync(directory).filter(name => /^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(name));
    if (!names.length) names = readdirSync(directory).filter(name => /^readme(?:\.|$)/i.test(name));
    if (!names.length) throw Error(`No distributed license or notice found for ${key}`);
    notices.set(key, key + '\n' + names.sort().map(name => `${name}\n${readFileSync(join(directory, name), 'utf8')}`).join('\n\n'));
  }
}

const embeddedRuntime = { name: 'target-preview-runtime', setup(builder) {
  builder.onLoad({ filter: /[/\\]preview-bundle\.mjs$/ }, () => ({ loader: 'js', resolveDir: join(root, 'tools'),
    contents: `export const manifest=${JSON.stringify(runtimeManifest)}; export const assets=${JSON.stringify(assets)};`,
  }));
} };
const previewLibrary = { name: 'shared-preview-library', setup(builder) {
  builder.onResolve({ filter: /^\.\.\/lib\/preview\.mjs$/ }, () => ({ path: '../lib/preview.mjs', external: true }));
} };

async function bundle(source, target, plugins = []) {
  const result = await build({ absWorkingDir: root, entryPoints: [join(root, source)], outfile: join(out, target),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning', metafile: true,
    // Native ownership loads the application's own Chronolog and core packages at run time.
    external: ['bufferutil', 'utf-8-validate', '@chronolog/*', '@tendriller/core/native-owner', '@tendriller/core/ipc'], plugins: [embeddedRuntime, ...plugins],
    banner: { js: "import {createRequire as bundleRequire} from 'node:module'; const require=bundleRequire(import.meta.url);" },
  });
  for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
  recordNotices(result.metafile.inputs);
}

await bundle('tools/preview/lib/preview.mjs', 'lib/preview.mjs');
await bundle('tools/cli/lib/pack.mjs', 'lib/pack.mjs');
await bundle('tools/cli/lib/session.mjs', 'lib/session.mjs');
await bundle('tools/cli/lib/workspace.mjs', 'lib/workspace.mjs');
const entries = { tendril: 'cli/bin/tendril.mjs', 'tendril-preview': 'preview/bin/tendril-preview.mjs' };
for (const [name, source] of Object.entries(entries)) await bundle('tools/' + source, 'bin/' + name + '.mjs', [previewLibrary]);
writeFileSync(join(out, 'README.md'), readFileSync(join(root, 'tools/README.md'), 'utf8').replaceAll('../docs/tools/', 'docs/'));
mkdirSync(join(out, 'docs'), { recursive: true });
for (const name of readdirSync(join(root, 'docs/tools')).filter(name => name.endsWith('.md')))
  copyFileSync(join(root, 'docs/tools', name), join(out, 'docs', name));
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), [...notices].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join('\n\n') + '\n');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim().length !== 0;
writeJson(join(out, 'package.json'), { name: '@tendriller/tools', version: pkg.version, type: 'module',
  description: 'Application session, signed publication and browser preview tools for Tendriller', engines: pkg.engines,
  bin: Object.fromEntries(Object.keys(entries).map(name => [name, `bin/${name}.mjs`])),
  exports: { './preview': './lib/preview.mjs', './session': './lib/session.mjs', './pack': './lib/pack.mjs', './workspace': './lib/workspace.mjs' },
  peerDependencies: { '@chronolog/peer-session': '*', '@tendriller/core': pkg.version },
  peerDependenciesMeta: { '@chronolog/peer-session': { optional: true }, '@tendriller/core': { optional: true } },
  tendriller: { contract: runtimeManifest.contract, runtime: runtimeManifest.id, sourceCommit },
});
writeJson(join(dist, 'tools-inputs.json'), [...inputs].sort());
const archive = `tendriller-tools-${pkg.version}.tgz`;
execFileSync('tar', [...ARCHIVE_METADATA, '-czf', join(dist, archive), '-C', out, '.']);
const bytes = readFileSync(join(dist, archive));
writeJson(join(dist, 'tools-manifest.json'), { format: 'tendriller-tools', version: pkg.version, source_commit: sourceCommit,
  source_tree: sourceTree, dirty,
  contract: runtimeManifest.contract, runtime: runtimeManifest.id,
  artifacts: [{ file: archive, sha256: sha256(bytes), size: bytes.length }],
});
console.log(`Built ${basename(archive)} against runtime ${runtimeManifest.id}`);
