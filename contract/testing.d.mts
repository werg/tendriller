export interface TestMigration { name: string; queries: string[] }
export type TestWorkflowCall = (module: string, operation: string, data?: unknown, guards?: Record<string, string>, cid?: string) => Promise<Response>;
/** Initialize fresh test storage in the Cloudflare Vitest pool. Never a production API. */
export declare function initializeTestService(migrations: TestMigration[]): Promise<void>;
export declare function createTestPage(options?: { application?: { kind: 'cloudflare' | 'peer'; id: string }; lifetime?: 'ad_hoc' | 'resident' }): Promise<{
  owner: TestWorkflowCall;
  agent: TestWorkflowCall;
  api(method: string, path: string, body?: unknown): Promise<Response>;
  ownerApi(method: string, path: string, body?: unknown): Promise<Response>;
  participant(): Promise<{ account: string; call: TestWorkflowCall; api(method: string, path: string, body?: unknown): Promise<Response> }>;
  display(): Promise<TestWorkflowCall>;
  advance(milliseconds: number): Promise<void>;
  /** Restarts the real Durable Object after a forced abort, retaining its persistent store. */
  restart(): Promise<void>;
}>;
