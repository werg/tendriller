import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const workflow = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
function jobs(text) {
  return Object.fromEntries([...text.slice(text.indexOf('\njobs:')).matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)]
    .map(match => [match[1], match[2]]));
}
const service = workflow('service'), graph = jobs(service);
const needs = job => graph[job].match(/^    needs: \[([^\]]+)\]/m)[1].split(',').map(value => value.trim());

// Evaluate the actual workflow's string paths, comparisons and || expressions.
// Empty optional properties model GitHub's missing-property fallback for pushes.
function concurrency(name, github) {
  const block = workflow(name).match(/^concurrency:\n((?:  .*\n)+)/m)?.[1];
  assert(block, `${name} must declare workflow concurrency`);
  return Object.fromEntries([...block.matchAll(/^  (group|cancel-in-progress): (.+)$/gm)]
    .map(([, key, value]) => [key, value.replace(/\$\{\{(.+?)\}\}/g,
      (_, expression) => String(runInNewContext(expression, { github })))]));
}
function trigger({ event = 'push', branch = 'preview/example', number = 93,
  sourceRepo = 'werg/tendriller', sha = 'a'.repeat(40) } = {}) {
  const pull = event === 'pull_request';
  return {
    repository: 'werg/tendriller', event_name: event, sha,
    ref: pull ? `refs/pull/${number}/merge` : `refs/heads/${branch}`,
    ref_name: pull ? `${number}/merge` : branch, head_ref: pull ? branch : '',
    event: { pull_request: { head: { sha, repo: { full_name: pull ? sourceRepo : '' } } } },
  };
}

test('branch and PR qualification cannot cancel each other at the same source commit', () => {
  assert.match(service, /on:\n  push:\n    branches: \['\*\*'\]\n  pull_request:\n  workflow_dispatch:/);
  const push = trigger(), pull = trigger({ event: 'pull_request' });
  for (const name of ['service', 'agent-onboarding']) {
    const branch = concurrency(name, push), pr = concurrency(name, pull);
    assert.notEqual(branch.group, pr.group, `${name}: branch qualification must survive its PR event`);
    assert.equal(branch['cancel-in-progress'], 'true');
    assert.equal(pr['cancel-in-progress'], 'true');
    assert.equal(concurrency(name, trigger({ sha: 'b'.repeat(40) })).group, branch.group);
    assert.equal(concurrency(name, trigger({ event: 'pull_request', sha: 'b'.repeat(40) })).group, pr.group);
    assert.notEqual(concurrency(name, trigger({ event: 'pull_request', number: 94 })).group, pr.group);
    assert.notEqual(concurrency(name, trigger({ event: 'pull_request', number: 95, sourceRepo: 'other/tendriller' })).group, pr.group);
  }
  assert.notEqual(concurrency('service', push).group, concurrency('agent-onboarding', push).group);
  for (const name of ['check', 'artifacts', 'browser', 'feedback-qualification', 'native-owner', 'sql-starter', 'network-qualification'])
    assert.doesNotMatch(graph[name], /^    if:/m, `${name} must qualify both event contexts`);
});

test('master push and manual promotion stay serialized without PR cancellation', () => {
  const master = concurrency('service', trigger({ branch: 'master' }));
  assert.equal(master['cancel-in-progress'], 'false');
  assert.deepEqual(concurrency('service', trigger({ branch: 'master', event: 'workflow_dispatch' })), master);
  const pull = concurrency('service', trigger({ branch: 'master', event: 'pull_request' }));
  assert.notEqual(pull.group, master.group, 'a PR from master must not cancel a trusted promotion');
  assert.equal(pull['cancel-in-progress'], 'true');
});

test('trusted publication joins every qualification, and staging/production depend on publication', () => {
  assert.deepEqual(needs('publish').sort(), ['check', 'browser', 'feedback-qualification', 'native-owner', 'sql-starter', 'artifacts'].sort());
  for (const job of ['publish', 'staging', 'production']) {
    assert.match(graph[job], /github\.ref == 'refs\/heads\/master'/);
    assert.match(graph[job], /github\.event_name == 'push'/);
  }
  for (const job of ['staging', 'production']) assert(needs(job).includes('publish'));
  assert(needs('production').includes('staging_acceptance'));
  // Temporarily reported, not a production gate (see service.yml).
  assert(!needs('production').includes('staging_mcp_qualification'));
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
  for (const name of ['service', 'release', 'agent-onboarding', 'staging-acceptance', 'plugin-qualification', 'network-qualification']) {
    const checkouts = workflow(name).split('- uses: actions/checkout@v4').slice(1);
    assert(checkouts.length > 0, name);
    for (const checkout of checkouts)
      assert.match(checkout.split(/\n      - /)[0], /persist-credentials: false/, name);
  }
});

test('real packet-fault application qualification binds the immutable graph before publication', () => {
  assert.deepEqual(needs('network-qualification'), ['artifacts']);
  // Temporarily reported, not a publish gate, until relay fallback passes (see service.yml).
  assert(!needs('publish').includes('network-qualification'));
  assert.match(graph['network-qualification'], /manifest_sha256:.*needs.artifacts.outputs.manifest_sha256/);
  const qualification = workflow('network-qualification');
  assert.match(qualification, /name: public-packages/);
  assert.match(qualification, /EXPECTED_MANIFEST_SHA256/);
  assert.match(qualification, /JSON.parse\(b\).source_commit,s/);
  assert.match(qualification, /--artifact-root.*--profile suite/);
  assert.doesNotMatch(qualification, /npm run (build|check)|wrangler deploy|secrets: inherit/);
  assert.match(qualification, /contents: read/);
  assert.match(qualification, /actions: read/);
  const bind = qualification.indexOf('name: Bind the restored graph');
  const install = qualification.indexOf('run: npm ci --ignore-scripts');
  const restore = qualification.indexOf('run: node scripts/deployment-bundle.mjs');
  const container = qualification.indexOf('run: node test/e2e/network-qualification/run.mjs');
  assert(bind >= 0 && install > bind && restore > install && container > restore,
    'Flat CI archives must restore server/public before mounting the source tree read-only');
  assert.match(qualification.slice(restore, container), /TENDRILLER_EXPECTED_MANIFEST_SHA256:.*inputs.manifest_sha256/);
});


test('native owner qualification installs tools dependencies after restoring public packages', () => {
  const job = graph['native-owner'];
  const restore = job.indexOf('run: node scripts/deployment-bundle.mjs');
  const install = job.indexOf('run: npm --prefix tools ci');
  const qualify = job.indexOf('run: npm run test:collaboration:native');
  assert(restore >= 0 && install > restore && qualify > install,
    'The source CLI imports @tendriller/core from tools/node_modules, installed from the restored SDK');
  assert.match(graph.artifacts, /dist\/tendriller-chatgpt-plugin.zip/);
});

test('focused live feedback qualification uses the sealed graph and gates publication', () => {
  const feedback = graph['feedback-qualification'];
  assert.deepEqual(needs('feedback-qualification'), ['artifacts']);
  assert.ok(needs('publish').includes('feedback-qualification'));
  assert.match(feedback, /name: public-packages/);
  assert.match(feedback, /node scripts\/deployment-bundle\.mjs/);
  assert.match(feedback, /TENDRILLER_EXPECTED_MANIFEST_SHA256/);
  assert.match(feedback, /test:first-app:feedback -- --first-app-archive/);
  assert.doesNotMatch(feedback, /npm run build|npm run release:artifacts/);
});
