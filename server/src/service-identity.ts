import { CORE_RELEASE } from '../../contract/index.mjs';
import type { Env } from './env';
import runtime from './runtime-release.json';
import { isBranchPreview, publicBase } from './urls';

/** Public deployment identity only: never infer production from a hostname. */
export function serviceIdentity(env: Env) {
  const url = new URL(publicBase(env));
  const preview = isBranchPreview(env);
  const label = env.SERVICE_ENVIRONMENT?.trim();
  const source = env.SERVICE_SOURCE_COMMIT ?? (preview ? env.BRANCH_PREVIEW_SHA : undefined);
  return {
    serviceOrigin: url.origin,
    environment: {
      id: url.origin,
      label: label && /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,79}$/.test(label) ? label : url.host,
      kind: preview ? 'preview' : ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'local' : 'deployment',
    },
    build: {
      coreRelease: CORE_RELEASE,
      runtimeId: runtime.id,
      // A release/runtime identity is not an exact Worker source identity.
      // Only an explicitly supplied, valid public source checkpoint is reported.
      sourceCommit: /^[a-f0-9]{40}$/.test(source ?? '') ? source! : null,
    },
  };
}
