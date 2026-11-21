export interface OutboxEntry {
  readonly operationId: string;
  readonly appId: string;
  readonly deviceId: string;
  readonly command: string;
  readonly payloadHash: string;
  readonly status: 'recorded' | 'submitted' | 'applied' | 'rejected' | 'unknown';
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly detail?: unknown;
}
export declare function createPersistentOutbox(directory: string): Promise<{
  record(entry: { readonly operationId: string; readonly appId: string; readonly deviceId: string; readonly command: string; readonly input: unknown }): Promise<OutboxEntry>;
  mark(operationId: string, status: OutboxEntry['status'], detail?: unknown): Promise<OutboxEntry | null>;
  list(options?: { readonly pendingOnly?: boolean }): Promise<readonly OutboxEntry[]>;
  get(operationId: string): Promise<OutboxEntry | null>;
}>;
