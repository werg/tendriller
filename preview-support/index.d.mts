/** Pure production state/history algorithms for fixture transports. */
export type StateOperation = {op: "set"; path: string[]; value: unknown} | {op: "delete"; path: string[]};
export function validateOps(ops: unknown): StateOperation[];
export function applyOps(state: Record<string, unknown>, ops: readonly StateOperation[]): Record<string, unknown>;
export interface HistoryGap {from: number | null; through: number | null}
export function historyGap(records: readonly {seq: number}[], after: number, boundary: number): HistoryGap;
export function mergeHistoryGaps(first: HistoryGap, second: HistoryGap): HistoryGap;
export function historyPage<T extends {seq: number}>(records: Iterable<T>, options: {after: number; limit: number; latest: number; earliest: number | null; maxBytes?: number; sizeOf?: (record: T) => number}): {records: T[]; cursor: number; gap: HistoryGap; history: {earliest_available_seq: number | null; latest_seq: number; gap: boolean; missing_through: number | null}};

export interface ScopeDescriptor {id: string; generation: string; paths: string[][]; operations: string[]}
export interface OperationContext {scope?: string; expected_generations: Record<string,string>}
export function requiredScopes(scopes: readonly ScopeDescriptor[], operation: string, paths?: readonly string[][], scope?: string): ScopeDescriptor[];
export function captureContext(scopes: readonly ScopeDescriptor[], operation: string, options?: Partial<OperationContext>, ops?: readonly StateOperation[]): OperationContext;
export function matchesContext(scopes: readonly ScopeDescriptor[], context: OperationContext, operation: string, ops?: readonly StateOperation[]): boolean;
