import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTarGz } from '@tendriller/core/archive';
import { exportSourceHandoff } from '../lib/handoff.mjs';

test('source handoff excludes environment variants, runtime identities and checkpoint bytes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['state', 'data', '.private']) mkdirSync(join(dir, name));
  for (const name of ['.env.production', 'identity.json', 'device.bin', 'backup.clcp', 'state/key.mjs', 'data/application.json', '.private/key.mjs'])
    writeFileSync(join(dir, name), 'private');
  writeFileSync(join(dir, 'page.mjs'), 'export const title = "demo";');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const result = exportSourceHandoff(dir, join(dir, 'handoff.tgz'));
  assert.deepEqual(listTarGz(readFileSync(result.output)).sort(), ['handoff-manifest.json', 'package.json', 'page.mjs']);
});
test('source handoff rejects a credential embedded in authored code', t => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-credential-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'page.mjs'), 'export const secret = "td_a_' + 'a'.repeat(64) + '";');
  assert.throws(() => exportSourceHandoff(dir, join(dir, 'handoff.tgz')), { code: 'handoff_secret_detected' });
});
