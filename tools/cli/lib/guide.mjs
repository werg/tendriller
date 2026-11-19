import { serverBase } from './config.mjs';

/** Public navigation only: generating a guide creates no page, identity or session. */
export function onboardingGuide(flags = {}, env = process.env) {
  const service = publicServiceOrigin(serverBase(env, flags));
  const url = path => service + path;
  return {
    service,
    network_checked: false,
    start_here: url('/docs/BUILD_AN_APP.md'),
    agent_guide: url('/agent.md'),
    capabilities: url('/.well-known/tendriller-capabilities.json'),
    capability_guide: url('/docs/CAPABILITIES.md'),
    delivery_guide: url('/docs/AGENT_DELIVERY.md'),
    patterns: url('/docs/APP_PATTERNS.md'),
    preview: url('/docs/tools/PREVIEW.md'),
    primary_deliverable: 'A live hosted application with a connected native/browser session, verified signed publication, and honest process lifetime/resume instructions.',
    troubleshooting: url('/docs/TROUBLESHOOTING.md'),
    service_descriptor: url('/api/service'),
    next: `tendril service --server ${service}`,
    workflow: [
      { step: 1, action: 'Create and claim the application page',
        ready_when: 'Provision early, save application.id, give the actual page_url to the owner, and complete their sign-in; setup is part of the task.' },
      { step: 2, action: 'Define durable state and commands',
        ready_when: 'The application definition, execution manifest and required device grants are explicit.' },
      { step: 3, action: 'Build the UI',
        ready_when: 'The authored HTML and assets use the same definition and expose session status.' },
      { step: 4, action: 'Connect the owned Chronolog session',
        ready_when: 'Authority has an explicitly selected initial generation. The enrolled signer, persistent local store, epoch keys and verified authority open the session; one participation controller owns peer connections.' },
      { step: 5, action: 'Publish and verify',
        ready_when: 'An authorized publisher signs the complete file graph, the host returns a receipt, and retained work survives reopening the same device.' },
    ],
    prerequisites: [
      'Compatible public Tendriller and Chronolog artifacts; verify the host contract before creating a page.',
      'An owner email and owner sign-in to claim the page.',
      'An application bootstrap exporting openSession({ signal }) and returning { session, control? } for session commands.',
      'Explicit enrollment, device grants and persistent signer storage; a page token alone does not grant application data or publication rights.',
      'A saved signed initial-generation request and its selected generation; configuring authority alone is insufficient to open the session.',
    ],
    authorization_checkpoints: [
      'The human owner signs in to claim the page.',
      'An authorized administrator enrolls devices and grants the required application and publisher rights.',
      'A person reviews any proposed recovery loss or irreversible external action before it is applied.',
    ],
    completion: [
      'Lead the handoff with the live page, selected publication receipt, observed bidirectional commands and running process/resume details; source files alone are not the requested application.',
      'A loaded or published page alone does not establish a connected application.',
      'Verify a domain command, coherent query, reopen and peer exchange in the intended environment.',
      'When setup is blocked, report the missing artifact or authority and the next concrete step; keep the selected platform-native path.',
    ],
  };
}

/** Discovery needs a service origin, never an API credential or page URL. */
export function publicServiceOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw Object.assign(Error('--server requires a Tendriller service origin, such as https://tendriller.dev'), { exit: 64 }); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && local)) {
    throw Object.assign(Error('--server requires an HTTPS service origin without credentials, path, query or fragment (HTTP is allowed for loopback development)'), { exit: 64 });
  }
  return url.origin;
}
