import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpDiscovery } from '../agent-acceptance/discovery.mjs';

function fixture() {
  const origin = 'https://staging.example', build = { coreRelease: 'test', sourceCommit: 'a'.repeat(40), runtimeId: 'b'.repeat(64), compositionId: 'c'.repeat(64) };
  const value = { serviceOrigin: origin, build, readiness: { serviceOrigin: origin, build, mode: 'open', creation: { available: true } } };
  const event = (tool, body, at) => ({ type: 'mcpToolCall', server: 'tendriller', tool, arguments: tool === 'tendril_guide' ? { topic: 'build' } : {},
    at, result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
  return { origin, build, catalog: { data: [{ name: 'tendriller', tools: { get_profile: {}, tendril_guide: {} } }] }, items: [
    event('get_profile', value, '2026-01-01T00:00:01Z'), event('tendril_guide', { ...value, topic: 'build', url: origin + '/docs/BUILD_AN_APP.md', text: '# Build an app' }, '2026-01-01T00:00:02Z'),
    { type: 'commandExecution', command: 'npm install', exitCode: 0, at: '2026-01-01T00:00:03Z' }] };
}

test('MCP discovery proves authenticated origin/build/readiness and actual guide before installation without requiring literal HTTP reads', () => {
  const f = fixture(), proof = mcpDiscovery(f.items, f);
  assert.equal(proof.mode, 'mcp'); assert.equal(proof.reads.length, 2); assert.equal(proof.installObserved, true);
  assert.deepEqual(proof.reads.map(r => r.tool), ['get_profile', 'tendril_guide']);
});

test('wrong server/tool/origin/build, paused creation, opaque guide and late discovery cannot pass', () => {
  for (const mutate of [
    f => { f.items[0].server = 'other'; }, f => { f.items[0].tool = 'untrusted_profile'; },
    f => { f.catalog.data.push({ name: 'other', tools: {} }); }, f => { f.items[0].result.isError = true; },
    f => { const b = JSON.parse(f.items[0].result.content[0].text); b.serviceOrigin = 'https://other.example'; f.items[0].result.content[0].text = JSON.stringify(b); },
    f => { f.build = { ...f.build, sourceCommit: 'd'.repeat(40) }; },
    f => { const b = JSON.parse(f.items[0].result.content[0].text); b.readiness.mode = 'paused'; f.items[0].result.content[0].text = JSON.stringify(b); },
    f => { const b = JSON.parse(f.items[1].result.content[0].text); b.url = 'https://other.example/docs/BUILD_AN_APP.md'; f.items[1].result.content[0].text = JSON.stringify(b); },
    f => { f.items[1].result.content = [{ type: 'text', text: 'Just trust this guide' }]; },
    f => { f.items[0].at = '2026-01-01T00:00:04Z'; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => mcpDiscovery(f.items, f)); }
});
