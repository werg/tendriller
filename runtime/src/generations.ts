import type { OperationOptions, ScopeDescriptor, StateChecks } from "../../contract/index.mjs";
import { toPath, type Op } from "./state";

export interface OperationContext {
  scope?: string;
  expected_generations: Record<string, string>;
}

export { pathsOverlap } from "../../contract/scopes.mjs";
import { selectScopes } from "../../contract/scopes.mjs";

export function requiredScopes(scopes: readonly ScopeDescriptor[], operation: string, paths: readonly string[][] = [], scope?: string): ScopeDescriptor[] {
  return selectScopes(scopes, {operations:[operation],paths,scopes:scope ? [scope] : []});
}

/** A context is captured once when work is created; delivery never refreshes it. */
export function captureContext(scopes: readonly ScopeDescriptor[], operation: string, options: OperationOptions & StateChecks = {}, ops: readonly Op[] = []): OperationContext {
  const paths = [...ops.map(op => toPath(op.path)), ...(operation === "state" ? options.conditions || [] : []).map(condition => toPath(condition.path))];
  const required = requiredScopes(scopes, operation, paths, options.scope);
  if (options.scope && !scopes.some(binding => binding.id === options.scope)) {
    throw Object.assign(new Error(`Scope ${options.scope} is not active on this page.`), { code: "unknown_scope" });
  }
  const expected = options.expected_generations !== undefined
    ? { ...options.expected_generations }
    : Object.fromEntries(required.map(binding => [binding.id, binding.generation]));
  return { ...(options.scope ? { scope: options.scope } : {}), expected_generations: expected };
}

/** Unknown, retired, newly bound and rotated scopes suppress stale optimism. */
export function matchesContext(scopes: readonly ScopeDescriptor[], context: OperationContext & StateChecks, operation: string, ops: readonly Op[] = []): boolean {
  const actual = new Map(scopes.map(binding => [binding.id, binding.generation]));
  for (const [id, generation] of Object.entries(context.expected_generations)) {
    if (actual.get(id) !== generation) return false;
  }
  const paths = [...ops.map(op => toPath(op.path)), ...(operation === "state" ? context.conditions || [] : []).map(condition => toPath(condition.path))];
  for (const binding of requiredScopes(scopes, operation, paths, context.scope)) {
    if (context.expected_generations[binding.id] !== binding.generation) return false;
  }
  return !context.scope || actual.has(context.scope);
}
