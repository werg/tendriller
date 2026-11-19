import type { ApplicationSession, ApplicationSessionOwner, ApplicationOwnerOptions } from '@chronolog/peer-session';
export interface BrowserOwnerConfiguration {
  profileId:string;
  openSession:(options:{signal:AbortSignal})=>Promise<{session:ApplicationSession;control?:ApplicationOwnerOptions['host'];close?:()=>Promise<void>}>;
  createIdentity?:(options:{signal:AbortSignal})=>Promise<string>;
  ownerOptions?:ApplicationOwnerOptions;
  /** Bounded SharedWorker bootstrap roots; expiry detaches only that root, never the owner lock. */
  rootLimits?:{maxPorts?:number;pendingTimeoutMs?:number;idleTimeoutMs?:number};
}
export interface BrowserOwnerScope extends EventTarget { postMessage(message:unknown):void; start?():void; close?():void }
/** load registers root listeners before awaiting configuration, preserving initial Worker events. */
export declare function serveBrowserOwner(options:(BrowserOwnerConfiguration | {
  load:(options:{signal:AbortSignal})=>BrowserOwnerConfiguration|Promise<BrowserOwnerConfiguration>;
}) & {scope?:BrowserOwnerScope}):{readonly owner:ApplicationSessionOwner|undefined;close():Promise<void>};
