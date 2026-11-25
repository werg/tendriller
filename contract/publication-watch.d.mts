export interface PublicationSelectionNotice { readonly type: 'publication'; readonly version: 1; readonly current: number }
export interface PageAgentEntry {
  readonly id: string;
  readonly handle: string;
  readonly bio: string;
  readonly public_key: string;
  readonly kind: 'workspace' | 'hosted-mcp';
  readonly is_primary: boolean;
  readonly granted_at: number;
}
export interface AgentsRosterNotice {
  readonly type: 'agents';
  readonly version: 1;
  readonly primary_agent_id: string | null;
  readonly agents: readonly PageAgentEntry[];
}
export interface McpSyncNotice {
  readonly type: 'mcp-sync';
  readonly version: 1;
}
/** Persistent receive-only page-origin subscription, independent of application enrollment. */
export function watchPublicationUpdates(options: { base: string; signal?: AbortSignal;
  onCurrent(notice: PublicationSelectionNotice): void;
  onAgents?(notice: AgentsRosterNotice): void;
  onMcpSync?(notice: McpSyncNotice): void;
  onStatus?(status: { state: 'connected' | 'reconnecting' | 'access_ended' | 'protocol_error'; retryInMs?: number }): void;
}): { close(): void };
