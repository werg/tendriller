/** Delivery describes a browser operation, not the retention of its payload. */
export interface DeliveryPolicy {
  readonly raw: "outbox" | "memory" | "drop";
  readonly request: "outbox" | "memory" | "connected";
  readonly outboxCompletion: "written" | "ack";
  readonly disconnect: "wait" | "reject";
  readonly offlineMessage?: string;
  readonly disconnectMessage?: string;
}

const MEMORY: DeliveryPolicy = Object.freeze({ raw: "memory", request: "memory", outboxCompletion: "written", disconnect: "wait" });
const ACKED: DeliveryPolicy = Object.freeze({ raw: "outbox", request: "outbox", outboxCompletion: "ack", disconnect: "wait" });
const WRITTEN: DeliveryPolicy = Object.freeze({ raw: "outbox", request: "outbox", outboxCompletion: "written", disconnect: "wait" });
// Diagnostic replies can be discarded when disconnected. Correlated control
// RPCs wait in memory until delivery or their bounded request deadline.
const TRANSIENT: DeliveryPolicy = Object.freeze({ ...MEMORY, raw: "drop" });
const STREAM_REQUEST: DeliveryPolicy = Object.freeze({
  ...MEMORY, request: "connected", disconnect: "reject",
  offlineMessage: "Stream requests need a connected page",
  disconnectMessage: "Stream connection closed",
});

/** Explicit operation names prevent new APIs accidentally inheriting a prefix policy. */
export const DELIVERY_POLICIES = Object.freeze({
  send: ACKED,
  capture_complete: ACKED,
  state: ACKED,
  timer_command: ACKED,
  log: WRITTEN,
  upload: WRITTEN,
  eval_result: TRANSIENT,
  ping: TRANSIENT,
  stream_subscribe: STREAM_REQUEST,
  stream_unsubscribe: STREAM_REQUEST,
  stream_publish: STREAM_REQUEST,
} satisfies Record<string, DeliveryPolicy>);

export function deliveryPolicy(kind: string): DeliveryPolicy {
  // Control RPCs have transient process-local lifetimes. Own-property lookup
  // keeps names such as "constructor" from becoming policy objects.
  return Object.hasOwn(DELIVERY_POLICIES, kind)
    ? DELIVERY_POLICIES[kind as keyof typeof DELIVERY_POLICIES] : MEMORY;
}
