import type { WorkerApplicationSession } from '@chronolog/peer-session/browser';
import type { RtcPeerConnection, WorkerWebRtcServer } from '@chronolog/peer-session/webrtc';

export interface BrowserOwnerOptions {
  workerUrl: string | URL;
  profileId: string;
  applicationId: string;
  context?: { viewId?: string; documentPath?: string; publicationId?: string; runId?: string };
  /** Single-active-tab lock handoff over BroadcastChannel. Default `'auto'` seamlessly takes over when this tab/PWA is visible (and never steals while hidden); `false` fails immediately with `TAB_ACTIVE_ELSEWHERE`; `true` takes over unconditionally. */
  takeover?: 'auto' | boolean;
  /** Compatibility hint (all sessions run in a private 1:1 dedicated Worker). */
  mode?: 'auto' | 'dedicated' | 'elected';
  requiresDedicatedWorker?: boolean;
  createPeerConnection?: (configuration: RTCConfiguration) => RtcPeerConnection;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Ask the browser to keep this origin's storage out of best-effort eviction (default true). */
  persistStorage?: boolean;
  /** Default 240000; 0 disables. Keeps Chromium in-memory OPFS record directories active while visible. */
  storageKeepAliveMs?: number;
  onOwnerReplaced?: (context: { previous: string; current?: string; reason?: string }) => void;
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

export declare const TAB_OWNER_PROTOCOL: 'tendriller/tab-owner/v2';
export declare function openBrowserOwner(options: BrowserOwnerOptions): Promise<BrowserOwnerAttachment>;
export declare function createBrowserIdentity(options: Pick<BrowserOwnerOptions, 'workerUrl' | 'profileId' | 'signal' | 'timeoutMs' | 'persistStorage'>): Promise<string>;
export declare function requestPersistentStorage(): Promise<boolean | null>;
export declare function keepStorageInUse(options?: { intervalMs?: number; storagePersisted?: Promise<boolean | null> | boolean | null; now?: () => number; onTick?: (tick: { ms: number; directories: number }) => void }): () => void;
