import { assertValid } from "../../contract/index.mjs";
import type { BrowserTimers, DurableTimer, OperationOptions, PendingTimerCommand, PublicError, ScopeDescriptor,
  TimerDeleted, TimerIntent, TimerMutationResult, TimerRevisionOptions, WireContracts } from "../../contract/index.mjs";
import { captureContext } from "./generations";
import { clone } from "./state";

interface Host {
  base: string;
  headers(): Record<string, string>;
  scopes(): ScopeDescriptor[];
  newCid(): string;
  queue(intent: TimerIntent): Promise<TimerMutationResult>;
  pending(): PendingTimerCommand[];
}

const REQUEST_TIMEOUT = 15_000;
export type TimerTerminalResult = Exclude<TimerMutationResult, { status: "queued" }>;

export class TimerHttpError extends Error {
  constructor(public code: string, message: string, public retryable: boolean,
    public status?: number, public details?: PublicError) { super(message); }
}

function contextOptions(value: OperationOptions | TimerRevisionOptions | undefined, revision: boolean) {
  if (value === undefined && !revision) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Timer context must be an object");
  const allowed = new Set(["scope", "expected_generations", ...(revision ? ["expected_revision"] : [])]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`Unknown timer context option: ${key}`);
  return value;
}

function settings(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Timer settings must be an object");
  for (const key of ["cid", "scope", "expected_generations", "expected_revision"])
    if (Object.hasOwn(value, key)) throw new TypeError(`Timer ${key} belongs to runtime command context, not settings`);
  return value;
}

function timerId(id: string): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]+$/.test(id) || id === "history") throw new TypeError("A timer ID is required");
  return id;
}

/** Timer transport uses the core outbox; this helper owns neither storage nor retries. */
export function createBrowserTimers(host: Host) {
  async function request<K extends "timerList" | "timerHistory" | "timer" | "timerDeleted">(
    path: string, schema: K, method = "GET", body?: unknown,
  ): Promise<WireContracts[K]> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const work = async () => {
      const response = await fetch(host.base + "_tendril/" + path, {
        method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { ...host.headers(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // A body-stream interruption is ambiguous even after success headers. Keep
      // the original command so a replay can recover its committed server receipt.
      const text = await response.text();
      let value: any;
      try { value = JSON.parse(text); }
      catch { throw new TimerHttpError("invalid_response", "The timer service returned a non-JSON response", true, response.status); }
      if (!response.ok) {
        let error: PublicError;
        try { error = assertValid("errorResponse", value).error; }
        catch { throw new TimerHttpError("invalid_response", "The timer service returned an invalid error receipt", true, response.status); }
        // A full timer collection or receipt allowance requires a deliberate
        // change, unlike temporary rate limiting. Do not retry these forever.
        const retryable = response.status >= 500 || [408, 425].includes(response.status)
          || (response.status === 429 && !["quota", "resource_quota"].includes(error.code));
        throw new TimerHttpError(error.code, error.message, retryable, response.status, error);
      }
      try { return assertValid(schema, value); }
      catch { throw new TimerHttpError("invalid_response", `The timer receipt does not match ${schema}`, true, response.status); }
    };
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new TimerHttpError("timeout", "The timer request timed out", true));
        }, REQUEST_TIMEOUT);
      })]);
    } finally { clearTimeout(timeout!); }
  }

  const queue = <T extends DurableTimer | TimerDeleted>(intent: TimerIntent) => host.queue(intent) as Promise<TimerMutationResult<T>>;
  const api: BrowserTimers = {
    list: () => request("timers", "timerList"),
    history: () => request("timers/history", "timerHistory"),
    pending: () => clone(host.pending()),
    create(value, options) {
      const input = settings(value), context = captureContext(host.scopes(), "timer.write", contextOptions(options, false));
      const command = clone(assertValid("timerCreate", { ...input, ...context, cid: host.newCid() }));
      return queue<DurableTimer>({ operation: "create", command });
    },
    update(id, value, options) {
      timerId(id);
      const input = settings(value), opts = contextOptions(options, true) as TimerRevisionOptions;
      const context = captureContext(host.scopes(), "timer.write", opts);
      const command = clone(assertValid("timerWrite", { ...input, ...context, cid: host.newCid(), expected_revision: opts.expected_revision }));
      return queue<DurableTimer>({ operation: "update", id, command });
    },
    remove(id, options) {
      timerId(id);
      const opts = contextOptions(options, true) as TimerRevisionOptions;
      const context = captureContext(host.scopes(), "timer.write", opts);
      const command = clone(assertValid("timerDelete", { ...context, cid: host.newCid(), expected_revision: opts.expected_revision }));
      return queue<TimerDeleted>({ operation: "remove", id, command });
    },
  };

  return {
    api,
    async deliver(intent: TimerIntent): Promise<TimerTerminalResult> {
      const { command } = intent;
      try {
        const value = intent.operation === "create" ? await request("timers", "timer", "POST", command)
          : intent.operation === "update" ? await request(`timers/${timerId(intent.id)}`, "timer", "PATCH", command)
          : await request(`timers/${timerId(intent.id)}`, "timerDeleted", "DELETE", command);
        if (intent.operation === "create" && (!/^[a-zA-Z0-9-]+$/.test(value.id) || value.id === "history" || value.revision !== 1))
          throw new TimerHttpError("invalid_response", "The timer creation receipt has an invalid identity or revision", true);
        if (intent.operation !== "create" && (value.id !== intent.id || value.revision !== intent.command.expected_revision + 1))
          throw new TimerHttpError("invalid_response", "The timer receipt does not match the original target and revision", true);
        return { cid: command.cid, status: "accepted", value };
      } catch (error) {
        if (!(error instanceof TimerHttpError) || error.retryable) throw error;
        return { cid: command.cid, status: "rejected", error: error.code, message: error.message, details: error.details };
      }
    },
  };
}
