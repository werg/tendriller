import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export function browserSqlArchive(root, identity) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = { toolchain: 'fixture', wasmSha256: hash('wasm'), loaderSha256: hash('loader'), wasmBytes: 4 };
  const files = { 'package.json': { name: '@chronolog/peer-session', exports: Object.fromEntries(['.', './browser', './worker', './sql', './sql-browser', './websocket'].map(key => [key, './index.mjs'])) },
    'index.mjs': 'export {};', 'wasm/manifest.json': manifest, 'wasm/sqlite3.wasm': 'wasm', 'wasm/sqlite3.mjs': 'loader', 'wasm/sqlite3-opfs-async-proxy.js': 'proxy' };
  const dir = join(root, 'sql-archive-input');
  const hashes = {};
  for (const [name, value] of Object.entries(files)) {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value);
    mkdirSync(dirname(join(dir, 'package', name)), { recursive: true }); writeFileSync(join(dir, 'package', name), bytes); hashes[name] = hash(bytes);
  }
  writeFileSync(join(dir, 'package/provenance.json'), JSON.stringify({ ...identity, format: 'chronolog-peer-session-package/v1', profile: 'chronolog-crdt-v1', nativeRtc: false, sqlEngines: ['browser'], wasmEngine: manifest, sha256: hashes }));
  const path = join(root, 'sql-browser.tgz'); execFileSync('tar', ['-czf', path, '-C', dir, 'package']);
  rmSync(dir, { recursive: true, force: true });
  return { path, bytes: readFileSync(path), sha256: hash(readFileSync(path)) };
}
