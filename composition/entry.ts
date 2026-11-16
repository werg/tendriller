// This is the only build entry allowed to select optional server implementations.
import modules from '../.composition/workflows/index.mjs';
import { implementationVersion } from '../.composition/pin';
import { configureWorkflows } from '../server/src/workflows';
import type { WorkflowModule } from '../contract/host.d.mts';
configureWorkflows((modules as WorkflowModule[]).map(module => ({ ...module, implementationVersion })));
export { default, TendrilV3, Admission } from '../server/src/index';
