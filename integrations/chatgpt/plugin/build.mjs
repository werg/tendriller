import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(process.argv[2] ?? join(root, 'dist/tendriller-chatgpt-plugin.zip'));
const staging = mkdtempSync(join(tmpdir(), 'tendriller-plugin-'));
const timestamp = new Date('2000-01-01T00:00:00Z');
const files = new Map([
  ['plugin.json', join(import.meta.dirname, 'plugin.json')],
  ['mcp.json', join(import.meta.dirname, 'mcp.json')],
  ['assets/icon.png', join(root, 'docs/assets/tendriller-icon-180.png')],
  ['skills/connect-tendriller/SKILL.md', join(import.meta.dirname, 'skills/connect-tendriller/SKILL.md')],
]);

try {
  for (const [name, source] of files) {
    const target = join(staging, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    utimesSync(target, timestamp, timestamp);
  }
  const archive = join(staging, 'plugin.zip');
  execFileSync('zip', ['-q', '-X', archive, ...files.keys()], { cwd: staging, env: { ...process.env, TZ: 'UTC' } });
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(archive, output);
  console.log(output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
