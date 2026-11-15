import { CONTRACT_VERSION, CORE_RELEASE, RESOURCE_LIMITS, STREAM_LIMITS } from '../../contract/index.mjs';
import type { Tendril } from './tendril';
import { workflowDescriptors } from './workflows';
import { effectiveStreamLimits } from './streams/limits';

/** Deployment capabilities plus the actual allowance of a requested page. */
export function serviceDescriptor(t?: Tendril) {
  return {
    contract: CONTRACT_VERSION,
    core_release: CORE_RELEASE,
    workflows: workflowDescriptors(),
    limits: {
      resources: RESOURCE_LIMITS,
      streams: STREAM_LIMITS,
      ...(t ? { effective: {
        resources: { ...RESOURCE_LIMITS, file_bytes: t.fileLimit(), blob_bytes: t.blobLimit() },
        streams: effectiveStreamLimits(t),
      } } : {}),
    },
  };
}
