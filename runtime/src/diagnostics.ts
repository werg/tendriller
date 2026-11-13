// Console forwarding and health reporting (PROTOCOL 4, 7 `log` / `health`).
import { serialize } from "./serialize";

export interface LogEntry { level: "log" | "info" | "warn" | "error"; message: string; stack?: string; ts: number }

const MAX_MSG = 4000;
const MAX_BATCH = 200;
const BATCH_MS = 500;

function fmt(x: any): string {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack && x.stack.includes(x.message) ? x.stack : String(x);
  try {
    const s = JSON.stringify(serialize(x));
    return s === undefined ? String(x) : s;
  } catch { return String(x); }
}

function cap(s: string): string { return s.length > MAX_MSG ? s.slice(0, MAX_MSG - 1) + "…" : s; }

function reasonString(r: any): { message: string; stack?: string } {
  if (r instanceof Error) return { message: String(r), stack: r.stack };
  return { message: fmt(r) };
}

/** Hooks console + window errors; calls `flush(entries)` at most every 500 ms. */
export function installLogForwarding(flush: (entries: LogEntry[]) => void): void {
  let buf: LogEntry[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  const push = (e: LogEntry) => {
    if (buf.length >= MAX_BATCH) { dropped++; } else buf.push(e);
    if (!timer) timer = setTimeout(send, BATCH_MS);
  };
  const send = () => {
    timer = 0;
    if (dropped) buf.push({ level: "warn", message: `[tendril] ${dropped} log entries dropped (rate limit)`, ts: Date.now() });
    const entries = buf;
    buf = [];
    dropped = 0;
    if (entries.length) {
      try { flush(entries); } catch { /* never let forwarding break the page */ }
    }
  };
  const c = console as any;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = c[level];
    if (typeof orig !== "function") continue;
    c[level] = function (this: any, ...args: any[]) {
      try {
        const err = args.find((a) => a instanceof Error) as Error | undefined;
        const e: LogEntry = { level, message: cap(args.map(fmt).join(" ")), ts: Date.now() };
        if (err && err.stack) e.stack = cap(err.stack);
        push(e);
      } catch { /* ignore */ }
      return orig.apply(this, args);
    };
  }
  window.addEventListener("error", (ev: ErrorEvent) => {
    const loc = ev.filename ? ` (${ev.filename}:${ev.lineno}:${ev.colno})` : "";
    const e: LogEntry = { level: "error", message: cap(`Uncaught ${ev.message || "error"}${loc}`), ts: Date.now() };
    if (ev.error && ev.error.stack) e.stack = cap(String(ev.error.stack));
    push(e);
  });
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const r = reasonString(ev.reason);
    const e: LogEntry = { level: "error", message: cap(`Unhandled rejection: ${r.message}`), ts: Date.now() };
    if (r.stack) e.stack = cap(r.stack);
    push(e);
  });
  window.addEventListener("pagehide", send);
}

/**
 * Health per PROTOCOL 4: ok:false if an uncaught error or unhandled rejection happens before
 * 2000 ms after `load` (or before `ready()` when `ready.manual()` was called before `load`).
 */
export function createHealth(report: (ok: boolean, errors: string[]) => void, healthMs = 2000) {
  const errors: string[] = [];
  let reported = false;
  let manual = false;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  window.addEventListener("error", (ev: ErrorEvent) => {
    if (reported) return;
    const loc = ev.filename ? ` at ${ev.filename}:${ev.lineno}:${ev.colno}` : "";
    errors.push(cap(`${ev.message || "Uncaught error"}${loc}`));
  });
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    if (reported) return;
    errors.push(cap(`Unhandled rejection: ${reasonString(ev.reason).message}`));
  });
  const fire = () => {
    if (reported) return;
    reported = true;
    if (timer) clearTimeout(timer);
    report(errors.length === 0, errors.slice(0, 20));
  };
  const onLoad = () => { if (!manual && !reported) timer = setTimeout(fire, healthMs); };
  if (document.readyState === "complete") onLoad();
  else window.addEventListener("load", onLoad, { once: true });
  return {
    ready: () => fire(),
    manual: () => {
      if (reported) return;
      manual = true;
      if (timer) { clearTimeout(timer); timer = 0; }
    },
    get reported() { return reported; },
  };
}
