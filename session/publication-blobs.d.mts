export interface PublicationFileDescriptor {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly type: string;
}

export interface SignedPublicationLike {
  readonly id?: string;
  readonly payload: {
    readonly files: readonly PublicationFileDescriptor[];
  };
}

export interface BlobCapableSession {
  readonly content?: {
    put?(bytes: Uint8Array, options?: {
      readonly visibility?: 'public' | 'private';
      readonly mediaType?: string;
      readonly deduplicate?: boolean;
      readonly signal?: AbortSignal;
    }): Promise<{ readonly hash?: string; readonly id?: string; readonly bytes: number }>;
    get?(target: string | { readonly hash: string; readonly bytes: number; readonly profile: 'chronolog-blob-v2'; readonly visibility: 'public' }, options?: {
      readonly expectedBytes?: number;
      readonly maxBytes?: number;
      readonly localOnly?: boolean;
      readonly cache?: boolean;
      readonly signal?: AbortSignal;
    }): Promise<Uint8Array | null>;
    putBlob?(bytes: Uint8Array, options?: { readonly signal?: AbortSignal }): Promise<{ readonly hash: string; readonly bytes: number }>;
    getBlob?(hash: string, options?: {
      readonly expectedBytes?: number;
      readonly maxBytes?: number;
      readonly localOnly?: boolean;
      readonly cache?: boolean;
      readonly signal?: AbortSignal;
    }): Promise<Uint8Array | null>;
    hasBlob?(hash: string): Promise<boolean>;
    deleteBlob?(hash: string): Promise<void>;
  };
}

export interface RetainPublicationBlobsResult {
  readonly supported: boolean;
  readonly retained: number;
  readonly skipped: number;
}

export interface RecoverPublicationAssetOptions {
  readonly fetchHost?: (file: PublicationFileDescriptor, options: { readonly signal?: AbortSignal }) => Promise<Response | Uint8Array | ArrayBuffer | string | null | undefined>;
  readonly cache?: boolean;
  readonly seedFromHost?: boolean;
  readonly signal?: AbortSignal;
}

export interface RecoveredPublicationAsset {
  readonly source: 'host' | 'peer';
  readonly bytes: Uint8Array;
}

export interface RecoveredPublicationFile extends PublicationFileDescriptor {
  readonly source: 'host' | 'peer';
  readonly bytes: Uint8Array;
}

export interface RecoverPublicationResult {
  readonly complete: boolean;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly files: readonly RecoveredPublicationFile[];
  readonly missing: readonly PublicationFileDescriptor[];
  readonly fromHost: number;
  readonly fromPeers: number;
}

export function retainPublicationBlobs(
  session: BlobCapableSession | null | undefined,
  assets: readonly { readonly hash: string; readonly bytes: Uint8Array | ArrayBuffer | string }[],
  options?: { readonly signal?: AbortSignal },
): Promise<RetainPublicationBlobsResult>;

export function recoverPublicationAsset(
  session: BlobCapableSession | null | undefined,
  file: PublicationFileDescriptor,
  options?: RecoverPublicationAssetOptions,
): Promise<RecoveredPublicationAsset | null>;

export function recoverPublication(
  session: BlobCapableSession | null | undefined,
  publication: SignedPublicationLike,
  options?: RecoverPublicationAssetOptions,
): Promise<RecoverPublicationResult>;
