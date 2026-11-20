// Canonical public navigation. Host, SDK consumers and packaged CLI share this module.
export const ASSISTANT_GUIDES = Object.freeze({
  start: '/docs/MCP_AGENT_GUIDE.md', build: '/docs/BUILD_AN_APP.md',
  capabilities: '/docs/CAPABILITIES.md', connect: '/docs/CLOUDFLARE_ASSISTANT.md',
  delivery: '/docs/AGENT_DELIVERY.md', troubleshooting: '/docs/TROUBLESHOOTING.md',
});

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
      manifest: `https://github.com/werg/tendriller/releases/download/v${CORE_RELEASE}/manifest.json`,
      archive: `https://github.com/werg/tendriller/releases/download/v${CORE_RELEASE}/tendriller-first-app-${CORE_RELEASE}.tgz`,
    } },
    capabilities: url('/.well-known/tendriller-capabilities.json'),
    documentation: {
      index: url('/llms.txt'), full: url('/llms-full.txt'),
      mcp: url(ASSISTANT_GUIDES.start), capabilities: url(ASSISTANT_GUIDES.capabilities), delivery: url(ASSISTANT_GUIDES.delivery),
      patterns: url('/docs/APP_PATTERNS.md'), reviewed_input: url('/docs/AI_INPUT.md'),
      state_models: url('/docs/STATE_MODELS.md'),
      bootstrap: url('/docs/SESSION_BOOTSTRAP.md'),
      collaboration: url('/docs/MULTIPARTICIPANT.md'),
      agent_bindings: url('/docs/AGENT_BINDINGS.md'),
      troubleshooting: url(ASSISTANT_GUIDES.troubleshooting),
      application: url('/docs/APPLICATION_BACKENDS.md'),
      browser: url('/docs/BROWSER_API.md'),
      cli: url('/docs/tools/CLI.md'),
    },
    interfaces: {
      service_descriptor: url('/api/service'),
      readiness: url('/api/readiness'),
      contract: url('/contract/v3.json'),
      create_page: { method: 'POST', url: url('/api/tendrils'), required: ['owner'] },
    },
    workflow: [
      { id: 'create', action: 'Create a page; save its private setup handle and stable application.id. Continue preparing without waiting for claim.' },
      { id: 'define', action: 'Define domain commands, queries and state in one Chronolog application.' },
      { id: 'configure', action: 'Create and retain the device identity and keys; configure authority and select the initial generation.' },
      { id: 'publish', action: 'Publish the complete signed UI before asking the owner to sign in; prepare any assistant-access proposal and start the native participant.' },
      { id: 'claim', action: 'Give the owner the ready page URL and any permission-review URL. Sign-in adopts the existing prepared authority and code; no claimed reply or new deployment is needed.' },
      { id: 'connect', action: 'Enroll the browser device and approve assistant permissions explicitly; retain session-owned participation.' },
      { id: 'verify', action: 'Verify a browser command, a native query, reload persistence and the signed publication receipt.' },
    ],
    delivery: {
      primary: 'A live hosted application with verified native/browser exchange and its selected signed publication.',
      start: 'Initiate provisioning early, prepare and publish the first signed UI before asking for sign-in, and keep the participant running. Do not stop to ask for a claimed reply.',
      evidence: ['page_url', 'application_id', 'publication_receipt', 'bidirectional_command_observation', 'same-device_reopen', 'running_process_and_resume_instructions'],
      blocked: 'Name the exact missing authorization, artifact or execution capability and finish the available setup. A ZIP, static preview or parallel backend is not the requested connected app.',
    },
    authorization: {
      owner_claim: 'Human OAuth sign-in is required; an agent token cannot claim a page.',
      device_enrollment: 'Host access and signed device grants are independent. Grant only the rights the application needs.',
      publication: 'The signing device needs publisher: true and an admitted account binding.',
    },
    execution: {
      application: 'An owned Chronolog session executes commands and retains application data on participating devices.',
      host: 'Tendriller hosts authenticated code, signed controls and bounded introductions. It does not run a resident application or agent process.',
      browser: 'Browser views attach to one profile owner using SharedWorker or a fenced elected Worker. Each view retains its own draft and original operation references. Runtime installation alone does not establish connectivity.',
      agents: 'Approved consumer bindings, native profile ownership and application grants are independent. Addressed claims select execution; observing shared history does not claim work.',
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
