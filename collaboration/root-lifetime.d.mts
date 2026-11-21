/** Unique per-root document witness; workers only query this namespace. */
export declare function rootLifetimeLockName(profileId:string,rootId:string):string;
/** Acquire before shared boot or elected hello. Retain through hide/freeze; release on detach/error. */
export declare function acquireRootLifetime(profileId:string,rootId:string,options?:{
  signal?:AbortSignal;locks?:Pick<LockManager,'request'|'query'>;
}):Promise<Readonly<{name:string;release():Promise<void>}>>;
/** Validates the entire held snapshot before returning a matching witness. */
export declare function rootLifetimeWitness(snapshot:unknown,profileId:string,rootId:string):{name:string;clientId:string}|undefined;
/** Shared query/sweep registry for document-owned shared roots and elected routes. */
export declare function createDocumentLifetimeObserver(options:{
  profileId:string;locks?:Pick<LockManager,'query'>;sweepMs?:number;timeoutMs?:number;signal?:AbortSignal;
}):Readonly<{
  readonly hasParked:boolean;
  prove(rootId:string):Promise<{name:string;clientId:string}>;
  register(rootId:string,witness:{name:string;clientId:string},retire:()=>void):Readonly<{setParked(value:boolean):void;close():void}>;
  reapFresh():Promise<void>;
  close():void;
}>;
