import type { CloudflareWorkersModule, ExportedHandler } from '@cloudflare/workers-types';

/** Cloudflare Durable Object bindings exported by the packaged Worker. */
export declare const Tendril: typeof CloudflareWorkersModule.DurableObject;
export declare const Admission: typeof CloudflareWorkersModule.DurableObject;
export declare const AgentHub: typeof CloudflareWorkersModule.DurableObject;
/** The packaged engine always serves requests and scheduled reconciliation. */
declare const handler: Required<Pick<ExportedHandler, 'fetch' | 'scheduled'>>;
export default handler;
