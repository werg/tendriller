import type { NormalizedStateOperation, StateCondition, StateConflict } from "./index.mjs";
export type NormalizedStateOp = NormalizedStateOperation;
export type NormalizedStateCondition = StateCondition & { path: string[] };
export interface NormalizedStateChecks { conditions?: NormalizedStateCondition[]; expected_revision?: number }
export const STATE_CONDITIONS_MAX: 128;
export const STATE_CONDITIONS_BYTES: number;
export const STATE_DEPTH_MAX: 128;
export class StateInputError extends TypeError { code: string }
export class StatePathError extends Error { code: string; path: string[] }
export function isStateObject(value: unknown): value is Record<string, any>;
export function statePath(path: unknown): string[];
export function assertStateJson(value: unknown): void;
export function normalizeStateOps(raw: unknown): NormalizedStateOp[];
export function normalizeStateChecks(raw?: unknown): NormalizedStateChecks;
export function readStatePath(root: unknown, path: readonly string[]): { exists: boolean; value?: unknown; blocked: boolean };
export function equalStateJson(left: unknown, right: unknown): boolean;
export function stateConflict(state: Record<string, unknown>, rev: number, checks?: NormalizedStateChecks): StateConflict | null;
export function statePaths(ops: readonly NormalizedStateOp[], checks?: NormalizedStateChecks): string[][];
export function applyStateOps<T extends Record<string, any>>(state: T, ops: readonly NormalizedStateOp[]): T;
export function stateMergePatch(state: unknown, patch: unknown, prefix?: string[]): NormalizedStateOp[];
