import { readFileSync } from 'node:fs';

// An explicit negative pattern never falls back to the Worker on a static 404.
// Exclude only the complete bundled release; historical releases retain R2 fallback.
// Authored files, optional resources and the scoped service worker keep admission.
export function assetRouting(id = JSON.parse(readFileSync(new URL('../server/src/runtime-release.json', import.meta.url), 'utf8')).id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Static routing needs the complete bundled runtime identity');
  return [
    '/*', `!/_tendril/runtime/${id}/*`,
    '!/_tendril/brand/icon-64.png', '!/_tendril/brand/icon-180.png',
    '!/_tendril/brand/logo.png', '!/_tendril/brand/logo.webp',
    '!/_tendril/brand/favicon.ico', '!/favicon.ico',
  ];
}

// Keep custom/error logs at full sampling without a routine record for every
// fetch, WebSocket frame and alarm. Platform aggregate metrics remain available.
export const observability = {
  enabled: true,
  logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false },
};
