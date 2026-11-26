// Canonical public navigation. Host, SDK consumers and packaged CLI share this module.
export const ASSISTANT_GUIDES = Object.freeze({
  start: '/docs/MCP_AGENT_GUIDE.md', build: '/docs/BUILD_AN_APP.md',
  capabilities: '/docs/CAPABILITIES.md', sensors: '/docs/SENSORS.md', connect: '/docs/CLOUDFLARE_ASSISTANT.md',
  deployment: '/docs/DEPLOYMENT_GUIDE.md', delivery: '/docs/AGENT_DELIVERY.md', conversation: '/docs/CONVERSATION_DELIVERY.md',
  pricing: '/docs/PRICING.md', self_hosting: '/docs/SELF_HOSTING.md', troubleshooting: '/docs/TROUBLESHOOTING.md',
});

// Build substitutes the exact checkout into both packed SDK and host.
const RELEASE_SOURCE = 'unbuilt';

import { CONTRACT_VERSION, CORE_RELEASE } from './index.mjs';

/** Public navigation only. This document grants no account or device authority. */
export function onboardingDescriptor(base) {
  const origin = new URL(base).origin;
  const url = (path) => new URL(path, origin).href;
  return {
    schema_version: 1,
    name: 'Tendriller',
    contract: CONTRACT_VERSION,
    core_release: CORE_RELEASE,
    serviceOrigin: origin,
    service: url('/'),
    start_here: url(ASSISTANT_GUIDES.build),
    agent_instructions: url('/agent.md'),
    starter: url('/downloads/tendriller-first-app.tgz'),
    firstApp: { release: {
      manifest: `https://github.com/werg/tendriller/releases/download/source-${RELEASE_SOURCE}/manifest.json`,
      archive: `https://github.com/werg/tendriller/releases/download/source-${RELEASE_SOURCE}/tendriller-first-app-${CORE_RELEASE}.tgz`,
      sqlArchive: `https://github.com/werg/tendriller/releases/download/source-${RELEASE_SOURCE}/tendriller-first-app-sql-${CORE_RELEASE}.tgz`,
    } },
    capabilities: url('/.well-known/tendriller-capabilities.json'),
    documentation: {
      index: url('/llms.txt'), full: url('/llms-full.txt'),
      mcp: url(ASSISTANT_GUIDES.start), deployment: url(ASSISTANT_GUIDES.deployment), capabilities: url(ASSISTANT_GUIDES.capabilities), sensors: url(ASSISTANT_GUIDES.sensors), delivery: url(ASSISTANT_GUIDES.delivery),
      patterns: url('/docs/APP_PATTERNS.md'), reviewed_input: url('/docs/AI_INPUT.md'),
      state_models: url('/docs/STATE_MODELS.md'),
      bootstrap: url('/docs/SESSION_BOOTSTRAP.md'),
      collaboration: url('/docs/MULTIPARTICIPANT.md'),
      agent_bindings: url('/docs/AGENT_BINDINGS.md'),
      troubleshooting: url(ASSISTANT_GUIDES.troubleshooting),
      local_host: url('/docs/LOCAL_HOST.md'),
      application: url('/docs/APPLICATION_BACKENDS.md'),
      browser: url('/docs/BROWSER_API.md'),
      cli: url('/docs/tools/CLI.md'),
      multi_page_agents: url('/docs/MULTI_PAGE_AGENTS.md'),
      conversation_delivery: url(ASSISTANT_GUIDES.conversation),
      pricing: url(ASSISTANT_GUIDES.pricing),
      self_hosting: url(ASSISTANT_GUIDES.self_hosting),
    },
    interfaces: {
      service_descriptor: url('/api/service'),
      readiness: url('/api/readiness'),
      broadcasts: url('/api/broadcasts'),
      broadcast_keys: url('/.well-known/tendriller-broadcast-keys.json'),
      contract: url('/contract/v3.json'),
      pricing: url('/pricing'),
      pricing_markdown: url('/pricing.md'),
      self_host: url('/self-host'),
      billing: url('/dashboard/billing'),
      register_agent: { method: 'POST', url: url('/api/agents'), required: ['owner', 'handle', 'publicKey', 'wrapKey'] },
      join_agent: { method: 'POST', url: url('/api/agents/join'), required: ['code', 'handle', 'publicKey', 'wrapKey'] },
      create_page: { method: 'POST', url: url('/api/agent/pages'), authorization: 'agent token' },
    },
    workflow: [
      { id: 'create', action: 'Register the agent once (one token, one signing key for all its pages), then create a page in the workspace and keep its stable application.id. Continue preparing without waiting for claim.' },
      { id: 'define', action: 'Define domain commands, queries and state in one Chronolog application.' },
      { id: 'configure', action: 'Choose explicit finality/availability semantics (none by default), prepare host execution metadata and an independent publisher policy, and create the page keys as the agent (npm run init); no fixed schema is required.' },
      { id: 'publish', action: 'Publish the complete signed UI before owner sign-in; the publisher right is independent of data access.' },
      { id: 'claim', action: 'Give the owner the ready page URL and any permission-review URL. The owner signs in to the existing published code; any online page member (the agent program or an earlier device) admits the owner-account browser and wraps its keys. No claimed reply or new deployment is needed.' },
      { id: 'connect', action: 'Every further device or agent is admitted by one mechanism: host account attestation, invite redemption or strict-mode approval, then signed membership and keys wrapped to its own key. Background peers/finalizers never gate local Save.' },
      { id: 'verify', action: 'Verify browser-only local authoring, offline CRUD/reload, second-device admission, Remove device key rotation, operation-set convergence, revisable outcomes and the signed publication receipt.' },
    ],
    delivery: {
      primary: 'A signed live browser-first application with offline durable authoring and verified convergence with an admitted peer.',
      start: 'Initiate provisioning early, prepare and publish the first signed UI before asking for sign-in, without requiring a native participant. Do not stop to ask for a claimed reply.',
      evidence: ['page_url', 'application_id', 'publication_receipt', 'independent_offline_authoring', 'peer_convergence_and_retention', 'revisable_materialization_and_optional_finality', 'same-device_reopen', 'running_process_and_resume_instructions'],
      blocked: 'Name the exact missing authorization, artifact or execution capability and finish the available setup. A ZIP, static preview or parallel backend is not the requested connected app.',
    },
    authorization: {
      owner_claim: 'Human OAuth sign-in is required; an agent token cannot claim a page.',
      device_admission: 'The host attests account-bound device keys; only page members sign membership and wrap epoch keys. Host account access, signed membership grants and ordinary SQL permissions are separate.',
      publication: 'The signing key needs the independent prepared host publisher policy; publication requires no data access.',
    },
    execution: {
      application: 'An owned Chronolog session executes commands and retains application data on participating devices.',
      host: 'Tendriller hosts authenticated code, signed controls and bounded introductions. It does not run a resident application or agent process.',
      browser: 'Browser views attach to one profile owner using SharedWorker or a fenced elected Worker. Each view retains its own draft and original operation references. Runtime installation alone does not establish connectivity.',
      agents: 'Approved consumer bindings, optional native profile ownership and application grants are independent. Provisional claims are revisable and do not establish global exclusivity or authorize irreversible effects.',
      conversation: 'Same-conversation wake is not established by page residency, a connected owner, event forwarding or account linking. Qualify the current host admission mechanism, injection into the exact active turn, and a second request after the first turn ends. Presence belongs only to the worker handling the advertised topics.',
    },
    sources: {
      core: 'https://github.com/werg/tendriller',
      chronolog: 'https://github.com/werg/chronolog-db',
      cookbooks: 'https://github.com/werg/tendriller-contrib',
      releases: 'https://github.com/werg/tendriller/releases',
    },
  };
}

/** Discovery stays outside the strict, existing service-descriptor JSON schema. */
export function onboardingLinks(base) {
  const origin = new URL(base).origin;
  return `<${new URL('/agent.md', origin).href}>; rel="describedby"; type="text/markdown", ` +
    `<${new URL('/.well-known/tendriller.json', origin).href}>; rel="service-desc"; type="application/json", ` +
    `<${new URL('/api/readiness', origin).href}>; rel="monitor"; type="application/json"`;
}
