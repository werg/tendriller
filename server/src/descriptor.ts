import { CONTRACT_VERSION, CORE_RELEASE, RESOURCE_LIMITS } from '../../contract/index.mjs';
import { PARTICIPANT_LIMITS } from '../../contract/participant.mjs';
import type { Tendril } from './tendril';
/** Limits of the page host and its filtered participant transport. */
export function serviceDescriptor(t?: Tendril) {
  return { contract: CONTRACT_VERSION, core_release: CORE_RELEASE,
    limits: { participant: PARTICIPANT_LIMITS, resources: RESOURCE_LIMITS,
      ...(t ? { effective: { resources: { ...RESOURCE_LIMITS, file_bytes: t.fileLimit() } } } : {}) } };
}
