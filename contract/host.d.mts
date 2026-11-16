import type { StateOperation, StateChecks } from './index.mjs';

/** Authoritative concurrency metadata; never part of application JSON. */
export interface ScopeDescriptor { id: string; generation: string; paths: string[][]; operations: string[] }
export interface Preconditions { cid: string; scope?: string; expected_generations: Record<string, string> }
export interface ValidatedContext { scope?: string; generations: Record<string, string>; workflow?: string; operation?: string }
export interface WorkflowIdentity { kind: 'agent' | 'page'; actor: string; accountId: string | null; role: 'owner' | 'guest' | 'display' | null }
export interface WorkflowRecord<T = unknown> { key: string; value: T }
export interface WorkflowHost {
  readonly identity: Readonly<WorkflowIdentity>;
  readonly context: Readonly<ValidatedContext>;
  now(): number;
  id(): string;
  fail(status: number, code: string, message: string): never;
  readonly records: {
    get<T>(collection: string, key: string): T | null;
    list<T>(collection: string): WorkflowRecord<T>[];
    put(collection: string, key: string, value: unknown): void;
    delete(collection: string, key: string): void;
    clear(collection: string): void;
  };
  readonly state: { get(): { state: Record<string, unknown>; rev: number }; apply(ops: StateOperation[], checks?: StateChecks): number };
  readonly scopes: {
    get(id: string): ScopeDescriptor | null;
    register(id: string, bindings: { paths: string[][]; operations: string[] }, expectedGeneration?: string): ScopeDescriptor;
    rotate(id: string): ScopeDescriptor;
    retire(id: string): void;
  };
  participants(): { id: string; role: 'owner' | 'guest' }[];
  pinBlobs(value: unknown): void;
  emit(data: unknown, options?: { wake?: boolean; audience?: 'agent' }): void;
  notify(topic: string, audience?: 'owner' | 'participants'): void;
  afterCommit(effect: () => void | Promise<void>): void;
}
export interface WorkflowOperation {
  access: 'controller' | 'owner' | 'participant';
  mutate: boolean;
  /** Trusted module-selected scope IDs, independent of generic event payloads. */
  scopes?(data: unknown): string[];
  run(host: WorkflowHost, data: unknown): unknown;
  schema?: Record<string, unknown>;
  description?: string;
}
export interface WorkflowModule {
  id: string;
  interfaceVersion: string;
  schemaVersion: string;
  /** Exact installed artifact identity; independent of interface/schema revisions. */
  implementationVersion: string;
  operations: Readonly<Record<string, WorkflowOperation>>;
}
