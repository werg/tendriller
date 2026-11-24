import type { RuntimeErrorEntry, RuntimeErrors } from "../../contract/index.mjs";

const MAX_ERRORS = 30;
const MAX_MESSAGE = 500;
const MAX_STACK = 1500;
const MAX_SOURCE = 300;
const MAX_CONTEXT = 200;

function redact(text: string, limit: number): string {
  const cleaned = text
    .replace(/([?&](?:token|code|secret|key|auth|session|sig|password)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
  return cleaned.length > limit ? cleaned.slice(0, limit - 1) + "…" : cleaned;
}

function normalizeError(value: unknown, kind: RuntimeErrorEntry["kind"], context?: string): RuntimeErrorEntry {
  let message = "Unknown error";
  let source: string | undefined;
  let line: number | undefined;
  let column: number | undefined;
  let stack: string | undefined;

  if (typeof ErrorEvent !== "undefined" && value instanceof ErrorEvent) {
    message = value.message || (value.error instanceof Error ? value.error.message : String(value.error ?? "Script error"));
    if (value.filename) source = redact(value.filename, MAX_SOURCE);
    if (typeof value.lineno === "number" && value.lineno > 0) line = value.lineno;
    if (typeof value.colno === "number" && value.colno > 0) column = value.colno;
    if (value.error instanceof Error && value.error.stack) stack = redact(value.error.stack, MAX_STACK);
  } else if (value instanceof Error) {
    message = value.message || value.name || "Error";
    if (value.stack) stack = redact(value.stack, MAX_STACK);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) message = record.message;
    else {
      try { message = JSON.stringify(value); } catch { message = String(value); }
    }
    if (typeof record.stack === "string" && record.stack) stack = redact(record.stack, MAX_STACK);
    if (typeof record.filename === "string" && record.filename) source = redact(record.filename, MAX_SOURCE);
    if (typeof record.source === "string" && record.source && !source) source = redact(record.source, MAX_SOURCE);
    if (typeof record.lineno === "number" && record.lineno > 0) line = record.lineno;
    if (typeof record.colno === "number" && record.colno > 0) column = record.colno;
  } else if (value !== undefined && value !== null) {
    message = String(value);
  }

  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const entry: RuntimeErrorEntry = {
    id,
    at: Date.now(),
    kind,
    message: redact(message, MAX_MESSAGE),
    ...(source ? { source } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(stack ? { stack } : {}),
    ...(context ? { context: redact(String(context), MAX_CONTEXT) } : {}),
  };
  return Object.freeze(entry);
}

function readStored(key: string): RuntimeErrorEntry[] {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RuntimeErrorEntry =>
        item && typeof item === "object" && typeof item.id === "string" && typeof item.at === "number" && typeof item.message === "string")
      .slice(-MAX_ERRORS)
      .map(item => Object.freeze({ ...item }));
  } catch {
    return [];
  }
}

function writeStored(key: string, entries: RuntimeErrorEntry[]): void {
  try {
    if (entries.length === 0) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(entries));
  } catch {
    /* sessionStorage may be unavailable or full in restricted contexts. */
  }
}

export function createErrorTracker(pageId: string, onRecord?: (entry: RuntimeErrorEntry) => void): {
  api: RuntimeErrors;
  dispose(): void;
} {
  const storageKey = `tendril:errors:${pageId}`;
  let entries: RuntimeErrorEntry[] = readStored(storageKey);
  const listeners = new Set<(entry: RuntimeErrorEntry) => void>();

  const push = (entry: RuntimeErrorEntry): RuntimeErrorEntry => {
    entries.push(entry);
    if (entries.length > MAX_ERRORS) entries = entries.slice(-MAX_ERRORS);
    writeStored(storageKey, entries);
    onRecord?.(entry);
    for (const listener of [...listeners]) {
      try { listener(entry); } catch { /* Listener failures must not recurse into error tracking. */ }
    }
    return entry;
  };

  const onWindowError = (event: ErrorEvent) => {
    push(normalizeError(event, "error"));
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    push(normalizeError(event.reason, "unhandledrejection"));
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
  }

  const api: RuntimeErrors = Object.freeze({
    list: () => entries.map(entry => ({ ...entry })),
    on(listener: (entry: RuntimeErrorEntry) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    report(error: unknown, context?: string) {
      return push(normalizeError(error, "report", context));
    },
    clear() {
      entries = [];
      writeStored(storageKey, entries);
    },
  });

  return {
    api,
    dispose() {
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("error", onWindowError);
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
      }
      listeners.clear();
    },
  };
}
