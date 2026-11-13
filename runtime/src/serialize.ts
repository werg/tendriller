// Converts eval results to JSON-safe values (PROTOCOL 2.2): undefined → null, Element → outerHTML
// (truncated to 2000), Error → string, circular / non-serialisable → String(x).

const MAX_HTML = 2000;

function isError(x: any): boolean {
  return x instanceof Error || Object.prototype.toString.call(x) === "[object Error]";
}

export function errorString(e: any): string {
  if (isError(e)) return String(e);
  if (typeof e === "string") return e;
  try { return JSON.stringify(serialize(e)); } catch { return String(e); }
}

export function serialize(value: any): any {
  const stack = new Set<object>();
  const walk = (x: any, depth: number): any => {
    if (x === undefined || x === null) return null;
    const t = typeof x;
    if (t === "string" || t === "boolean") return x;
    if (t === "number") return Number.isFinite(x) ? x : String(x);
    if (t !== "object") return String(x); // bigint, symbol, function
    if (typeof Element !== "undefined" && x instanceof Element) return x.outerHTML.slice(0, MAX_HTML);
    if (typeof Document !== "undefined" && x instanceof Document) return x.documentElement ? x.documentElement.outerHTML.slice(0, MAX_HTML) : null;
    if (typeof Node !== "undefined" && x instanceof Node) return x.textContent;
    if (isError(x)) return String(x);
    if (stack.has(x) || depth > 50) return String(x);
    if (typeof Window !== "undefined" && x instanceof Window) return String(x);
    stack.add(x);
    try {
      if (typeof x.toJSON === "function") return walk(x.toJSON(), depth + 1);
      if (Array.isArray(x)) return x.map((v) => walk(v, depth + 1));
      if (ArrayBuffer.isView(x)) return x instanceof DataView ? String(x) : Array.from(x as any);
      if (x instanceof Map) {
        const o: Record<string, any> = {};
        for (const [k, v] of x) o[String(k)] = walk(v, depth + 1);
        return o;
      }
      if (x instanceof Set) return Array.from(x, (v) => walk(v, depth + 1));
      if ((typeof NodeList !== "undefined" && x instanceof NodeList) || (typeof HTMLCollection !== "undefined" && x instanceof HTMLCollection)) {
        return Array.from(x as ArrayLike<any>, (v) => walk(v, depth + 1));
      }
      const proto = Object.getPrototypeOf(x);
      const keys = Object.keys(x);
      if (proto !== Object.prototype && proto !== null && keys.length === 0) return String(x);
      const o: Record<string, any> = {};
      for (const k of keys) {
        let v: any;
        try { v = x[k]; } catch (e) { v = String(e); }
        o[k] = walk(v, depth + 1);
      }
      return o;
    } finally {
      stack.delete(x);
    }
  };
  try {
    const out = walk(value, 0);
    JSON.stringify(out);
    return out;
  } catch {
    try { return String(value); } catch { return null; }
  }
}
