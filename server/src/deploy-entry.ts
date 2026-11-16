// The canonical service binds fresh revision-5 namespaces. The public engine
// entry keeps its generic class exports for independent trusted deployments.
import { Tendril } from './tendril';
import { Admission } from './admission';

export class TendrilV5 extends Tendril {}
export class AdmissionV5 extends Admission {}
export { default } from './index';
