import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationPin } from '../test-contrib-integration.mjs';

function fixture() {
  const lock = { format: 'tendriller-composition', contract: 2, core: { version: '1.0.0', runtime: 'runtime-id' },
    workflow: { version: '1.2.0', source_commit: 'a'.repeat(40), sha256: 'b'.repeat(64),
      url: 'https://github.com/example/optional-workflows/releases/download/v1.2.0/workflows.tgz' } };
  return { lock, pairing: { ...structuredClone(lock), format: 'tendriller-release-pair' } };
}

test('integration derives its public source repository and exact commit from the verified pairing', () => {
  const { lock, pairing } = fixture();
  assert.deepEqual(integrationPin(lock, pairing), {
    repository: 'https://github.com/example/optional-workflows.git', commit: 'a'.repeat(40),
  });
});

test('integration refuses a stale composed artifact or mismatched source identity', () => {
  for (const [field, value] of [['sha256', 'c'.repeat(64)], ['source_commit', 'c'.repeat(40)], ['version', '1.3.0']]) {
    const { lock, pairing } = fixture(); pairing.workflow[field] = value;
    assert.throws(() => integrationPin(lock, pairing), /Rebuild the service/);
  }
  const { lock, pairing } = fixture(); pairing.core.runtime = 'different-runtime';
  assert.throws(() => integrationPin(lock, pairing), /Rebuild the service/);
});

test('integration does not substitute a moving source ref or an unrelated artifact host', () => {
  for (const source_commit of ['main', 'v1.2.0', undefined]) {
    const { lock, pairing } = fixture(); lock.workflow.source_commit = pairing.workflow.source_commit = source_commit;
    assert.throws(() => integrationPin(lock, pairing), /exact public source commit/);
  }
  for (const url of ['https://example.com/team/repo/releases/download/v1/archive.tgz', 'https://github.com/team/repo/tree/main',
    'https://user:password@github.com/team/repo/releases/download/v1/archive.tgz']) {
    const { lock, pairing } = fixture(); lock.workflow.url = pairing.workflow.url = url;
    assert.throws(() => integrationPin(lock, pairing), /public GitHub release repository/);
  }
});
