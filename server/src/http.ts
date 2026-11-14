// HTTP helpers: JSON responses, consistent errors, CORS, bounded body reading.

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function errorResponse(status: number, code: string, message?: string, extra?: Record<string, unknown>): Response {
  return json({ error: { code, message: message ?? code, ...(extra ?? {}) } }, status);
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, err.extra);
  console.error("internal error", err);
  return errorResponse(500, "internal", "Internal server error");
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Tendril-Name, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export function withCors(res: Response): Response {
  // Responses from fetch/DO stubs can have immutable headers; WebSocket upgrades must pass through.
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

/** Reads the body up to `max` bytes; throws 413 beyond that. */
export async function readBody(req: Request, max: number): Promise<ArrayBuffer> {
  const len = Number(req.headers.get("Content-Length") ?? "NaN");
  if (Number.isFinite(len) && len > max) throw new HttpError(413, "too_large", `Body exceeds ${max} bytes`);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) throw new HttpError(413, "too_large", `Body exceeds ${max} bytes`);
  return buf;
}

export async function readJson<T = any>(req: Request, max = 1_000_000): Promise<T> {
  const buf = await readBody(req, max);
  if (buf.byteLength === 0) return {} as T;
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } catch {
    throw new HttpError(400, "bad_json", "Request body is not valid JSON");
  }
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function intParam(url: URL, name: string, def: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new HttpError(400, "bad_request", `Query parameter ${name} must be a number`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}
