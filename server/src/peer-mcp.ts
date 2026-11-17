import type { Tool } from './mcp';

/** Lifecycle controls only. Application commands execute in the agent's own Chronolog session. */
export const PEER_CONTROL_TOOLS: Tool[] = [
  { name: 'peer_application', description: 'Read the signed peer-generation application descriptor and selected control history. The local Chronolog session must verify this evidence against its pinned descriptor.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => ({ method: 'GET', rest: 'peers/application' }) },
  { name: 'discover_peers', description: 'Look up bounded unexpired peer routing hints on join or reconnect. Hints confer no permissions and do not prove data retention. Healthy sessions do not poll this tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => ({ method: 'GET', rest: 'peers/directory' }) },
  { name: 'configure_peer_application', description: 'Publish the immutable peer-generation-v1 descriptor and initial enrolled device grants for a new peer history. Creates durable host control state without any permanent native coordinator.',
    inputSchema: { type: 'object', properties: { configuration: { type: 'object' } }, required: ['configuration'], additionalProperties: false },
    call: args => ({ method: 'PUT', rest: 'peers/application', body: args.configuration }) },
  { name: 'select_peer_generation', description: 'Submit an exact signed Chronolog transition at creation, handover, takeover or restrictive control change. Preserve transition identity on lost replies. Never use this for ordinary commands; requester recovery and coordinator rights are verified separately.',
    inputSchema: { type: 'object', properties: { request: { type: 'object' }, control: { type: 'object' } }, required: ['request'], additionalProperties: false },
    call: args => ({ method: 'POST', rest: 'peers/generations', body: { request: args.request, ...(args.control === undefined ? {} : { control: args.control }) } }) },
  { name: 'administer_peer_generation', description: 'Owner-account administration through the explicit hosted control-only participant, including recovery after device-key loss. Supply a real peer coordinator and complete prefix proof. The host cannot read, write or coordinate application data. Preserve the exact transition on retry.',
    inputSchema: { type: 'object', properties: { transition: { type: 'object' }, control: { type: 'object' } }, required: ['transition'], additionalProperties: false },
    call: args => ({ method: 'POST', rest: 'peers/administration', body: { transition: args.transition, ...(args.control === undefined ? {} : { control: args.control }) } }) },
];
