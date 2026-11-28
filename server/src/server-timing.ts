/**
 * Minimal `Server-Timing` instrumentation.
 *
 * Workers clocks only advance across I/O, so durations measure awaited D1, DO,
 * R2 and binding round trips rather than CPU. That is the latency this header is
 * meant to explain. Each entry is a short static name; no request data, keys or
 * identifiers are ever written into a metric.
 */
export class ServerTiming {
  private readonly entries: string[] = [];

  /** Time one awaited phase. Failures are still recorded before rethrowing. */
  async time<T>(name: string, work: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try { return await work(); }
    finally { this.add(name, Date.now() - start); }
  }

  add(name: string, durationMs: number, description?: string): void {
    if (this.entries.length >= 16) return;
    this.entries.push(`${name};dur=${Math.max(0, durationMs)}${description ? `;desc="${description}"` : ''}`);
  }

  get empty(): boolean { return this.entries.length === 0; }

  /** Appends to the response's metrics, keeping any entries a Durable Object already set. */
  applyTo(headers: Headers): void {
    if (this.entries.length) headers.append('Server-Timing', this.entries.join(', '));
  }
}

/** Adds metrics to a response, copying it only when its headers are immutable. */
export function withServerTiming(res: Response, timing: ServerTiming): Response {
  if (timing.empty) return res;
  try {
    timing.applyTo(res.headers);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    timing.applyTo(headers);
    if (res.status === 101) return new Response(null, { status: 101, headers, webSocket: res.webSocket });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

const byRequest = new WeakMap<Request, ServerTiming>();

/** The metrics of one Durable Object request, shared by its nested handlers. */
export function requestTiming(req: Request): ServerTiming {
  let timing = byRequest.get(req);
  if (!timing) byRequest.set(req, timing = new ServerTiming());
  return timing;
}
