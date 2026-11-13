// State path operations (PROTOCOL 3.2). Same algorithm as the server:
// merge patch → leaf ops (nested objects recurse, null deletes, arrays/primitives set whole).
import type { Path } from "./types";

export type Op = { op: "set"; path: string[]; value: any } | { op: "delete"; path: string[] };

export function toPath(p?: Path | null): string[] {
  if (p == null || p === "") return [];
  if (Array.isArray(p)) return p.map(String);
  return String(p).split(".");
}

export function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function stripNulls(v: any): any {
  if (!isPlainObject(v)) return v;
  const out: Record<string, any> = {};
  for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined && !FORBIDDEN.has(k)) out[k] = stripNulls(x);
  return out;
}

/**
 * RFC 7396 merge patch → leaf ops against the current state (mirrors server/src/state.ts):
 * nested objects recurse where the target is an object, otherwise the null-stripped subtree is
 * one `set`; `null` deletes (only if present); arrays and primitives are set whole.
 */
export function mergePatchToOps(state: any, patch: any, prefix: string[] = [], out: Op[] = []): Op[] {
  for (const k of Object.keys(patch)) {
    if (FORBIDDEN.has(k)) throw new Error(`State key "${k}" is not allowed`);
    const v = patch[k];
    const path = [...prefix, k];
    const cur = isPlainObject(state) ? state[k] : undefined;
    if (v === null) { if (cur !== undefined) out.push({ op: "delete", path }); }
    else if (isPlainObject(v)) {
      if (isPlainObject(cur)) mergePatchToOps(cur, v, path, out);
      else out.push({ op: "set", path, value: stripNulls(v) });
    } else if (v !== undefined) out.push({ op: "set", path, value: v });
  }
  return out;
}

export function getPath(root: any, path: string[]): any {
  let node = root;
  for (const k of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[k];
  }
  return node;
}

/** Applies one op in place where possible; returns the (possibly replaced) root. Root is always an object. */
export function applyOp(root: any, op: Op): any {
  if (!isPlainObject(root)) root = {};
  const path = op.path || [];
  if (path.length === 0) {
    if (op.op === "delete") return root; // server ignores deleting the root
    return isPlainObject(op.value) ? clone(op.value) : root;
  }
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (FORBIDDEN.has(k)) return root;
    if (!isPlainObject(node[k])) {
      if (op.op === "delete") return root;
      node[k] = {};
    }
    node = node[k];
  }
  const last = path[path.length - 1];
  if (FORBIDDEN.has(last)) return root;
  if (op.op === "delete" || (op as any).value === undefined) delete node[last];
  else node[last] = clone(op.value);
  return root;
}

export function applyOps(root: any, ops: Op[]): any {
  for (const op of ops || []) root = applyOp(root, op);
  return root;
}
