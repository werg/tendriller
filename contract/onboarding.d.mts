export declare const ASSISTANT_GUIDES: Readonly<{
  start: '/docs/MCP_AGENT_GUIDE.md'; build: '/docs/BUILD_AN_APP.md';
  capabilities: '/docs/CAPABILITIES.md'; connect: '/docs/CLOUDFLARE_ASSISTANT.md';
  deployment: '/docs/DEPLOYMENT_GUIDE.md'; delivery: '/docs/AGENT_DELIVERY.md'; troubleshooting: '/docs/TROUBLESHOOTING.md';
}>;
export interface OnboardingDescriptor {
  schema_version: number; name: string; contract: number; core_release: string;
  serviceOrigin: string; service: string; start_here: string; agent_instructions: string; starter: string; capabilities: string;
  firstApp: { release: { manifest: string; archive: string } };
  documentation: Record<string, string>;
  interfaces: { service_descriptor: string; readiness: string; contract: string; create_page: { method: string; url: string; required: string[] } };
  workflow: { id: string; action: string }[];
  delivery: { primary: string; start: string; evidence: string[]; blocked: string };
  authorization: Record<string, string>; execution: Record<string, string>; sources: Record<string, string>;
}
export declare function onboardingDescriptor(base: string): OnboardingDescriptor;
export declare function onboardingLinks(base: string): string;
