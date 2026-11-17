import type { Tool } from './mcp';
import { createParticipantRequest, validateParticipantResponse, type ParticipantFacet } from '../../contract/participant.mjs';
import { json } from './http';

/** Lifecycle controls only. Application commands execute in the agent's own Chronolog session. */
export function peerControlTools(applicationId: string): Tool[] {
  const operation = (facet: ParticipantFacet, action: string, payload: (args: Record<string, any>) => unknown = () => ({})): Tool['call'] => async (args, invoke) => {
    const envelope = createParticipantRequest({ applicationId, facet, action, payload: payload(args) });
    const response = await invoke({ method: 'POST', rest: 'peers/participant', body: envelope });
    if (!response.ok) return response;
    return json(validateParticipantResponse(await response.json(), envelope).payload);
  };
  return [
  { name: 'peer_application', description: 'Read the signed peer-generation application descriptor and selected control history. The local Chronolog session must verify this evidence against its pinned descriptor.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: operation('control', 'read') },
  { name: 'peer_definition', description: 'Read immutable public command/query schemas, their signed descriptor and the signed initial schema envelope. Verify the descriptor, definition digest and schema signature through Chronolog before opening a session or constructing local tools; this metadata grants no command execution authority.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: operation('publication', 'definition') },
  { name: 'discover_peers', description: 'Look up bounded unexpired peer routing hints on join or reconnect. Hints confer no permissions and do not prove data retention. Healthy sessions do not poll this tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: operation('discovery', 'read') },
  { name: 'configure_peer_application', description: 'Publish the immutable peer-generation-v1 descriptor and initial enrolled device grants for a new peer history. Creates durable host control state without any permanent native coordinator.',
    inputSchema: { type: 'object', properties: { configuration: { type: 'object' } }, required: ['configuration'], additionalProperties: false },
    call: operation('control', 'configure', args => args.configuration) },
  { name: 'select_peer_generation', description: 'Submit an exact signed Chronolog transition at creation, handover, takeover or restrictive control change. Preserve transition identity on lost replies. Never use this for ordinary commands; requester recovery and coordinator rights are verified separately.',
    inputSchema: { type: 'object', properties: { request: { type: 'object' }, control: { type: 'object' } }, required: ['request'], additionalProperties: false },
    call: operation('control', 'select', args => ({ request: args.request, ...(args.control === undefined ? {} : { control: args.control }) })) },
  { name: 'administer_peer_generation', description: 'Owner-account administration through the explicit hosted control-only participant, including recovery after device-key loss. Supply a real peer coordinator and complete prefix proof. The host cannot read, write or coordinate application data. Preserve the exact transition on retry.',
    inputSchema: { type: 'object', properties: { transition: { type: 'object' }, control: { type: 'object' } }, required: ['transition'], additionalProperties: false },
    call: operation('control', 'administer', args => ({ transition: args.transition, ...(args.control === undefined ? {} : { control: args.control }) })) },
  { name: 'peer_publication', description: 'Read the selected administrator-signed code publication and its immutable hosted version. Verify the signed manifest through Chronolog; this does not read application data.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } }, additionalProperties: false }, call: operation('publication', 'read', args => args) },
  { name: 'publish_peer_publication', description: 'Publish an administrator-signed code manifest with its exact base64 asset bytes. Preserves exact retries and rejects stale publication heads; application records and private content remain on peers.',
    inputSchema: { type: 'object', properties: { publication: { type: 'object' }, assets: { type: 'array', maxItems: 128, items: { type: 'object' } } }, required: ['publication', 'assets'], additionalProperties: false },
    call: operation('publication', 'publish', args => ({ publication: args.publication, assets: args.assets })) },
  ];
}
