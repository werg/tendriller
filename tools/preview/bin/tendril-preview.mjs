#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, intFlag } from '../../cli/lib/args.mjs';
import { startServer, preview } from '../lib/preview.mjs';

const usage = 'Usage: tendril-preview <directory> [--bootstrap authored/session.mjs] [--headless] [--steps actions.json] [--out screenshot.png] [--wait-ms N] [--desktop] [--headed] [--playwright-path MODULE]';
async function main() {
  const { cmd: directory, args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || directory === 'help') { console.log(usage); return; }
  if (!directory || args.length) throw Error(usage);
  for (const key of Object.keys(flags)) if (!['bootstrap', 'headless', 'steps', 'out', 'wait-ms', 'desktop', 'headed', 'playwright-path'].includes(key)) throw Error(`Unknown option --${key}`);
  const waitMs = intFlag(flags['wait-ms'], 'wait-ms', 0);
  if (waitMs < 0 || waitMs > 30_000) throw Error('--wait-ms must be between 0 and 30000');
  if (flags.headless) {
    const result = await preview(directory, { bootstrap: flags.bootstrap, out: flags.out, waitMs,
      desktop: !!flags.desktop, headed: !!flags.headed, playwrightPath: flags['playwright-path'],
      steps: flags.steps ? JSON.parse(readFileSync(flags.steps, 'utf8')) : [] });
    console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1; return;
  }
  if (flags.steps || flags.out || flags['wait-ms'] || flags.headed || flags.desktop) throw Error('Browser actions and screenshots require --headless');
  const server = await startServer(directory, flags.bootstrap ? { bootstrap: flags.bootstrap } : {});
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, directory: resolve(directory),
    mode: flags.bootstrap ? 'owned-application-session' : 'authored-files' }));
  const stop = () => { void server.stopPreview(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(error => { console.error(JSON.stringify({ error: { code: 'preview_failed', message: error.message } })); process.exitCode = 1; });
