import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export function browserSqlArchive(root, identity) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = {
    'package.json': {
      name: '@chronolog/peer-session',
      exports: Object.fromEntries(['.', './browser', './worker', './kernel', './websocket'].map(key => [key, './index.mjs'])),
    },
    'index.mjs': 'export {};',
  };
  const dir = join(root, 'sql-archive-input');
  const hashes = {};
  for (const [name, value] of Object.entries(files)) {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value);
    mkdirSync(dirname(join(dir, 'package', name)), { recursive: true });
    writeFileSync(join(dir, 'package', name), bytes);
    hashes[name] = hash(bytes);
  }
  writeFileSync(join(dir, 'package/provenance.json'), JSON.stringify({
    ...identity,
    format: 'chronolog-peer-session-package/v2',
    profile: 'chronolog-crdt-v2',
    zeroNativeBuild: true,
    sha256: hashes,
  }));
  const path = join(root, 'sql-browser.tgz');
  execFileSync('tar', ['-czf', path, '-C', dir, 'package']);
  rmSync(dir, { recursive: true, force: true });
  return { path, bytes: readFileSync(path), sha256: hash(readFileSync(path)) };
}
