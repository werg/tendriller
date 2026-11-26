export interface SealedAgentTokenEnvelope {
  readonly v: 1;
  readonly alg: 'X25519-HKDF-A256GCM';
  readonly epk: string;
  readonly iv: string;
  readonly ct: string;
}

export interface UnsealedOutboundTokens {
  readonly access_token: string;
  readonly refresh_token?: string | null;
  readonly token_type?: string;
  readonly scope?: string;
  readonly expires_at?: number | null;
}

export declare function generateConnectionKey(): string;

export declare function unsealAgentTokens(
  wrapPrivateKey: CryptoKey,
  wrapPublicKeyHex: string,
  envelope: string | SealedAgentTokenEnvelope,
  aadContext: string,
): Promise<UnsealedOutboundTokens>;

export interface PageConnectionSummary {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly tier: 'agent-held' | 'host-brokered';
  readonly custody: 'personal' | 'page';
  readonly actions: readonly string[];
  readonly scopes: readonly string[];
  readonly external_label: string | null;
  readonly granted_at: number;
}

export interface PageConnectionsClient {
  list(options?: { signal?: AbortSignal }): Promise<{ can_manage: boolean; connections: PageConnectionSummary[] }>;
  grant(input: { connectionId: string; actions?: readonly string[]; custody?: 'personal' | 'page' }, options?: { signal?: AbortSignal }): Promise<{ granted: true; connection_id: string }>;
  revoke(connectionId: string, options?: { signal?: AbortSignal }): Promise<null>;
  invoke(connectionId: string, connectionKey: string, payload: { action: string; params?: Record<string, string>; query?: Record<string, string>; body?: unknown; method?: string; url?: string; headers?: Record<string, string> }, options?: { signal?: AbortSignal }): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
  rekey(connectionId: string, oldKey: string, newKey: string, options?: { signal?: AbortSignal }): Promise<{ rekeyed: true; id: string }>;
}

export declare function createPageConnectionsClient(
  runtime: { identity: { base: string } },
  options?: { fetch?: typeof globalThis.fetch },
): PageConnectionsClient;

export interface ConnectionHandoffPayload {
  readonly connection: {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    readonly tier: 'agent-held' | 'host-brokered';
    readonly custody: 'personal' | 'page';
    readonly page_id: string | null;
    readonly agent_id: string | null;
    readonly scopes: readonly string[];
    readonly actions: readonly string[];
    readonly external_subject: string | null;
    readonly external_label: string | null;
  };
  readonly connection_key?: string | null;
}

export declare function consumeConnectionCallbackFragment(
  loc?: { hash?: string; pathname?: string; search?: string },
  hist?: { replaceState?: (data: unknown, unused: string, url?: string | URL | null) => void },
): ConnectionHandoffPayload | null;

export declare function listenForConnectionPopup(
  serviceOrigin: string,
  onResult: (payload: ConnectionHandoffPayload) => void,
  target?: EventTarget,
): () => void;
