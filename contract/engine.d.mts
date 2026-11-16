import type { WorkflowModule } from './host.d.mts';

/** Select reviewed implementations in a trusted deployment entry before serving. */
export declare function configureWorkflows(selected: readonly WorkflowModule[]): void;
/** Cloudflare Durable Object bindings exported by the packaged Worker. */
export declare const Tendril: typeof import('cloudflare:workers').DurableObject;
export declare const Admission: typeof import('cloudflare:workers').DurableObject;
declare const handler: ExportedHandler;
export default handler;
