export interface ReleaseDownloadLimits {
  readonly metadataBytes: number;
  readonly artifactBytes: number;
  readonly totalBytes: number;
  readonly artifacts: number;
  readonly redirects: number;
  readonly timeoutMs: number;
}
export declare const RELEASE_DOWNLOAD_LIMITS: Readonly<ReleaseDownloadLimits>;
export declare function validateRedirectTarget(location: string, previous: URL, initial: URL, allowedHosts?: ReadonlySet<string>): URL;
export declare function createReleaseDownloader(baseUrl: string, options?: {
  readonly fetcher?: typeof globalThis.fetch;
  readonly limits?: ReleaseDownloadLimits;
  readonly allowedHosts?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
  readonly onVerified?: (file: string, content: Uint8Array) => void | Promise<void>;
}): {
  download(file: string, expectedHash?: string, expectedSize?: number, retain?: boolean): Promise<Uint8Array | undefined>;
  readonly downloadedBytes: number;
};
export declare function readPublishedManifest(sourceCommit: string, options?: {
  readonly repository?: string;
  readonly fetcher?: typeof globalThis.fetch;
  readonly limits?: ReleaseDownloadLimits;
  readonly signal?: AbortSignal;
}): Promise<Uint8Array>;
export declare function writeVerifiedFileAtomic(targetPath: string, bytes: Uint8Array): void;
export declare function extractVerifiedTarGz(archiveBytes: Uint8Array, targetDirectory: string, options?: {
  readonly expectedSha256?: string;
  readonly stripPrefix?: string;
  readonly preserveExisting?: (relativePath: string, absolutePath: string) => boolean;
  readonly maxTotalBytes?: number;
}): {
  readonly written: readonly string[];
  readonly preserved: readonly string[];
  readonly sha256: string;
};
