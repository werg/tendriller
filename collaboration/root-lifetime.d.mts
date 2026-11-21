/** Unique per-root document witness; workers only query this namespace. */
export declare function rootLifetimeLockName(profileId:string,rootId:string):string;
/** Acquire before shared boot. Retain through hide/freeze; release on detach/error. */
export declare function acquireRootLifetime(profileId:string,rootId:string,options?:{
  signal?:AbortSignal;locks?:Pick<LockManager,'request'|'query'>;
}):Promise<Readonly<{name:string;release():Promise<void>}>>;
/** Validates the entire held snapshot before returning a matching witness. */
export declare function rootLifetimeWitness(snapshot:unknown,profileId:string,rootId:string):{name:string;clientId:string}|undefined;
