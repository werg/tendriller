import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const wrangler = ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'ACCOUNTS', '--remote',
  '--config', 'server/wrangler.staging.jsonc', '--json'];
function execute(sql) {
  return JSON.parse(execFileSync(process.execPath, [...wrangler, '--command', sql],
    { encoding: 'utf8', timeout: 30_000 }))[0];
}

const mode = execute('SELECT mode FROM service_state WHERE id=1').results[0]?.mode;
if (!['open', 'creation_paused'].includes(mode)) throw new Error('Staging must be open or paused for new pages');
let child, interrupted;
function interrupt(signal) {
  interrupted ??= signal;
  child?.kill(signal);
}
const interruptHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => interrupt(signal)]));
for (const [signal, handler] of interruptHandlers) process.on(signal, handler);
let opened = false;
try {
  if (mode === 'creation_paused') {
    opened = execute("UPDATE service_state SET mode='open' WHERE id=1 AND mode='creation_paused'").meta.changes === 1;
    if (!opened) throw new Error('Staging mode changed before the test could start');
  }
  const result = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test',
      '--config', 'test/e2e/public.playwright.config.ts', ...process.argv.slice(2)], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  process.exitCode = result;
} finally {
  for (const [signal, handler] of interruptHandlers) process.off(signal, handler);
  if (opened) execute("UPDATE service_state SET mode='creation_paused' WHERE id=1 AND mode='open'");
}
