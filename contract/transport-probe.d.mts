export declare const EXIT_CODES: {
  readonly READY: 0;
  readonly CAPABILITY_MISSING: 2;
  readonly INTEGRITY_FAILURE: 3;
  readonly LOCK_CONFLICT: 4;
};
export declare function detectProxyEnvironment(env?: Record<string, string | undefined>): {
  readonly configured: boolean;
  readonly httpProxy: string | null;
  readonly httpsProxy: string | null;
  readonly noProxy: string | null;
  readonly customCaConfigured: boolean;
};
export declare function probeTransports(options?: {
  readonly serviceOrigin?: string;
  readonly npmRegistryUrl?: string;
  readonly releaseAssetsUrl?: string;
  readonly fetcher?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<Record<string, unknown>>;
export declare function probeCapabilities(options?: {
  readonly product?: string;
  readonly executionSurface?: string;
  readonly plan?: string;
  readonly projectPath?: string;
  readonly serviceOrigin?: string;
  readonly checkNetwork?: boolean;
  readonly fetcher?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly schemaVersion: 1;
  readonly context: Record<string, unknown>;
  readonly runtime: Record<string, unknown>;
  readonly storage: Record<string, unknown>;
  readonly networking: Record<string, unknown>;
  readonly lifecycle: Record<string, unknown>;
  readonly recommendedRoutes: readonly { readonly route: string; readonly available: boolean | 'unknown'; readonly reason: string }[];
}>;
