import { CONTRACT_VERSION, CORE_RELEASE, RESOURCE_LIMITS } from '../../contract/index.mjs';
import { AUTHORITY_PARTICIPANT_LIMITS } from '../../contract/authority.mjs';
import type { Env } from './env';
import { hostAttestationKey } from './host-attestation';
/** Limits of the page host and its filtered participant transport, and the host attestation key pages pin. */
export function serviceDescriptor(env: Env) {
  return { contract: CONTRACT_VERSION, core_release: CORE_RELEASE,
    limits: { participant: AUTHORITY_PARTICIPANT_LIMITS, resources: RESOURCE_LIMITS }, attestationKey: hostAttestationKey(env) };
}
