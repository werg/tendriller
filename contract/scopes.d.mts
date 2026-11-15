export interface ScopeBinding {id: string; generation: string; paths: string[][]; operations: string[]}
export interface ScopeTargets {paths?: readonly (readonly string[])[]; operations?: readonly string[]; scopes?: readonly string[]}
export function pathsOverlap(left: readonly string[], right: readonly string[]): boolean;
export function operationMatches(binding: string, operation: string): boolean;
export function selectScopes<T extends ScopeBinding>(descriptors: readonly T[], targets?: ScopeTargets): T[];
