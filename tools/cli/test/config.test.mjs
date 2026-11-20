import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, saveConfig } from '../lib/config.mjs';
import { onboardingDescriptor } from '@tendriller/core/onboarding';
import { onboardingGuide } from '../lib/guide.mjs';

test('saving and reopening the page handle preserves its independent application identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tendril-handle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { TENDRIL_CONFIG_DIR: root }, application = { id: 'b'.repeat(64) };
  const saved = saveConfig({ id: 'page-id', name: 'Shared work', application,
    api: 'https://example.com/api/t/page-id', token: 'fixture-token' }, 'shared-work', env);
  assert.deepEqual(JSON.parse(await readFile(saved.path, 'utf8')).application, application);
  assert.deepEqual(resolveConfig({ tendril: saved.name }, env).application, application);
  if (process.platform !== 'win32') assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
});

test('guide uses the chosen service origin for all hosted links and validates public origins', () => {
  const guide = onboardingGuide({}, { TENDRIL_SERVER: 'https://staging.example.com/' });
  assert.deepEqual(guide.onboarding, onboardingDescriptor('https://staging.example.com'));
  assert.equal(guide.mcp_guide, guide.onboarding.documentation.mcp);
  assert.deepEqual(guide.workflow, guide.onboarding.workflow);
  assert.equal(guide.workflow[3].id, 'configure');
  for (const key of ['start_here', 'agent_guide', 'troubleshooting', 'service_descriptor'])
    assert.equal(new URL(guide[key]).origin, 'https://staging.example.com');
  assert.equal(onboardingGuide({ server: 'https://branch.example.com' }, { TENDRIL_SERVER: 'https://ignored.example.com' }).service,
    'https://branch.example.com');
  for (const server of ['http://example.com', 'https://example.com/page', 'https://example.com/?token=secret', 'https://example.com/#page', 'file:///tmp/service'])
    assert.throws(() => onboardingGuide({ server }, {}), /service origin/);
});
