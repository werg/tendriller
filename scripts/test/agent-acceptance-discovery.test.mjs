import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpDiscovery, domainDiscovery, discoveryTiming, installationItems } from '../agent-acceptance/discovery.mjs';

function fixture() {
  const origin = 'https://staging.example', build = { coreRelease: 'test', sourceCommit: 'a'.repeat(40), runtimeId: 'b'.repeat(64), compositionId: 'c'.repeat(64) };
  const value = { serviceOrigin: origin, build, readiness: { serviceOrigin: origin, build, mode: 'open', creation: { available: true } } };
  const event = (tool, body, at) => ({ type: 'mcpToolCall', server: 'tendriller', tool, arguments: tool === 'tendril_guide' ? { topic: 'build' } : {},
    at, completedAt: at, result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
  return { origin, build, catalog: { data: [{ name: 'tendriller', tools: { get_profile: {}, tendril_guide: {} } }] }, items: [
    event('get_profile', value, '2026-01-01T00:00:01Z'), event('tendril_guide', { ...value, topic: 'build', url: origin + '/docs/BUILD_AN_APP.md', text: '# Build an app' }, '2026-01-01T00:00:02Z'),
    { type: 'commandExecution', command: 'npm install', exitCode: 0, startedAt: '2026-01-01T00:00:03Z', completedAt: '2026-01-01T00:00:05Z', at: '2026-01-01T00:00:05Z' }] };
}

test('MCP discovery proves authenticated origin/build/readiness and actual guide before installation without requiring literal HTTP reads', () => {
  const f = fixture(), proof = mcpDiscovery(f.items, f);
  assert.equal(proof.mode, 'mcp'); assert.equal(proof.reads.length, 1); assert.equal(proof.installObserved, true);
  assert.deepEqual(proof.reads.map(r => r.tool), ['tendril_guide']);
});

test('build-guide-only discovery is sufficient; profile alone or an unrelated guide cannot replace it', () => {
  const f = fixture(); f.items = f.items.filter(i => i.tool !== 'get_profile'); delete f.catalog.data[0].tools.get_profile;
  assert.equal(mcpDiscovery(f.items, f).reads[0].tool, 'tendril_guide');
  const onlyProfile = fixture(); onlyProfile.items = onlyProfile.items.filter(i => i.tool !== 'tendril_guide');
  assert.throws(() => mcpDiscovery(onlyProfile.items, onlyProfile), /mcp-discovery-tendril_guide/);
  const unrelated = fixture(); unrelated.items[1].arguments.topic = 'delivery';
  assert.throws(() => mcpDiscovery(unrelated.items, unrelated), /mcp-discovery-tendril_guide/);
});

test('wrong server/tool/origin/build, paused creation, opaque guide and late discovery cannot pass', () => {
  for (const mutate of [
    f => { f.items[1].server = 'other'; }, f => { f.items[1].tool = 'untrusted_profile'; },
    f => { f.catalog.data.push({ name: 'other', tools: {} }); }, f => { f.items[1].result.isError = true; },
    f => { const b = JSON.parse(f.items[1].result.content[0].text); b.serviceOrigin = 'https://other.example'; f.items[1].result.content[0].text = JSON.stringify(b); },
    f => { f.build = { ...f.build, sourceCommit: 'd'.repeat(40) }; },
    f => { const b = JSON.parse(f.items[1].result.content[0].text); b.readiness.mode = 'paused'; f.items[1].result.content[0].text = JSON.stringify(b); },
    f => { const b = JSON.parse(f.items[1].result.content[0].text); b.url = 'https://other.example/docs/BUILD_AN_APP.md'; f.items[1].result.content[0].text = JSON.stringify(b); },
    f => { f.items[1].result.content = [{ type: 'text', text: 'Just trust this guide' }]; },
    f => { f.items[1].completedAt = '2026-01-01T00:00:04Z'; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => mcpDiscovery(f.items, f)); }
});

test('parallel installation starting before guide completion fails even if it completes later; missing and malformed times block', () => {
  const f = fixture(); f.items[2].startedAt = '2026-01-01T00:00:01.500Z';
  assert.throws(() => mcpDiscovery(f.items, f), /not-before-install-start/);
  assert.throws(() => discoveryTiming([f.items[1]], [f.items[2]]), /not-before-install-start/, 'same timing proof applies to domain HTTP reads');
  for (const bad of [undefined, null, '', 'invalid', 0]) {
    const missing = fixture(); missing.items[2].startedAt = bad;
    assert.throws(() => mcpDiscovery(missing.items, missing), /installation-start-time-missing/);
    const malformed = fixture(); malformed.items[1].completedAt = bad;
    assert.throws(() => mcpDiscovery(malformed.items, malformed), /discovery-completion-time-missing/);
  }
  const failedInstall = fixture(); failedInstall.items[2].exitCode = 1; failedInstall.items[2].startedAt = '2026-01-01T00:00:00Z';
  assert.throws(() => mcpDiscovery(failedInstall.items, failedInstall), /not-before-install-start/);
});

const quoteShell = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
function domainFixture() {
  const origin = 'https://staging.example';
  const command = (script, start, end, output = '') => ({ type: 'commandExecution',
    command: '/bin/bash -lc ' + quoteShell(script), exitCode: 0, output,
    startedAt: `2026-01-01T00:00:0${start}Z`, completedAt: `2026-01-01T00:00:0${end}Z` });
  const prefix = `set -e
umask 077
origin=${origin}
curl -fsS "$origin/api/readiness" -o readiness.json
curl -fsS "$origin/api/service" -o service.json
curl -fsS "$origin/.well-known/tendriller.json" -o onboarding.json
export TENDRILLER_ORIGIN=$origin
awk '/^node --input/{on=1} on{print}' /tmp/guide.md | bash -e
sed -n '/^RELEASE=/,$p' /tmp/guide.md | bash -e`;
  return { origin, prefix, items: [
    command(`curl -fsS ${origin}/docs/BUILD_AN_APP.md`, 1, 1),
    command(`curl -fsS ${origin}/api/readiness`, 1, 1),
    command(prefix, 2, 6, 'added 3 packages, and audited 4 packages in 720ms\n'),
    command('npm install --prefix /tmp/preview --no-save playwright', 7, 8),
  ] };
}

test('domain reads resolve a guarded literal origin before an indirect guide installer, without inventing timestamps', () => {
  const f = domainFixture(), proof = domainDiscovery(f.items, f);
  assert.equal(installationItems(f.items).length, 2, 'bootstrap package output counts even without literal npm in its command');
  assert.equal(proof.urls.length, 4);
  assert.equal(proof.sameCommandOrdering.length, 2, 'service/discovery share the bootstrap event; guide/readiness completed earlier');
  for (const order of proof.sameCommandOrdering) {
    assert.equal(order.kind, 'guarded-shell-prefix');
    assert(order.readStep < order.opaqueContinuationStep);
    assert.equal(order.startedAt, f.items[2].startedAt);
    assert.equal(order.completedAt, f.items[2].completedAt);
  }
  assert.equal(proof.firstInstallCommandStartedAt, new Date(f.items[2].startedAt).toISOString());
  assert(!('firstInstallStartedAt' in proof));
  assert.match(proof.timingScope, /whole commands/);
});

test('separate successful literal curl reads preserve strict command-envelope timing', () => {
  const f = domainFixture(), at = '2026-01-01T00:00:01Z';
  f.items = ['/api/service', '/.well-known/tendriller.json', '/api/readiness', '/docs/BUILD_AN_APP.md']
    .map(path => ({ type: 'commandExecution', command: `curl --fail --silent --url "${f.origin}${path}"`,
      exitCode: 0, startedAt: at, completedAt: at }));
  f.items.push({ type: 'commandExecution', command: 'npm ci', exitCode: 0,
    startedAt: '2026-01-01T00:00:02Z', completedAt: '2026-01-01T00:00:03Z' });
  assert.deepEqual(domainDiscovery(f.items, f).sameCommandOrdering, []);
});

test('quoted/braced static variables work; dynamic, literal-dollar, overridden and wrong-origin destinations do not', () => {
  const positive = domainFixture();
  positive.items[2].command = '/bin/bash -lc ' + quoteShell(positive.prefix.replace('origin=https://staging.example', "origin='https://staging.example'").replaceAll('$origin/', '${origin}/'));
  assert.equal(domainDiscovery(positive.items, positive).urls.length, 4);
  for (const change of [
    p => p.replace('origin=https://staging.example', 'origin=https://other.example'),
    p => p.replace('origin=https://staging.example', 'origin=$(read-origin)'),
    p => p.replace('origin=https://staging.example', 'origin="`read-origin`"'),
    p => p.replace('curl -fsS "$origin/api/service"', 'curl -fsS \'$origin/api/service\''),
    p => p.replace('curl -fsS "$origin/api/service"', 'curl -fsS "\\$origin/api/service"'),
    p => p.replace('curl -fsS "$origin/api/service"', 'origin=https://other.example\ncurl -fsS "$origin/api/service"'),
  ]) {
    const f = domainFixture(); f.items[2].command = '/bin/bash -lc ' + quoteShell(change(f.prefix));
    assert.throws(() => domainDiscovery(f.items, f), /model-read-/);
  }
});

test('failed or unguarded batches, conditional/echo URLs and curl output paths cannot fabricate successful reads', () => {
  for (const change of [
    p => p.replace('set -e\n', ''),
    p => p.replace('curl -fsS "$origin/api/service"', 'echo "$origin/api/service"'),
    p => p.replace('curl -fsS "$origin/api/service"', 'curl -sS "$origin/api/service"'),
    p => p.replace('curl -fsS "$origin/api/service"', 'curl -fsS "$origin/api/service" || true'),
    p => p.replace('curl -fsS "$origin/api/service" -o service.json', 'curl -fsS https://other.example/ -o "$origin/api/service"'),
    p => p.replace('curl -fsS "$origin/api/service"', 'curl --head -fsS "$origin/api/service"'),
    p => p.replace('curl -fsS "$origin/api/service"', 'curl -fsS --config hidden "$origin/api/service"'),
    p => 'if true; then\n' + p + '\nfi',
    p => p.replace('umask 077', 'npm ci'),
  ]) {
    const f = domainFixture(); f.items[2].command = '/bin/bash -lc ' + quoteShell(change(f.prefix));
    assert.throws(() => domainDiscovery(f.items, f), /model-read-/);
  }
  const failed = domainFixture(); failed.items[2].exitCode = 1;
  assert.throws(() => domainDiscovery(failed.items, failed), /model-read-/);
});

test('a concurrent or failed install in a different command still cannot overlap a required read envelope', () => {
  for (const exitCode of [0, 1]) {
    const f = domainFixture(); f.items[3].exitCode = exitCode;
    f.items[3].startedAt = '2026-01-01T00:00:04Z';
    assert.throws(() => domainDiscovery(f.items, f), /discovery-not-before-install-start/);
  }
  const silentCommand = fixture(); silentCommand.items[2].command = 'bash guide-installer';
  silentCommand.items[2].output = 'added 3 packages, and audited 4 packages in 1s\n';
  silentCommand.items[2].startedAt = '2026-01-01T00:00:01Z';
  assert.throws(() => mcpDiscovery(silentCommand.items, silentCommand), /discovery-not-before-install-start/);
});

test('same-command order requires a real guarded prefix, a later continuation and valid measured envelope', () => {
  const opaqueBody = domainFixture();
  opaqueBody.items = [{ ...opaqueBody.items[2], command: '/bin/bash -lc ' + quoteShell('set -e\n' + ['/api/service', '/.well-known/tendriller.json', '/api/readiness', '/docs/BUILD_AN_APP.md'].map(path => `curl -fsS ${opaqueBody.origin}${path}`).join('\n')) }];
  assert.throws(() => domainDiscovery(opaqueBody.items, opaqueBody), /same-command-install-order-unmeasured/);
  for (const mutate of [
    f => { delete f.items[2].startedAt; },
    f => { f.items[2].completedAt = 'invalid'; },
    f => { f.items[2].startedAt = '2026-01-01T00:00:09Z'; },
  ]) { const f = domainFixture(); mutate(f); assert.throws(() => domainDiscovery(f.items, f)); }
});

test('npx, npm exec, pnpm dlx and yarn dlx are acquisition fences, including failed or concurrent attempts', () => {
  for (const command of ['npx --yes starter', 'npm --yes exec starter', 'pnpm --package starter dlx starter', 'yarn dlx starter']) {
    const f = domainFixture(); f.items[3].command = command; f.items[3].exitCode = 1;
    f.items[3].startedAt = '2026-01-01T00:00:04Z';
    assert(installationItems(f.items).includes(f.items[3]), command);
    assert.throws(() => domainDiscovery(f.items, f), /discovery-not-before-install-start/, command);
  }
  assert.match(domainDiscovery(domainFixture().items, domainFixture()).installationCoverage, /silent arbitrary subprocess installers are not audited/);
});
