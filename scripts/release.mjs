import { resolve } from 'node:path';
import { CORE_RELEASE, CONTRACT_VERSION } from '../contract/index.mjs';
import { sealDeployment } from './deployment-bundle.mjs';
import { prepareRelease } from './release-composition.mjs';

prepareRelease({ root: resolve(import.meta.dirname, '..'), version: CORE_RELEASE, contract: CONTRACT_VERSION });
const manifest = sealDeployment(resolve(import.meta.dirname, '..'));
console.log(`Prepared ${manifest.artifacts.length} immutable release assets from ${manifest.source_commit}; composition ${manifest.composition.id}`);
