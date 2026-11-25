import type { ApplicationSession, ApplicationSessionOwner, ApplicationOwnerOptions } from '@chronolog/peer-session';
export interface BrowserOwnerConfiguration {
  profileId:string;
  openSession:(options:{signal:AbortSignal;openDirectConnection:(options:import('@chronolog/peer-session/webrtc').WebRtcOptions)=>Promise<import('@chronolog/peer-session/webrtc').WorkerWebRtcConnection>})=>Promise<{session:ApplicationSession;close?:()=>Promise<void>}>;
  createIdentity?:(options:{signal:AbortSignal})=>Promise<string>;
  ownerOptions?:ApplicationOwnerOptions;
  /** Bounded SharedWorker bootstrap roots; expiry detaches only that root, never the owner lock. */
  rootLimits?:{maxPorts?:number;pendingTimeoutMs?:number;idleTimeoutMs?:number;/** Default 60000 (100..120000): coalesced worker-local witness sweep while roots are parked. Healthy held witnesses never expire. */parkedSweepMs?:number;/** Default 5000: how long a retired elected owner without routes waits for a same-page reattach. */retireGraceMs?:number};
}
export interface BrowserOwnerScope extends EventTarget { postMessage(message:unknown):void; start?():void; close?():void }
/** load registers root listeners before awaiting configuration, preserving initial Worker events. */
export declare function serveBrowserOwner(options:(BrowserOwnerConfiguration | {
  load:(options:{signal:AbortSignal})=>BrowserOwnerConfiguration|Promise<BrowserOwnerConfiguration>;
}) & {scope?:BrowserOwnerScope}):{readonly owner:ApplicationSessionOwner|undefined;close():Promise<void>};

