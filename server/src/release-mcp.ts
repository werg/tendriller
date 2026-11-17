import type { Tool } from './mcp';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };

/** This transport accepts portable signed release evidence; signing stays with the publisher. */
export const PEER_RELEASE_TOOLS: Tool[] = [
  { name: 'release_state', description: 'Read the signed publisher-policy and page-activation history. Verify it against the pinned Chronolog host control key before selecting code.',
    inputSchema: object({}), call: () => ({ method: 'GET', rest: 'peers/releases' }) },
  { name: 'configure_release_publishers', description: 'Owner-account administration of separate publication keys. Supply a stable requestId, observed expectedPolicy digest or null, and account-bound publishers. An empty set freezes new publication. Data membership grants no publication authority.',
    inputSchema: object({ configuration: { type: 'object' } }, ['configuration']),
    call: args => ({ method: 'PUT', rest: 'peers/releases/policy', body: args.configuration }) },
  { name: 'upload_release_text', description: 'Upload exact authored UTF-8 release content at its prepared SHA-256 digest. This does not publish or activate code. Use the public SDK for binary bytes; private application blobs are not release content.',
    inputSchema: object({ digest, text: { type: 'string', maxLength: 32 * 1024 * 1024 },
      mediaType: { type: 'string', maxLength: 160 } }, ['digest', 'text']),
    call: args => ({ method: 'PUT', rest: `peers/releases/content/${args.digest}`,
      rawBody: new TextEncoder().encode(args.text).buffer, headers: { 'Content-Type': args.mediaType ?? 'text/plain' } }) },
  { name: 'publish_release', description: 'Submit one exact signed Chronolog release manifest after uploading every asset. The host verifies the publisher, complete byte graph, paths and sizes. Publication retains immutable bytes; activation is separate.',
    inputSchema: object({ manifest: { type: 'object' } }, ['manifest']),
    call: args => ({ method: 'POST', rest: 'peers/releases/manifests', body: args.manifest }) },
  { name: 'release_manifest', description: 'Read an accepted immutable signed release manifest by its digest. Authored bytes are available through the public release content API and remain separate from rendered HTML.',
    inputSchema: object({ id: digest }, ['id']), call: args => ({ method: 'GET', rest: `peers/releases/manifests/${args.id}` }) },
  { name: 'activate_release', description: 'Submit an exact signed activation request against the observed activation ID and current publisher policy. Reuse the original signed request after a lost reply. Selecting older code requires a new authorized activation; application recovery and health reports cannot change this chain.',
    inputSchema: object({ request: { type: 'object' } }, ['request']),
    call: args => ({ method: 'POST', rest: 'peers/releases/activations', body: args.request }) },
];
