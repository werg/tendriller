import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ARCHIVE_METADATA } from '../archive-metadata.mjs';

test('release archives preserve executable intent while normalizing checkout and umask permissions', t => {
  const root = mkdtempSync(join(tmpdir(), 'release-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archives = [];
  for (const [index, directoryMode, fileMode, executableMode] of [[0, 0o755, 0o644, 0o755], [1, 0o775, 0o664, 0o775], [2, 0o700, 0o600, 0o700]]) {
    const input = join(root, 'source-' + index), output = join(root, index + '.tgz');
    mkdirSync(input); mkdirSync(join(input, 'bin'));
    writeFileSync(join(input, 'package.json'), '{"name":"same-public-package"}\n');
    writeFileSync(join(input, 'bin/run.mjs'), '#!/usr/bin/env node\n');
    chmodSync(input, directoryMode); chmodSync(join(input, 'bin'), directoryMode);
    chmodSync(join(input, 'package.json'), fileMode); chmodSync(join(input, 'bin/run.mjs'), executableMode);
    execFileSync('tar', [...ARCHIVE_METADATA, '-czf', output, '-C', input, '.']);
    archives.push(readFileSync(output));
    const listing = execFileSync('tar', ['-tvzf', output], { encoding: 'utf8' });
    assert.match(listing, /-rwxr-xr-x.*\.\/bin\/run\.mjs/);
    assert.match(listing, /-rw-r--r--.*\.\/package\.json/);
  }
  assert.deepEqual(archives[0], archives[1]);
  assert.deepEqual(archives[0], archives[2]);
});
