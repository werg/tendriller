/** Shared state semantics used by the authoritative engine and browser runtime. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
export const STATE_CONDITIONS_MAX = 128;
export const STATE_CONDITIONS_BYTES = 64 * 1024;
export const STATE_DEPTH_MAX = 128;

export class StateInputError extends TypeError {
  code = "bad_ops";
}
export class StatePathError extends Error {
  code = "state_conflict";
  constructor(path) {
    super("A state path crosses an existing non-object value; replace that parent explicitly");
    this.path = path;
  }
}
export function isStateObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  // Plain data from another window/realm is still JSON. Class instances, dates
  // and inherited application records are not silently flattened.
  return prototype === null || (Object.getPrototypeOf(prototype) === null &&
    Object.getOwnPropertyDescriptor(prototype, "constructor")?.value?.name === "Object");
}
export function statePath(path) {
  const parts = typeof path === "string" ? path.split(".").filter(part => part !== "") : path;
  if (!Array.isArray(parts) || parts.length > STATE_DEPTH_MAX)
    throw new StateInputError(`State paths must contain at most ${STATE_DEPTH_MAX} keys`);
  assertStateJson(parts);
  return parts.map(key => {
    if (typeof key !== "string" && !Number.isSafeInteger(key)) throw new StateInputError("State path keys must be strings or safe integers");
    const result = String(key);
    if (FORBIDDEN.has(result)) throw new StateInputError(`State key "${result}" is not allowed`);
    return result;
  });
}

/** Reject values that JSON serialization would silently change or omit. */
export function assertStateJson(value, depth = 0, ancestors = new Set()) {
  if (depth > STATE_DEPTH_MAX) throw new StateInputError(`State nesting exceeds ${STATE_DEPTH_MAX} levels`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !isStateObject(value)) throw new StateInputError("State values must be finite JSON values");
  if (ancestors.has(value)) throw new StateInputError("State values must not contain cycles");
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new StateInputError("State arrays must be dense JSON arrays without extra properties");
    for (let index = 0; index < value.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry || !("value" in entry) || !entry.enumerable) throw new StateInputError("State arrays must contain JSON values");
      assertStateJson(entry.value, depth + 1, ancestors);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || FORBIDDEN.has(key)) throw new StateInputError(`State key "${String(key)}" is not allowed`);
      const entry = Object.getOwnPropertyDescriptor(value, key);
      if (!entry.enumerable || !("value" in entry)) throw new StateInputError("State objects must contain enumerable JSON values");
      assertStateJson(entry.value, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
}
const copy = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.hasOwn(value, key);

export function normalizeStateOps(raw) {
  if (!Array.isArray(raw)) throw new StateInputError("ops must be an array");
  assertStateJson(raw);
  return raw.map(operation => {
    if (!isStateObject(operation) || !own(operation, "path")) throw new StateInputError("Each state operation needs a path");
    const path = statePath(operation.path);
    if (operation.op === "set" && own(operation, "value") && Object.keys(operation).every(key => ["op", "path", "value"].includes(key))) {
      assertStateJson(operation.value);
      if (!path.length && !isStateObject(operation.value)) throw new StateInputError("The root state must be an object");
      return { op: "set", path, value: copy(operation.value) };
    }
    if (operation.op === "delete" && Object.keys(operation).every(key => ["op", "path"].includes(key))) {
      if (!path.length) throw new StateInputError("Cannot delete the root");
      return { op: "delete", path };
    }
    throw new StateInputError("Expected a set operation with a JSON value or a delete operation");
  });
}

/** Normalize and detach once, before a caller admits a command to durable storage. */
export function normalizeStateChecks(raw = {}) {
  if (!isStateObject(raw)) throw new StateInputError("State preconditions must be an object");
  const result = {};
  if (own(raw, "expected_revision")) {
    if (!Number.isSafeInteger(raw.expected_revision) || raw.expected_revision < 0)
      throw new StateInputError("expected_revision must be a non-negative safe integer");
    result.expected_revision = raw.expected_revision;
  }
  if (own(raw, "conditions")) {
    if (!Array.isArray(raw.conditions) || raw.conditions.length > STATE_CONDITIONS_MAX)
      throw new StateInputError(`At most ${STATE_CONDITIONS_MAX} state conditions are allowed`);
    assertStateJson(raw.conditions);
    result.conditions = raw.conditions.map(condition => {
      if (!isStateObject(condition) || !own(condition, "path")) throw new StateInputError("Each state condition needs a path");
      const path = statePath(condition.path);
      if (own(condition, "equals") && Object.keys(condition).every(key => ["path", "equals"].includes(key))) {
        assertStateJson(condition.equals);
        return { path, equals: copy(condition.equals) };
      }
      if (typeof condition.exists === "boolean" && own(condition, "exists") && Object.keys(condition).every(key => ["path", "exists"].includes(key)))
        return { path, exists: condition.exists };
      throw new StateInputError("Each state condition must have exactly one of equals or exists");
    });
    if (new TextEncoder().encode(JSON.stringify(result.conditions)).byteLength > STATE_CONDITIONS_BYTES)
      throw new StateInputError(`State conditions exceed ${STATE_CONDITIONS_BYTES} bytes`);
  }
  return result;
}

/** Arrays are whole values. An incompatible ancestor is distinct from a missing path. */
export function readStatePath(root, path) {
  let value = root;
  for (const key of path) {
    if (!isStateObject(value)) return { exists: false, blocked: true };
    if (!own(value, key)) return { exists: false, blocked: false };
    value = value[key];
  }
  return { exists: true, value, blocked: false };
}
export function equalStateJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => equalStateJson(value, right[index]));
  if (!isStateObject(left) || !isStateObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && equalStateJson(left[key], right[key]));
}
export function stateConflict(state, rev, checks = {}) {
  if (checks.expected_revision !== undefined && checks.expected_revision !== rev) return { kind: "revision" };
  for (const [index, condition] of (checks.conditions || []).entries()) {
    const observed = readStatePath(state, condition.path);
    if (observed.blocked || (own(condition, "equals") ? !observed.exists || !equalStateJson(observed.value, condition.equals) : observed.exists !== condition.exists))
      return { kind: "condition", condition: index, path: condition.path };
  }
  return null;
}
export function statePaths(ops, checks = {}) {
  return [...ops.map(operation => operation.path), ...(checks.conditions || []).map(condition => condition.path)];
}

/** All ops succeed or the input is left unchanged. Existing non-object parents are never inferred away. */
export function applyStateOps(state, ops) {
  let next = copy(state);
  for (const operation of ops) {
    const path = operation.path;
    if (!path.length) { next = copy(operation.value); continue; }
    let node = next, missing = false;
    for (const key of path.slice(0, -1)) {
      if (!own(node, key)) {
        if (operation.op === "delete") { missing = true; break; }
        node[key] = {};
      } else if (!isStateObject(node[key])) throw new StatePathError(path);
      node = node[key];
    }
    if (missing) continue;
    const key = path[path.length - 1];
    if (operation.op === "delete") delete node[key];
    else node[key] = copy(operation.value);
  }
  assertStateJson(next);
  return next;
}

function stripNulls(value) {
  if (!isStateObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, stripNulls(item)]));
}
/** RFC 7396 explicitly replaces a non-object parent with a null-stripped object. */
export function stateMergePatch(state, patch, prefix = []) {
  assertStateJson(patch);
  if (!isStateObject(patch)) throw new StateInputError("A state merge patch must be an object");
  const ops = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = [...prefix, key], present = isStateObject(state) && own(state, key), current = present ? state[key] : undefined;
    if (value === null) { if (present) ops.push({ op: "delete", path }); }
    else if (isStateObject(value)) {
      if (isStateObject(current)) ops.push(...stateMergePatch(current, value, path));
      else ops.push({ op: "set", path, value: stripNulls(value) });
    } else ops.push({ op: "set", path, value });
  }
  return ops;
}
