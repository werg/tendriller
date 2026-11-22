import config from './playwright.config';

// These tests require a combined SQL package and its matching WASM artifact.
// Keep the ordinary events-only browser gate independent of that capability.
export default { ...config, testMatch: ['browser-sql-opening.spec.ts', 'sql-tutorial.spec.ts'], timeout: 120_000,
  webServer: { ...config.webServer, command: 'node scripts/e2e-server.mjs --entry dist/engine/worker.mjs --no-bundle' } };
