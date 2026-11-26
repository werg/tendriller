import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = readdirSync(resolve(root, 'collaboration/test')).filter(name =>
  name.endsWith('.test.mjs') && !name.startsWith('native')).sort();
const result = spawnSync(process.execPath, ['--test', ...files.map(name => `collaboration/test/${name}`)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
