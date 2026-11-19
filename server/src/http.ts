// HTTP helpers: JSON responses, consistent errors, CORS, bounded body reading.
import { ContractError } from "../../contract/index.mjs";
import type { ErrorResponse } from "../../contract/index.mjs";

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
  const body: ErrorResponse = { error: { code, message: message ?? code, ...(extra ?? {}) } };
  return json(body, status);
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof ContractError) return errorResponse(400, err.code, err.message, { details: err.issues });
  if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, err.extra);
  console.error("internal error", err);
  return errorResponse(500, "internal", "Internal server error");
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, X-Tendril-Name, X-Tendril-Lease, Mcp-Protocol-Version, Mcp-Session-Id, Tendriller-Agent-Binding",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Disposition, Link",
  "Access-Control-Max-Age": "86400",
};

export function withCors(res: Response): Response {
  // Responses from fetch/DO stubs can have immutable headers; WebSocket upgrades must pass through.
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

/** Bounds total read time as well as bytes, including a client that stops mid-body. */
export async function readBody(req: Request, max: number, timeoutMs = 120_000): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(max) || max < 0) throw new TypeError("Invalid body byte limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError("Invalid body read deadline");
  const len = Number(req.headers.get("Content-Length") ?? "NaN");
  if (Number.isFinite(len) && len > max) throw new HttpError(413, "too_large", `Body exceeds ${max} bytes`);
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let fragments = 0;
  let timer: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    const stop = (error: unknown) => {
      // Reject before cancellation can resolve an unfinished read with done=true.
      reject(error);
      void reader.cancel(error).catch(() => {});
    };
    timer = setTimeout(() => stop(new HttpError(408, "request_timeout", "Request body exceeded its read deadline")), timeoutMs);
    abort = () => stop(req.signal.reason ?? new HttpError(408, "request_aborted", "Request body was cancelled"));
    req.signal.addEventListener("abort", abort, { once: true });
    if (req.signal.aborted) abort();
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([deadline, reader.read()]);
      if (done) break;
      // Count empty chunks too: a synchronously producing stream can otherwise
      // exhaust memory or starve the timer without consuming its byte budget.
      if (++fragments > 65_536) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, "too_fragmented", "Request body exceeds its fragment limit");
      }
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, "too_large", `Body exceeds ${max} bytes`);
      }
      if (value.byteLength) chunks.push(value);
    }
  } finally {
    clearTimeout(timer!);
    req.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

export async function readJson<T = any>(req: Request, max = 1_000_000): Promise<T> {
  const buf = await readBody(req, max, 30_000);
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
