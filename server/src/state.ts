// Shared state as path operations (PROTOCOL section 3.2).
import { HttpError, isPlainObject } from "./http";

export type StateOp = { op: "set"; path: string[]; value: unknown } | { op: "delete"; path: string[] };

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function normPath(p: unknown): string[] {
  const arr = typeof p === "string" ? p.split(".").filter((s) => s !== "") : p;
  if (!Array.isArray(arr)) throw new HttpError(400, "bad_ops", "Op path must be an array of keys");
  return arr.map((k) => {
    if (typeof k === "number") return String(k);
    if (typeof k !== "string") throw new HttpError(400, "bad_ops", "Op path keys must be strings");
    if (FORBIDDEN.has(k)) throw new HttpError(400, "bad_ops", `Key "${k}" is not allowed`);
    return k;
  });
}

/** Validates and normalises a list of ops from a client. */
export function validateOps(raw: unknown): StateOp[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "bad_ops", "ops must be an array");
  return raw.map((o) => {
    if (!isPlainObject(o)) throw new HttpError(400, "bad_ops", "Each op must be an object");
    const path = normPath(o.path);
    if (o.op === "set") {
      if (path.length === 0 && !isPlainObject(o.value)) throw new HttpError(400, "bad_ops", "The root state must be an object");
      return { op: "set", path, value: o.value === undefined ? null : o.value };
    }
    if (o.op === "delete") {
      if (path.length === 0) throw new HttpError(400, "bad_ops", "Cannot delete the root");
      return { op: "delete", path };
    }
    throw new HttpError(400, "bad_ops", `Unknown op "${String(o.op)}"`);
  });
}

function stripNulls(v: unknown): unknown {
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null) continue;
    if (FORBIDDEN.has(k)) continue;
    out[k] = stripNulls(x);
  }
  return out;
}

/**
 * Converts an RFC 7396 merge patch into leaf ops against the current state.
 * Where the target is not an object the whole (null-stripped) subtree is one `set`.
 */
export function mergePatchToOps(state: Record<string, unknown>, patch: Record<string, unknown>, prefix: string[] = []): StateOp[] {
  const ops: StateOp[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN.has(k)) throw new HttpError(400, "bad_ops", `Key "${k}" is not allowed`);
    const path = [...prefix, k];
    const cur = state[k];
    if (v === null) {
      if (cur !== undefined) ops.push({ op: "delete", path });
    } else if (isPlainObject(v)) {
      if (isPlainObject(cur)) ops.push(...mergePatchToOps(cur, v, path));
      else ops.push({ op: "set", path, value: stripNulls(v) });
    } else {
      ops.push({ op: "set", path, value: v });
    }
  }
  return ops;
}

/** Ops that turn `state` into `next` at top-level granularity (used for PUT). */
export function replaceToOps(state: Record<string, unknown>, next: Record<string, unknown>): StateOp[] {
  const ops: StateOp[] = [];
  for (const k of Object.keys(state)) if (!(k in next)) ops.push({ op: "delete", path: [k] });
  for (const [k, v] of Object.entries(next)) {
    if (FORBIDDEN.has(k)) throw new HttpError(400, "bad_ops", `Key "${k}" is not allowed`);
    ops.push({ op: "set", path: [k], value: v });
  }
  return ops;
}

/** Applies ops in order, mutating and returning `state`. Last writer wins per path. */
export function applyOps(state: Record<string, any>, ops: StateOp[]): Record<string, any> {
  for (const op of ops) {
    if (op.path.length === 0) {
      if (op.op === "set") {
        for (const k of Object.keys(state)) delete state[k];
        Object.assign(state, structuredClone(op.value));
      }
      continue;
    }
    let node: Record<string, any> = state;
    const last = op.path[op.path.length - 1];
    let ok = true;
    for (const key of op.path.slice(0, -1)) {
      if (!isPlainObject(node[key])) {
        if (op.op === "delete") {
          ok = false;
          break;
        }
        node[key] = {};
      }
      node = node[key];
    }
    if (!ok) continue;
    if (op.op === "set") node[last] = op.value;
    else delete node[last];
  }
  return state;
}
