import type { WorkerApplicationSession } from '@chronolog/peer-session/browser';
import type { RtcPeerConnection, WorkerWebRtcServer } from '@chronolog/peer-session/webrtc';

export interface BrowserOwnerOptions {
  workerUrl: string | URL;
  profileId: string;
  applicationId: string;
  context?: { viewId?: string; documentPath?: string; publicationId?: string; runId?: string };
  /** Optional inline page configuration forwarded to the Worker in `boot` (skips fetching `configuration.json`). */
  configuration?: unknown;
  createPeerConnection?: (configuration: RTCConfiguration) => RtcPeerConnection;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Ask the browser to keep this origin's storage out of best-effort eviction (default true). */
  persistStorage?: boolean;
}

export interface BrowserOwnerAttachment {
  readonly session: WorkerApplicationSession;
  readonly mode: 'dedicated';
  /** Direct tab-owned WebRTC peer handles (media tracks + custom `app:*` DataChannels, zero Worker hop). */
  readonly rtc: WorkerWebRtcServer;
  readonly storagePersisted: Promise<boolean | null>;
  suspend(): Promise<void>;
  resume(): Promise<WorkerApplicationSession>;
  detach(): Promise<void>;
}

export declare const TAB_OWNER_PROTOCOL: 'tendriller/tab-owner/v3';
export declare function openBrowserOwner(options: BrowserOwnerOptions): Promise<BrowserOwnerAttachment>;
export declare function createBrowserIdentity(options: Pick<BrowserOwnerOptions, 'workerUrl' | 'profileId' | 'configuration' | 'signal' | 'timeoutMs' | 'persistStorage'>): Promise<string>;
export declare function requestPersistentStorage(): Promise<boolean | null>;
