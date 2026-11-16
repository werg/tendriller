import type { OperationOptions, ScopeDescriptor, StateChecks } from "../../contract/index.mjs";
import { assertValid } from "../../contract/index.mjs";
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

const invalidContext = (message: string) => Object.assign(new TypeError(message), { code: "bad_request" });
const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (Object.getPrototypeOf(prototype) === null
    && Object.getOwnPropertyDescriptor(prototype, "constructor")?.value?.name === "Object");
};
const guardValue = (options: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  if (!descriptor) {
    if (key in options) throw invalidContext(`Operation ${key} must be an own data property`);
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) throw invalidContext(`Operation ${key} must be an enumerable data property`);
  return descriptor.value;
};

/** A context is captured once when work is created; delivery never refreshes it. */
export function captureContext(scopes: readonly ScopeDescriptor[], operation: string, options: OperationOptions & StateChecks = {}, ops: readonly Op[] = []): OperationContext {
  if (!plainRecord(options)) throw invalidContext("Operation context must be a plain object");
  // Validate before copying: a string, array or null must not silently become
  // a different guard map. Omission still selects the operation's known scopes.
  const scope = guardValue(options, "scope"), supplied = guardValue(options, "expected_generations");
  if (scope !== undefined) assertValid("scopeId", scope);
  if (supplied !== undefined) {
    if (!plainRecord(supplied)) throw invalidContext("Expected generations must be a plain scope-to-token map");
    for (const key of Reflect.ownKeys(supplied)) {
      const descriptor = Object.getOwnPropertyDescriptor(supplied, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
        throw invalidContext("Expected generations must contain enumerable string-keyed data properties");
    }
    assertValid("generationMap", supplied);
  }
  const selected = scope as string | undefined;
  const conditions = operation === "state" ? (options as OperationOptions & StateChecks).conditions || [] : [];
  const paths = [...ops.map(op => toPath(op.path)), ...conditions.map(condition => toPath(condition.path))];
  const required = requiredScopes(scopes, operation, paths, selected);
  if (selected && !scopes.some(binding => binding.id === selected)) {
    throw Object.assign(new Error(`Scope ${selected} is not active on this page.`), { code: "unknown_scope" });
  }
  const expected = supplied !== undefined
    ? { ...supplied as Record<string, string> }
    : Object.fromEntries(required.map(binding => [binding.id, binding.generation]));
  return { ...(selected ? { scope: selected } : {}), expected_generations: expected };
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
