import { pathToFileURL } from 'node:url';
import { createPage, describeService, requireService, requireServiceOrigin, describeReadiness, requireCreationReady } from '@tendriller/core';
import { describeApplication, eventExecutionManifest, executionManifestArtifacts, bytesToHex } from '@chronolog/peer-session';
import { prepareHost } from './helpers/prepare-host.mjs';
import { definition } from './domain.mjs';
import { project, readPrivate, savePrivate, readHostHandle, requireFreshProject } from './local.mjs';
export async function createProject(service, owner, name = 'Shared notes') {
  const origin = requireServiceOrigin(service);
  const existing = await readHostHandle(true);
  if (existing) {
    if (new URL(existing.api).origin !== origin) throw Object.assign(Error('Resume the original service origin and private handle; do not allocate a replacement.'), { code: 'service_origin_mismatch' });
    return { page_url: existing.page_url, resumed: true, next: 'npm run init && npm run deploy' };
  }
  await requireFreshProject();
  requireCreationReady(await describeReadiness(origin), { service: origin });
  requireService(await describeService(origin));
  await requireFreshProject();
  const handle = await createPage(origin, { owner, name });
  await savePrivate('handle.json', handle);
  return { page_url: handle.page_url, next: 'Prepare and publish before owner sign-in: npm run init && npm run deploy. No native data participant is required.' };
}
export async function initializeProject({ requestedFinality, executionManifestDigest, executionProfile = 'events' } = {}) {
  const { handle, host } = await project();
  if (!executionManifestDigest) executionManifestDigest = bytesToHex((await executionManifestArtifacts(await eventExecutionManifest())).executionManifestDigest);
  return prepareHost({ handle, host, readPrivate, savePrivate, definition, describeApplication, executionManifestDigest, executionProfile, requestedFinality });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [action, ...args] = process.argv.slice(2);
    const result = action === 'create' ? await createProject(...args) : action === 'init'
      ? await initializeProject({ ...(args[0] === '--browser-finalizer' ? { requestedFinality: { kind: 'browser-signed-frontier' } } : {}) })
      : (() => { throw Error('Use create or init; additional devices use explicit browser key provisioning, not native enrollment.'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; }
}
