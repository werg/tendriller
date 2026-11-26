import type { ApplicationSession, ApplicationSessionOwner, ApplicationOwnerOptions, ApplicationOwnerExtensions } from '@chronolog/peer-session';
import type { WebRtcOptions, WorkerWebRtcConnection } from '@chronolog/peer-session/webrtc';

export interface BrowserOwnerConfiguration {
  profileId: string;
  openSession: (options: {
    signal: AbortSignal;
    openDirectConnection: (options: Omit<WebRtcOptions, 'createPeerConnection'>) => Promise<WorkerWebRtcConnection>;
  }) => Promise<{ session: ApplicationSession; close?: () => Promise<void>; extensions?: ApplicationOwnerExtensions }>;
  createIdentity?: (options: { signal: AbortSignal }) => Promise<string>;
  ownerOptions?: ApplicationOwnerOptions;
}

export interface BrowserOwnerScope extends EventTarget {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close?(): void;
}

/** Serves one private 1:1 dedicated Worker owned by the active browser tab. */
export declare function serveBrowserOwner(options: (BrowserOwnerConfiguration | {
  load: (options: { signal: AbortSignal }) => BrowserOwnerConfiguration | Promise<BrowserOwnerConfiguration>;
}) & { scope?: BrowserOwnerScope }): { readonly owner: ApplicationSessionOwner | undefined; close(): Promise<void> };
