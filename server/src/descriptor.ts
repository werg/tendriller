import { CONTRACT_VERSION, CORE_RELEASE, RESOURCE_LIMITS } from '../../contract/index.mjs';
import { AUTHORITY_PARTICIPANT_LIMITS } from '../../contract/authority.mjs';
/** Limits of the page host and its filtered participant transport. */
export function serviceDescriptor() {
  return { contract: CONTRACT_VERSION, core_release: CORE_RELEASE,
    limits: { participant: AUTHORITY_PARTICIPANT_LIMITS, resources: RESOURCE_LIMITS } };
}
