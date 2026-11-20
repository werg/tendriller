import type { WorkerApplicationSession } from '@chronolog/peer-session/browser';
export interface BrowserOwnerOptions {workerUrl:string|URL;profileId:string;applicationId:string;definitionId:string;definitionVersion:string;context?:{viewId?:string;documentPath?:string;publicationId?:string;runId?:string};mode?:'auto'|'shared'|'elected';requiresDedicatedWorker?:boolean;signal?:AbortSignal;timeoutMs?:number;livenessTimeoutMs?:number;/** Ask the browser to keep this origin's storage out of best-effort eviction (default true). */persistStorage?:boolean;onOwnerReplaced?:(context:{previous:string;current?:string;reason?:string})=>void}
export declare function openBrowserOwner(options:BrowserOwnerOptions):Promise<{readonly session:WorkerApplicationSession;readonly mode:'shared'|'elected';/** Whether the browser keeps this origin's storage durable (null: unsupported). */readonly storagePersisted:Promise<boolean|null>;suspend():Promise<void>;resume():Promise<WorkerApplicationSession>;detach():Promise<void>}>;
export declare function createBrowserIdentity(options:Pick<BrowserOwnerOptions,'workerUrl'|'profileId'|'signal'|'timeoutMs'|'persistStorage'>):Promise<string>;

/** Ask the browser to keep this origin's storage out of best-effort eviction. Never throws; null when unsupported. */
export declare function requestPersistentStorage():Promise<boolean|null>;
