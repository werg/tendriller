import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preflightStaging } from './staging-preflight.mjs';

/** Qualification consumes current operator readiness; it never changes a service mode. */
export async function runStagingAcceptance({ args = process.argv.slice(2), preflight = preflightStaging, spawn: launch = spawn, signals = process } = {}) {
  await preflight();
  let child;
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child?.kill(signal)]));
  for (const [signal, handler] of handlers) signals.on(signal, handler);
  try {
    return await new Promise((resolve, reject) => {
      child = launch(process.execPath, ['node_modules/@playwright/test/cli.js', 'test',
        '--config', 'test/e2e/public.playwright.config.ts', ...args], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
  } finally {
    for (const [signal, handler] of handlers) signals.off(signal, handler);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runStagingAcceptance();
