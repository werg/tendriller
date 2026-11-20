import { CONTRACT_VERSION, CORE_RELEASE } from '../../contract/index.mjs';

/** Public navigation only. This document grants no account or device authority. */
export function onboardingDescriptor(base: string) {
  const url = (path: string) => new URL(path, base).href;
  return {
    schema_version: 1,
    name: 'Tendriller',
    contract: CONTRACT_VERSION,
    core_release: CORE_RELEASE,
    service: url('/'),
    start_here: url('/docs/BUILD_AN_APP.md'),
    agent_instructions: url('/agent.md'),
    starter: url('/downloads/tendriller-first-app.tgz'),
    capabilities: url('/.well-known/tendriller-capabilities.json'),
    documentation: {
      index: url('/llms.txt'), full: url('/llms-full.txt'),
      capabilities: url('/docs/CAPABILITIES.md'), delivery: url('/docs/AGENT_DELIVERY.md'),
      patterns: url('/docs/APP_PATTERNS.md'), reviewed_input: url('/docs/AI_INPUT.md'),
      state_models: url('/docs/STATE_MODELS.md'),
      bootstrap: url('/docs/SESSION_BOOTSTRAP.md'),
      collaboration: url('/docs/MULTIPARTICIPANT.md'),
      agent_bindings: url('/docs/AGENT_BINDINGS.md'),
      troubleshooting: url('/docs/TROUBLESHOOTING.md'),
      application: url('/docs/APPLICATION_BACKENDS.md'),
      browser: url('/docs/BROWSER_API.md'),
      cli: url('/docs/tools/CLI.md'),
    },
    interfaces: {
      service_descriptor: url('/api/service'),
      contract: url('/contract/v3.json'),
      create_page: { method: 'POST', url: url('/api/tendrils'), required: ['owner'] },
    },
    workflow: [
      { id: 'create', action: 'Create a page; save its private handle and stable application.id.' },
      { id: 'claim', action: 'The human owner opens page_url and signs in to claim it.' },
      { id: 'define', action: 'Define domain commands, queries and state in one Chronolog application.' },
      { id: 'configure', action: 'Create and retain the device identity and keys; configure authority and select the initial generation.' },
      { id: 'connect', action: 'Open the native session, enroll the browser device, and start session-owned participation.' },
      { id: 'publish', action: 'Publish the complete authored UI through an authorized signed Chronolog publication.' },
      { id: 'verify', action: 'Verify a browser command, a native query, reload persistence and the signed publication receipt.' },
    ],
    delivery: {
      primary: 'A live hosted application with verified native/browser exchange and its selected signed publication.',
      start: 'Initiate provisioning and give the owner the claim URL early; setup is part of the app-building task.',
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
export function onboardingLinks(base: string): string {
  return `<${new URL('/agent.md', base).href}>; rel="describedby"; type="text/markdown", ` +
    `<${new URL('/.well-known/tendriller.json', base).href}>; rel="service-desc"; type="application/json"`;
}
