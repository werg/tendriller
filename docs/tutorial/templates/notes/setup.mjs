import { bytesToHex, eventExecutionManifest, executionManifestArtifacts } from '@chronolog/peer-session';
import { prepareHost } from '../../shared/helpers/prepare-host.mjs';
import { definition } from './domain.mjs';
export async function initializePage(context, { requestedFinality } = {}) {
  const execution = await executionManifestArtifacts(await eventExecutionManifest());
  return prepareHost(context, { definition, executionManifestDigest: bytesToHex(execution.executionManifestDigest), executionProfile: 'events', requestedFinality });
}
