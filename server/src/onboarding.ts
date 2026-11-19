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
    documentation: {
      index: url('/llms.txt'), full: url('/llms-full.txt'),
      bootstrap: url('/docs/SESSION_BOOTSTRAP.md'),
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
    authorization: {
      owner_claim: 'Human OAuth sign-in is required; an agent token cannot claim a page.',
      device_enrollment: 'Host access and signed device grants are independent. Grant only the rights the application needs.',
      publication: 'The signing device needs publisher: true and an admitted account binding.',
    },
    execution: {
      application: 'An owned Chronolog session executes commands and retains application data on participating devices.',
      host: 'Tendriller hosts authenticated code, signed controls and bounded introductions. It does not run a resident application or agent process.',
      browser: 'Browser execution and replication belong in the owned Worker. Runtime installation alone does not establish connectivity.',
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
