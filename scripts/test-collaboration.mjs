import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const supportsSqliteAssertions = Number(process.versions.node.split('.')[0]) >= 24;
// Node 22.15's experimental node:sqlite swallows JS UDF exceptions, including
// the test shim for chronolog_assert. This harness runs on the Node 24 matrix;
// actual Chronolog native/WASM execution has independent public-consumer gates.
// Unix owner/process-death tests are mandatory in the separate Node 24 IPC job.
const files = readdirSync(resolve(root, 'collaboration/test')).filter(name =>
  name.endsWith('.test.mjs') && !name.startsWith('native') &&
  (supportsSqliteAssertions || name !== 'domain.test.mjs')).sort();
if (!supportsSqliteAssertions) console.log('Portable collaboration checks; SQL assertion harness runs in the required Node 24 matrix.');
const result = spawnSync(process.execPath, ['--test', ...files.map(name => `collaboration/test/${name}`)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
