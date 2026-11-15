// Additive unattended-operation contracts, shared by HTTP, MCP and clients.
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableInteger = { anyOf: [integer, { type: "null" }] };
const object = (properties, required = [], additionalProperties = false) => ({ type: "object", properties, required, additionalProperties });
export const consumerName = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" };
export const consumerLeaseToken = { type: "string", pattern: "^cl_[a-z2-7]{40}$" };
const ttl = { type: "integer", minimum: 30, maximum: 900 };
const consumer = object({
  name: consumerName, handled_seq: integer, delivered_seq: integer, generation: integer,
  lease: { anyOf: [object({ holder: { type: "string", minLength: 1, maxLength: 100 }, expires_at: integer }, ["holder", "expires_at"]), { type: "null" }] },
  created_at: integer, updated_at: integer,
}, ["name", "handled_seq", "delivered_seq", "generation", "lease", "created_at", "updated_at"]);
const history = object({ earliest_available_seq: nullableInteger, latest_seq: integer, gap: { type: "boolean" }, missing_through: nullableInteger }, ["earliest_available_seq", "latest_seq", "gap", "missing_through"]);
export const durabilitySchemas = {
  consumerName,
  consumerLeaseToken,
  consumer,
  consumerList: object({ consumers: { type: "array", items: consumer } }, ["consumers"]),
  consumerResult: object({ consumer }, ["consumer"]),
  consumerClaim: object({ holder: { type: "string", minLength: 1, maxLength: 100 }, ttl_seconds: ttl, after: integer }, ["holder"]),
  consumerLease: object({ consumer, lease_token: consumerLeaseToken }, ["consumer", "lease_token"]),
  consumerRenew: object({ ttl_seconds: ttl }),
  consumerAck: object({ through: integer, gap_acknowledged: { type: "boolean" } }, ["through"]),
  consumerBatch: object({ consumer, events: { type: "array", maxItems: 500, items: { $ref: "#/$defs/event" } }, cursor: integer, history }, ["consumer", "events", "cursor", "history"]),
  timerDelivery: object({ state: { enum: ["pending", "sending", "sent", "failed", "cancelled", "unavailable"] }, attempts: { type: "integer", minimum: 0, maximum: 6 },
    next_attempt_at: nullableInteger, last_attempt_at: nullableInteger, last_error: { type: ["string", "null"] }, sent: integer, failed: integer,
  }, ["state", "attempts", "next_attempt_at", "last_attempt_at", "last_error", "sent", "failed"]),
};
