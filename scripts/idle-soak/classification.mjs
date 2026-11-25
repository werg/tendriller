// Only fixed labels leave this function. Never retain a URL or inspect a body.
export const transportCategories = Object.freeze(['setup-watch', 'discovery-watch', 'invitations',
  'rendezvous', 'relay', 'assistant-provider', 'publication-watch', 'agent-hub', 'control', 'other']);
export function classifyTransport(input) {
  try {
    const value = typeof input === 'string' || input instanceof URL ? input
      : input instanceof Request ? input.url : '';
    const path = new URL(value).pathname;
    // One agent hub socket multiplexes every control stream of every page.
    if (path === '/api/agent/hub') return 'agent-hub';
    const route = /^(?:\/api\/agent\/pages\/[^/]+|(?:\/[^/]+)*\/_tendril)\/(.+)$/.exec(path)?.[1];
    if (!route) return 'other';
    const routes = { 'setup/watch': 'setup-watch', 'peers/discovery/watch': 'discovery-watch',
      'peers/invitations': 'invitations', 'peers/rendezvous': 'rendezvous', 'peers/relay': 'relay',
      'assistant/adapter': 'assistant-provider', 'publication-ready': 'publication-watch' };
    return Object.hasOwn(routes, route) ? routes[route] : 'control';
  } catch { return 'other'; }
}
