import { pathToFileURL } from 'node:url';
import { createPage, describeService, requireService, requireServiceOrigin, describeReadiness, requireCreationReady } from '@tendriller/core';
import { describeApplication, executionManifestArtifacts, bytesToHex } from '@chronolog/peer-session';
import { createDoltLiteExecutionManifest, digestEngineManifest } from '@chronolog/peer-session/sql-browser';
import { prepareBrowserEngine } from './engine.mjs';
import { prepareHost } from '../helpers/prepare-host.mjs';
import { definition } from './domain.mjs';
import { project, readPrivate, savePrivate, requireFreshProject } from './local.mjs';
export async function createProject(service, owner, name = 'Shared inventory') {
  const origin = requireServiceOrigin(service), existing = await readPrivate('handle.json', true);
  if (existing) { if (new URL(existing.api).origin !== origin) throw Object.assign(Error('Resume this retained handle at its original service origin'), { code: 'service_origin_mismatch' }); return { page_url: existing.page_url, resumed: true, next: 'npm run init && npm run deploy' }; }
  await requireFreshProject(); requireCreationReady(await describeReadiness(origin), { service: origin }); requireService(await describeService(origin));
  await prepareBrowserEngine();
  await requireFreshProject(); const handle = await createPage(origin, { owner, name }); await savePrivate('handle.json', handle);
  return { page_url: handle.page_url, next: 'Prepare and publish the SQL browser graph before owner sign-in. No native data participant is required.' };
}
export async function initializeProject({ requestedFinality } = {}) {
  const { handle, host } = await project();
  const manifest = await prepareBrowserEngine();
  const execution = createDoltLiteExecutionManifest({ engineDigest: digestEngineManifest(manifest.nativeManifest) });
  const executionManifestDigest = bytesToHex((await executionManifestArtifacts(execution)).executionManifestDigest);
  return prepareHost({ handle, host, readPrivate, savePrivate, definition, describeApplication, executionManifestDigest, executionProfile: 'sql', requestedFinality });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const [action, ...args] = process.argv.slice(2); console.log(JSON.stringify(action === 'create' ? await createProject(...args) : action === 'init' ? await initializeProject(args[0] === '--browser-finalizer' ? { requestedFinality: { kind: 'browser-signed-frontier' } } : {}) : (() => { throw Error('Use create or init'); })(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
