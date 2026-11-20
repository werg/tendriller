import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpDiscovery, discoveryTiming } from '../agent-acceptance/discovery.mjs';

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
