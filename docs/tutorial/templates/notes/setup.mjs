import { bytesToHex, eventExecutionManifest, executionManifestArtifacts } from '@chronolog/peer-session';
import { prepareHost } from '../../shared/helpers/prepare-host.mjs';
import { initializePageData } from '../../shared/helpers/page-data.mjs';
import { definition } from './domain.mjs';
export async function initializePage(context, { requestedFinality, browserFirst = false } = {}) {
  const execution = await executionManifestArtifacts(await eventExecutionManifest());
  const executionManifestDigest = bytesToHex(execution.executionManifestDigest);
  const prepared = await prepareHost(context, { definition, executionManifestDigest, executionProfile: 'events', requestedFinality });
  return { ...prepared, ...await initializePageData(context, { executionManifestDigest, browserFirst }) };
}
