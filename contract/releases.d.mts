import type {
  ReleaseState, ReleasePublication, SignedReleasePolicy, SignedReleaseManifest,
  SignedReleaseActivationRequest, SignedReleaseActivation,
} from './peer-authority.mjs';
import type { PeerSocket } from './peers.mjs';
export type {
  ReleaseState, ReleaseTrust, ReleaseApplicationBinding, ReleaseAsset, ReleaseManifest, ReleasePublication,
  ReleasePolicy, SignedReleasePolicy, SignedReleaseManifest, ReleaseActivationRequest,
  SignedReleaseActivationRequest, SignedReleaseActivation,
} from './peer-authority.mjs';

export interface ReleasePublisherAccount { readonly publicKey: string; readonly accountId?: string }
export interface HostedReleasePolicyRequest {
  readonly requestId: string;
  readonly expectedPolicy: string | null;
  /** Independent publication keys. Omitted accountId binds a key to the owner account. */
  readonly publishers: readonly ReleasePublisherAccount[];
}
export interface ReleaseBootstrap {
  readonly state: ReleaseState;
  readonly manifest: SignedReleaseManifest | null;
}
export interface ReleaseClient {
  /** Trusted HTTP bootstrap evidence, still verified by the portable Chronolog release client. */
  readonly initial: ReleaseBootstrap | null;
  state(options?: { readonly signal?: AbortSignal }): Promise<ReleaseState>;
  configure(configuration: HostedReleasePolicyRequest, options?: { readonly signal?: AbortSignal }): Promise<SignedReleasePolicy>;
  publish(manifest: SignedReleaseManifest, options?: { readonly signal?: AbortSignal }): Promise<ReleasePublication>;
  manifest(id: string, options?: { readonly signal?: AbortSignal }): Promise<SignedReleaseManifest | null>;
  activate(request: SignedReleaseActivationRequest, options?: { readonly signal?: AbortSignal }): Promise<SignedReleaseActivation>;
  readonly content: {
    put(digest: string, bytes: Uint8Array | ArrayBuffer, options?: { readonly signal?: AbortSignal; readonly mediaType?: string }): Promise<{ digest: string; bytes: number }>;
    /** The exact authored bytes. Rendered HTML with trusted runtime injection uses separate page URLs. */
    get(digest: string, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array>;
  };
  /** Bounded/coalesced signed activation hints; fetch and verify monotonic state before adopting one. */
  watch(options?: { readonly signal?: AbortSignal }): AsyncIterable<SignedReleaseActivation>;
}
export type ReleaseJsonRequest = (path: string, options?: { method?: 'GET' | 'PUT' | 'POST'; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
export type ReleaseRawRequest = (path: string, options?: { method?: 'GET' | 'PUT'; body?: Uint8Array | ArrayBuffer; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
export declare const RELEASE_SOCKET_PROTOCOL: 'tendriller.releases.v1';
export declare function createReleaseClient(options: {
  request: ReleaseJsonRequest; raw: ReleaseRawRequest; openWatch: () => PeerSocket; initial?: ReleaseBootstrap;
}): ReleaseClient;
export declare function createReleaseWatch(socket: PeerSocket, options?: { readonly signal?: AbortSignal }): AsyncIterable<SignedReleaseActivation>;
