import { createParticipantRequest } from '../../contract/participant.mjs';
import type { ParticipantFacet } from '../../contract/participant.mjs';
import type { Tool } from './mcp';

const applicationId = { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'The selected peer application identity from tendril_info.' };
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object', properties: { applicationId, ...properties }, required: ['applicationId', ...required], additionalProperties: false,
});
const call = (facet: ParticipantFacet, action: string, payload: (args: any) => unknown = () => ({})) => (args: any) => ({
  method: 'POST', rest: 'peers/participant',
  body: createParticipantRequest({ applicationId: args.applicationId, facet, action, payload: payload(args) }),
});

/** Lifecycle controls use the same filtered participant transport as browser and native peers. */
export const PEER_CONTROL_TOOLS: Tool[] = [
  { name: 'peer_application', description: 'Read signed peer authority through the Chronolog control participant. Verify returned evidence against the pinned descriptor in the local application session.',
    inputSchema: schema(), call: call('control', 'read') },
  { name: 'peer_definition', description: 'Read immutable public command/query schemas and signed genesis metadata. Verify their descriptor commitments in the local Chronolog session before use.',
    inputSchema: schema(), call: call('publication', 'definition') },
  { name: 'discover_peers', description: 'Read bounded expiring routing hints on join or reconnect. Hints grant no authority or retention guarantee; healthy sessions do not poll.',
    inputSchema: schema(), call: call('discovery', 'read') },
  { name: 'configure_peer_application', description: 'Configure the initial peer-generation-v1 descriptor and enrolled device grants after owner claim. Next select the first generation before opening the session. Call tendril_guide for the complete setup. The host creates no permanent peer role.',
    inputSchema: schema({ configuration: { type: 'object' } }, ['configuration']), call: call('control', 'configure', args => args.configuration) },
  { name: 'select_peer_generation', description: 'Submit an exact signed Chronolog transition at creation, handover, takeover or restrictive control change. Preserve the signed transition on lost replies; ordinary application commands stay in the local peer session.',
    inputSchema: schema({ request: { type: 'object' }, control: { type: 'object' } }, ['request']),
    call: call('control', 'select', args => ({ request: args.request, ...(args.control === undefined ? {} : { control: args.control }) })) },
  { name: 'administer_peer_generation', description: 'Owner-account recovery through the explicit hosted control-only participant. Supply a real peer coordinator and complete prefix proof. The host cannot read, write or coordinate application data.',
    inputSchema: schema({ transition: { type: 'object' }, control: { type: 'object' } }, ['transition']),
    call: call('control', 'administer', args => ({ transition: args.transition, ...(args.control === undefined ? {} : { control: args.control }) })) },
  { name: 'peer_publication', description: 'Read the current or an exact retained signed page-code publication. Verify its signature and release ancestry in Chronolog; code release revisions remain independent of lossy application recovery.',
    inputSchema: schema({ id: { type: 'string', pattern: '^[0-9a-f]{64}$' } }), call: call('publication', 'read', args => args.id === undefined ? {} : { id: args.id }) },
  { name: 'publish_peer_publication', description: 'Publish a complete signed page-code graph prepared by an authorized Chronolog device. Assets carry canonical base64 bytes and their signed hashes. Exact retries return the retained receipt; stale release heads fail.',
    inputSchema: schema({ publication: { type: 'object' }, assets: { type: 'array', maxItems: 128, items: { type: 'object',
      properties: { hash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, bytes: { type: 'string' } }, required: ['hash', 'bytes'], additionalProperties: false } } }, ['publication', 'assets']),
    call: call('publication', 'publish', args => ({ publication: args.publication, assets: args.assets })) },
];
