import { onboardingDescriptor } from '@tendriller/core/onboarding';
import { serverBase } from './config.mjs';

/** Public navigation only: generating a guide creates no page, identity or session. */
export function onboardingGuide(flags = {}, env = process.env) {
  const service = publicServiceOrigin(serverBase(env, flags));
  const shared = onboardingDescriptor(service);
  const url = path => service + path;
  return {
    service,
    network_checked: false,
    onboarding: shared,
    mcp_guide: shared.documentation.mcp,
    start_here: shared.start_here,
    agent_guide: shared.agent_instructions,
    capabilities: shared.capabilities,
    capability_guide: shared.documentation.capabilities,
    delivery_guide: shared.documentation.delivery,
    patterns: url('/docs/APP_PATTERNS.md'),
    preview: url('/docs/tools/PREVIEW.md'),
    primary_deliverable: shared.delivery.primary,
    troubleshooting: shared.documentation.troubleshooting,
    service_descriptor: shared.interfaces.service_descriptor,
    next: `tendril service --server ${service}`,
    workflow: shared.workflow,
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
