import type { ApplicationSession, ScheduledFinalityEntry, SigningIdentity } from '@chronolog/peer-session';
import type { CreatedPageGenesis, OwnerGrant, PageAuthorityConfig } from './admission.d.mts';

export declare const BLUEPRINT_FORMAT: 'tendriller-page-blueprint/v1';

export interface PageBlueprintSchema {
  readonly topic: string;
  readonly statements: readonly string[];
  readonly policies: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly allowUserDdl: boolean;
}

export interface PageBlueprint {
  readonly format: typeof BLUEPRINT_FORMAT;
  readonly createdAt: string;
  readonly meta: {
    readonly title: string;
    readonly description: string;
    readonly privateLog: boolean;
    readonly authorityHint: PageAuthorityConfig;
  };
  readonly reducers: {
    readonly imports: Readonly<Record<string, string>>;
    readonly topics: Readonly<Record<string, unknown>>;
    readonly casModules: readonly { readonly hash: string; readonly bytesBase64: string }[];
  };
  readonly schemas: readonly PageBlueprintSchema[];
  readonly publication: {
    readonly entry: string;
    readonly files: readonly { readonly path: string; readonly hash: string; readonly size: number; readonly type: string }[];
  } | null;
}

export declare function exportPageBlueprint(
  session: ApplicationSession,
  options?: {
    readonly title?: string;
    readonly description?: string;
    readonly includeSchema?: boolean;
    readonly includePublication?: boolean;
  },
): Promise<PageBlueprint>;

export declare function validatePageBlueprint(blueprint: unknown): {
  readonly moduleBytesByHash: Map<string, Uint8Array>;
};

export declare function createGenesisFromBlueprint(options: {
  readonly blueprint: PageBlueprint;
  readonly identity: SigningIdentity;
  readonly wrapKey: string;
  readonly hostKey?: string;
  readonly accounts?: readonly string[];
  readonly ownerGrant?: OwnerGrant | 'reader' | 'writer' | 'admin';
  readonly authority?: PageAuthorityConfig;
  readonly admission?: null;
  readonly privateLog?: boolean;
  readonly finalitySchedule?: readonly ScheduledFinalityEntry[];
}): Promise<CreatedPageGenesis & {
  readonly initialMigrations: readonly { readonly topic: string; readonly input: Record<string, unknown> }[];
}>;
