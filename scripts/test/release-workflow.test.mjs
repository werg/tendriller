import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
function jobs(text) {
  return Object.fromEntries([...text.slice(text.indexOf('\njobs:')).matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)]
    .map(match => [match[1], match[2]]));
}
const service = workflow('service'), graph = jobs(service);
const needs = job => graph[job].match(/^    needs: \[([^\]]+)\]/m)[1].split(',').map(value => value.trim());

test('trusted publication joins every qualification, and staging/production depend on publication', () => {
  assert.deepEqual(needs('publish').sort(), ['check', 'browser', 'native-owner', 'sql-starter', 'chatgpt-integration', 'artifacts'].sort());
  for (const job of ['publish', 'staging', 'production']) {
    assert.match(graph[job], /github\.ref == 'refs\/heads\/master'/);
    assert.match(graph[job], /github\.event_name == 'push'/);
  }
  for (const job of ['staging', 'production']) assert(needs(job).includes('publish'));
  for (const gate of ['staging_acceptance', 'staging_mcp_qualification']) assert(needs('production').includes(gate));
  assert.match(service, /permissions:\n  contents: read/);
  const release = workflow('release');
  assert.match(release, /workflow_call:/);
  assert.doesNotMatch(release, /^  (push|release|create):/m);
  assert.match(release, /github\.ref == 'refs\/heads\/master'/);
  assert.match(release, /node scripts\/publish-release.mjs refs\/heads\/master/);
});

test('all deployed and browser/native qualified bytes come from one artifact graph', () => {
  assert.equal((graph.artifacts.match(/npm run check\n/g) ?? []).length, 1);
  assert.doesNotMatch(graph.artifacts, /npm run (build|test:consumer|check:release)/);
  for (const job of ['browser', 'native-owner', 'staging', 'production']) {
    assert.match(graph[job], /name: public-packages/);
    assert.match(graph[job], /node scripts\/deployment-bundle.mjs/);
    assert.match(graph[job], /needs.artifacts.outputs.manifest_sha256/);
    assert.doesNotMatch(graph[job], /npm run (build|check)/);
  }
  for (const job of ['staging', 'production']) {
    assert.match(graph[job], /node scripts\/check-published-release.mjs/);
    assert.match(graph[job], /node scripts\/check-deployment-artifacts.mjs/);
    assert.match(graph[job], /wrangler deploy .*--no-bundle/);
    assert.match(graph[job], /STORAGE_SCHEMA|SOURCE_COMMIT/);
  }
  assert.match(graph.browser, /test:first-app -- --first-app-archive/);
  const onboarding = workflow('agent-onboarding');
  assert.match(onboarding, /name: public-packages/);
  assert.doesNotMatch(onboarding, /npm run build|first-app:\n/);
});

test('live qualification reuses the promoted run or immutable public graph', () => {
  const acceptance = workflow('staging-acceptance');
  assert.doesNotMatch(acceptance, /npm run build/);
  assert.match(acceptance, /node scripts\/download-release.mjs/);
  const mcp = workflow('plugin-qualification');
  assert.match(mcp, /github\.ref == 'refs\/heads\/master'/);
  assert.match(mcp, /run-id:.*github.event.workflow_run.id/);
  assert.match(mcp, /node scripts\/download-release.mjs/);
  assert.doesNotMatch(mcp, /npm run (build|release:artifacts)/);
  for (const job of ['staging_acceptance', 'staging_mcp_qualification'])
    assert.match(graph[job], /manifest_sha256:.*needs.artifacts.outputs.manifest_sha256/);
});

test('every checkout in the release qualification graph disables persisted credentials', () => {
  for (const name of ['service', 'release', 'agent-onboarding', 'staging-acceptance', 'plugin-qualification', 'chatgpt-integration']) {
    const checkouts = workflow(name).split('- uses: actions/checkout@v4').slice(1);
    assert(checkouts.length > 0, name);
    for (const checkout of checkouts)
      assert.match(checkout.split(/\n      - /)[0], /persist-credentials: false/, name);
  }
});


test('native owner qualification installs tools dependencies after restoring public packages', () => {
  const job = graph['native-owner'];
  const restore = job.indexOf('run: node scripts/deployment-bundle.mjs');
  const install = job.indexOf('run: npm --prefix tools ci');
  const qualify = job.indexOf('run: npm run test:collaboration:native');
  assert(restore >= 0 && install > restore && qualify > install,
    'The source CLI imports @tendriller/core from tools/node_modules, installed from the restored SDK');
});

test('ChatGPT native and packed-host qualification joins the public graph before publication', () => {
  assert(needs('chatgpt-integration').includes('artifacts'));
  assert(needs('publish').includes('chatgpt-integration'));
  const qualification = workflow('chatgpt-integration');
  assert.match(qualification, /workflow_call:/);
  assert.doesNotMatch(qualification, /^  (push|pull_request|workflow_dispatch):/m);
  assert.match(qualification, /name: public-packages/);
  assert.match(qualification, /node scripts\/deployment-bundle.mjs/);
  assert.match(qualification, /node scripts\/qualify-chatgpt-graph.mjs/);
  assert.doesNotMatch(qualification, /build-release.mjs|build:artifacts|package-peer-session|chronolog-db/);
  assert.match(graph.artifacts, /dist\/tendriller-chatgpt-plugin.zip/);
});
