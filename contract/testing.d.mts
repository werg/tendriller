export interface TestMigration { name: string; queries: string[] }
export type TestWorkflowCall = (module: string, operation: string, data?: unknown, guards?: Record<string, string>, cid?: string) => Promise<Response>;
/** Initialize fresh test storage in the Cloudflare Vitest pool. Never a production API. */
export declare function initializeTestService(migrations: TestMigration[]): Promise<void>;
export declare function createTestPage(): Promise<{
  owner: TestWorkflowCall;
  agent: TestWorkflowCall;
  api(method: string, path: string, body?: unknown): Promise<Response>;
  participant(): Promise<{ account: string; call: TestWorkflowCall }>;
  display(): Promise<TestWorkflowCall>;
  advance(milliseconds: number): Promise<void>;
}>;
