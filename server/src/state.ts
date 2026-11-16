// Shared state operations and conditional checks (PROTOCOL section 3.2).
import { HttpError } from "./http";
import { normalizeStateOps, normalizeStateChecks, applyStateOps, stateMergePatch, stateConflict, StatePathError, StateInputError } from "../../contract/state.mjs";
import type { NormalizedStateOp, NormalizedStateChecks } from "../../contract/state.mjs";
export { statePaths } from "../../contract/state.mjs";
export type StateOp = NormalizedStateOp;

export function validateOps(raw: unknown): StateOp[] {
  try { return normalizeStateOps(raw); }
  catch (error) { throw new HttpError(400, "bad_ops", error instanceof Error ? error.message : String(error)); }
}
export function validateStateChecks(raw: unknown): NormalizedStateChecks {
  try { return normalizeStateChecks(raw); }
  catch (error) { throw new HttpError(400, "bad_ops", error instanceof Error ? error.message : String(error)); }
}
export function checkState(state: Record<string, unknown>, rev: number, checks: NormalizedStateChecks): void {
  const conflict = stateConflict(state, rev, checks);
  if (conflict) throw new HttpError(409, "state_conflict", "Shared state no longer satisfies this command's preconditions", { rev, conflict });
}
export function applyOps(state: Record<string, any>, ops: readonly StateOp[]): Record<string, any> {
  return applyStateOps(state, ops);
}
export function applyCheckedOps(state: Record<string, unknown>, rev: number, ops: readonly StateOp[]): Record<string, unknown> {
  try { return applyStateOps(state, ops); }
  catch (error) {
    if (error instanceof StatePathError) throw new HttpError(409, "state_conflict", error.message, { rev, conflict: { kind: "path", path: error.path } });
    if (error instanceof StateInputError) throw new HttpError(400, "bad_ops", error.message);
    throw error;
  }
}
export const mergePatchToOps = stateMergePatch;
export function replaceToOps(state: Record<string, unknown>, next: Record<string, unknown>): StateOp[] {
  return validateOps([
    ...Object.keys(state).filter(key => !Object.hasOwn(next, key)).map(key => ({ op: "delete", path: [key] })),
    ...Object.entries(next).map(([key, value]) => ({ op: "set", path: [key], value })),
  ]);
}
