// The canonical service binds fresh revision-4 namespaces. The public engine
// entry keeps its generic class exports for independent trusted deployments.
import { Tendril } from './tendril';
import { Admission } from './admission';

export class TendrilV4 extends Tendril {}
export class AdmissionV4 extends Admission {}
export { default } from './index';
