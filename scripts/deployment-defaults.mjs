import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
const brand = [
  '!/_tendril/brand/icon-64.png', '!/_tendril/brand/icon-180.png',
  '!/_tendril/brand/icon-192.png', '!/_tendril/brand/icon-512.png',
  '!/_tendril/brand/logo.png', '!/_tendril/brand/logo.webp',
  '!/_tendril/brand/favicon.ico', '!/favicon.ico',
];

/** The built runtime identity, read from the build output (or a restored deployment bundle). */
export function builtRuntimeId(base = root) {
  const path = join(base, 'dist/runtime/assets/manifest.json');
  if (!existsSync(path)) throw Error('No built runtime: run npm run build (or restore the deployment bundle) first');
  const { id } = verifyRuntimeManifest(JSON.parse(readFileSync(path, 'utf8')));
  if (!existsSync(join(base, 'server/public/_tendril/runtime', id, 'manifest.json')))
    throw Error(`Built runtime ${id} is missing from server/public; rebuild before routing it statically`);
  return id;
}

// An explicit negative pattern never falls back to the Worker on a static 404.
// Exclude only the complete bundled release; historical releases retain R2 fallback.
// Authored files, optional resources and the scoped service worker keep admission.
// Without a runtime ID (checked-in configs, local development) every runtime path
// reaches the Worker, which serves the bundled graph from ASSETS and older ones from R2.
// scripts/deploy-config.mjs adds the built ID only to the generated deploy config.
export function assetRouting(id) {
  if (id === undefined) return ['/*', ...brand];
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Static routing needs the complete bundled runtime identity');
  return ['/*', `!/_tendril/runtime/${id}/*`, ...brand];
}

// Keep custom/error logs at full sampling without a routine record for every
// fetch, WebSocket frame and alarm. Platform aggregate metrics remain available.
export const observability = {
  enabled: true,
  logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false },
};
