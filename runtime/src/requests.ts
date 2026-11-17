import { deliveryPolicy, type DeliveryPolicy } from "./delivery";
import type { ConnectionClock } from "./connection";

export interface RequestMessage { t: string; cid?: string; [key: string]: any }
type Clock = Pick<ConnectionClock, "setTimeout" | "clearTimeout">;
interface RequestHost {
  connected(): boolean;
  send(message: RequestMessage): boolean;
  enqueue(message: RequestMessage): unknown;
  newCid(): string;
}
interface PendingRequest {
  message: RequestMessage & { cid: string };
  policy: DeliveryPolicy;
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup?(): void;
}
const REQUEST_TIMEOUT_MS = 15_000;
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Correlated socket requests and their nonpersistent queue, independent of domain ACKs. */
export function createRequests(host: RequestHost, clock: Clock = globalThis) {
  const pending = new Map<string, PendingRequest>();
  const memory: RequestMessage[] = [];

  const remove = (request: PendingRequest) => {
    if (pending.get(request.message.cid) === request) pending.delete(request.message.cid);
    clock.clearTimeout(request.timer);
    request.cleanup?.();
  };

  return {
    raw(message: object) {
      const msg = message as RequestMessage;
      if (!msg || typeof msg.t !== "string") return;
      const policy = deliveryPolicy(msg.t);
      if (policy.raw === "outbox") {
        if (!msg.cid) msg.cid = host.newCid();
        host.enqueue(msg);
      } else if (!(host.connected() && host.send(msg)) && policy.raw === "memory") memory.push(msg);
    },
    request(message: RequestMessage, options: { signal?: AbortSignal } = {}): Promise<any> {
      if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? failure("cancelled", "Request cancelled"));
      const msg = { ...message, cid: message.cid || host.newCid() };
      const policy = deliveryPolicy(msg.t);
      if (policy.request === "connected" && !host.connected())
        return Promise.reject(failure("offline", policy.offlineMessage || "Request needs a connected page"));
      return new Promise((resolve, reject) => {
        const request: PendingRequest = { message: msg, policy, resolve, reject, timer: clock.setTimeout(() => {
          remove(request);
          const index = memory.indexOf(msg);
          if (index >= 0) memory.splice(index, 1);
          reject(failure(host.connected() ? "timeout" : "offline", host.connected() ? "request timed out" : "offline"));
        }, REQUEST_TIMEOUT_MS) };
        pending.set(msg.cid, request);
        const cancel = () => {
          remove(request);
          const index = memory.indexOf(msg);
          if (index >= 0) memory.splice(index, 1);
          reject(options.signal?.reason ?? failure("cancelled", "Request cancelled"));
        };
        request.cleanup = () => options.signal?.removeEventListener("abort", cancel);
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (policy.request === "outbox") host.enqueue(msg);
        else if (!(host.connected() && host.send(msg))) {
          if (policy.request === "connected") {
            remove(request);
            reject(failure("offline", policy.disconnectMessage || "Connection closed"));
          } else memory.push(msg);
        }
      });
    },
    /** A correlated ACK still continues through the caller's domain acknowledgement handler. */
    receive(message: RequestMessage): boolean {
      const request = message.cid ? pending.get(message.cid) : undefined;
      if (!request) return false;
      remove(request);
      if (message.t === "error" || (message.t === "ack" && message.error)) {
        const error: any = new Error(message.message || (message.error && (message.error.message || message.error)) || message.code || "error");
        error.code = message.code || (message.error && message.error.code) || message.error;
        request.reject(error);
      } else request.resolve(message);
      return true;
    },
    flush() {
      while (memory.length && host.connected()) host.send(memory.shift()!);
    },
    disconnected() {
      for (const request of pending.values()) {
        if (request.policy.disconnect !== "reject") continue;
        remove(request);
        request.reject(failure("offline", request.policy.disconnectMessage || "Connection closed"));
      }
    },
  };
}

/** Waiting for a command receipt never owns or removes its durable outbox entry. */
export function createCommandReceipts(connected: () => boolean, clock: Clock = globalThis) {
  // An exact operation can have several callers, each with its own deadline.
  const waiters = new Map<string, Set<(ack: any | null) => void>>();
  return {
    wait(cid: string): Promise<any | null> {
      return new Promise(resolve => {
        let done = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (ack: any | null) => {
          if (done) return;
          done = true;
          clock.clearTimeout(timer);
          group.delete(finish);
          if (!group.size) waiters.delete(cid);
          resolve(ack);
        };
        const group = waiters.get(cid) ?? new Set<(ack: any | null) => void>();
        group.add(finish); waiters.set(cid, group);
        // A lost ACK must not leave the UI waiting indefinitely. Null means the
        // command remains queued, not that it failed or was processed by a consumer.
        timer = clock.setTimeout(() => finish(null), connected() ? 8000 : 3000);
      });
    },
    acknowledge(cid: string, ack: any) { for (const finish of [...waiters.get(cid) ?? []]) finish(ack); },
    disconnected() { for (const group of [...waiters.values()]) for (const finish of [...group]) finish(null); },
  };
}
