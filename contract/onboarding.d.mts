export declare const ASSISTANT_GUIDES: Readonly<{
  start: '/docs/MCP_AGENT_GUIDE.md'; build: '/docs/BUILD_AN_APP.md';
  capabilities: '/docs/CAPABILITIES.md'; sensors: '/docs/SENSORS.md'; connect: '/docs/CLOUDFLARE_ASSISTANT.md';
  deployment: '/docs/DEPLOYMENT_GUIDE.md'; delivery: '/docs/AGENT_DELIVERY.md'; troubleshooting: '/docs/TROUBLESHOOTING.md';
}>;
export interface OnboardingDescriptor {
  schema_version: number; name: string; contract: number; core_release: string;
  serviceOrigin: string; service: string; start_here: string; agent_instructions: string; starter: string; capabilities: string;
  firstApp: { release: { manifest: string; archive: string; sqlArchive: string } };
  documentation: Record<string, string>;
  interfaces: { service_descriptor: string; readiness: string; broadcasts: string; broadcast_keys: string; contract: string; register_agent?: { method: string; url: string; required: string[] }; join_agent?: { method: string; url: string; required: string[] }; create_page: { method: string; url: string; authorization?: string; required?: string[] } };
  broadcast_keys?: import('./broadcasts.mjs').BroadcastPublicJwk[];
  workflow: { id: string; action: string }[];
  delivery: { primary: string; start: string; evidence: string[]; blocked: string };
  authorization: Record<string, string>; execution: Record<string, string>; sources: Record<string, string>;
}
export declare function onboardingDescriptor(base: string): OnboardingDescriptor;
export declare function onboardingLinks(base: string): string;
