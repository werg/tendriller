import { bytesToHex, executionManifestArtifacts } from '@chronolog/peer-session';
import { createDoltLiteExecutionManifest, digestEngineManifest } from '@chronolog/peer-session/sql-browser';
import { prepareBrowserEngine } from './engine.mjs';
import { prepareHost } from '../../shared/helpers/prepare-host.mjs';
import { definition } from './domain.mjs';
export const databasePathOf = context => context.privatePath('materialized.sqlite');
// Browser WASM acquisition/verification only: never load a native addon in setup.
export const preflight = () => prepareBrowserEngine();
export async function initializePage(context, { requestedFinality } = {}) {
  const manifest = await prepareBrowserEngine();
  const execution = createDoltLiteExecutionManifest({ engineDigest: digestEngineManifest(manifest.nativeManifest) });
  return prepareHost(context, { definition, executionManifestDigest: bytesToHex((await executionManifestArtifacts(execution)).executionManifestDigest), executionProfile: 'sql', requestedFinality });
}
