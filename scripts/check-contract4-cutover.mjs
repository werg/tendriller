import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const config = process.argv[2];
if (!/^server\/wrangler\.(staging|production)\.jsonc$/.test(config ?? ''))
  throw Error('Pass a canonical staging or production Wrangler config');
const output = execFileSync('npx', ['wrangler', 'd1', 'execute', 'ACCOUNTS', '--remote', '--config', config,
  '--command', 'SELECT id FROM contract4_cutover_pending WHERE id=1', '--json'], { encoding: 'utf8' });
const result = JSON.parse(output);
if (!Array.isArray(result) || result.length !== 1 || result[0].success !== true || !Array.isArray(result[0].results))
  throw Error('Could not verify the remote Contract 4 cutover marker');
const needed = result[0].results.length === 1 && result[0].results[0].id === 1;
if (!needed && result[0].results.length) throw Error('Unexpected Contract 4 cutover marker');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
console.log(`Contract 4 namespace cutover ${needed ? 'required' : 'already completed'}`);
