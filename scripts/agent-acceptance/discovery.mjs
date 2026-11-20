import { MeasurementError, need, same } from './observer-data.mjs';
import { hash } from './evidence.mjs';

/** Account-linked discovery uses authenticated, origin-bound MCP results;
 * literal HTTP reads remain a separate domain-only measurement. */
export function mcpDiscovery(items, { origin, build, catalog }) {
  const servers = need(catalog?.data, 'mcp-discovery-catalog');
  if (!Array.isArray(servers) || servers.length !== 1 || servers[0].name !== 'tendriller') throw new MeasurementError('mcp-discovery-server', 'failed');
  for (const tool of ['get_profile', 'tendril_guide']) need(servers[0].tools?.[tool], 'mcp-discovery-catalog-' + tool);
  const install = items.find(i => i.type === 'commandExecution' && i.exitCode === 0 && /\b(npm|pnpm|yarn)\b.*\b(install|ci|add)\b/u.test(i.command ?? ''));
  const selected = ['get_profile', 'tendril_guide'].map(tool => need(items.find(i => i.type === 'mcpToolCall' &&
    i.server === 'tendriller' && i.tool === tool && (tool !== 'tendril_guide' || i.arguments?.topic === 'build') && !i.result?.isError), 'mcp-discovery-' + tool));
  const reads = selected.map(event => {
    const blocks = event.result?.content?.filter(c => c.type === 'text');
    if (blocks?.length !== 1) throw new MeasurementError('mcp-discovery-content', 'failed');
    let body; try { body = JSON.parse(blocks[0].text); } catch { throw new MeasurementError('mcp-discovery-json', 'failed'); }
    same(body.serviceOrigin, origin, 'mcp-discovery-origin');
    same(body.readiness?.serviceOrigin, origin, 'mcp-discovery-readiness-origin');
    same(body.readiness?.mode, 'open', 'mcp-discovery-readiness-mode');
    same(body.readiness?.creation?.available, true, 'mcp-discovery-creation');
    for (const [key, expected] of Object.entries(build)) {
      same(body.build?.[key], expected, 'mcp-discovery-build-' + key);
      same(body.readiness?.build?.[key], expected, 'mcp-discovery-readiness-build-' + key);
    }
    if (event.tool === 'tendril_guide') {
      same(body.topic, 'build', 'mcp-discovery-guide-topic');
      same(body.url, origin + '/docs/BUILD_AN_APP.md', 'mcp-discovery-guide-url');
      if (typeof body.text !== 'string' || !body.text.trim()) throw new MeasurementError('mcp-discovery-guide-body');
    }
    const time = Date.parse(event.at);
    if (!Number.isFinite(time) || install && time >= Date.parse(install.at)) throw new MeasurementError('mcp-discovery-after-install', 'failed');
    return { tool: event.tool, observedAt: event.at, returnedOrigin: body.serviceOrigin, resultSha256: hash(blocks[0].text) };
  });
  return { mode: 'mcp', source: 'Authenticated selected-origin get_profile and build guide, with returned readiness before install',
    selectedOrigin: origin, build, reads, installObserved: Boolean(install), catalogSha256: hash(JSON.stringify(servers[0].tools)) };
}
