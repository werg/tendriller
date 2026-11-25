// Review fixture setup. Page creation itself is the central workspace helper's job: it retains the exact private
// creation intent (a stable random application ID) before the host is asked, finds the granted page only by that
// exact ID, and never creates a second page after an uncertain reply. The fixture only names its slug and title.
/** The fixture's one page. Central workspace page creation, grants and intents are all keyed by this slug. */
export const REVIEW_SLUG = 'review';

/** Create or resume the fixture's one page through the central workspace helper; no name-based recovery exists here. */
export const createReviewPage = (workspace, name, options) => workspace.createPage(REVIEW_SLUG, { name }, options);

/** The linked account's OAuth grant (tendrils:create) registers this workspace's shared public key; no owner identity is supplied. */
export async function registerAgentThroughMcp(origin, accessToken, args, { fetch: fetcher = globalThis.fetch } = {}) {
  const response = await fetcher(origin + '/mcp', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'register_agent', arguments: args } }) });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error || body?.result?.isError || !body?.result?.structuredContent?.token) throw Error('The linked account refused register_agent');
  return body.result.structuredContent;
}
