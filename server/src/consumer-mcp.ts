import type { Tool } from "./mcp";
import { schemas } from "../../contract/index.mjs";

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const identity = { name: schemas.consumerName, lease_token: schemas.consumerLeaseToken };
const proof = (args: Record<string, any>) => ({ "X-Tendril-Lease": args.lease_token });
const route = (name: string, action: string) => `consumers/${encodeURIComponent(name)}/${action}`;
export const CONSUMER_TOOLS: Tool[] = [
  { name: "list_event_consumers", description: "Durable handled checkpoints and current lease holders, without private lease tokens. Reuse one consumer name for failover; different names are independent subscriptions.",
    inputSchema: object({}, []), call: () => ({ method: "GET", rest: "consumers" }) },
  { name: "claim_event_consumer", description: "Claim an exclusive 30–900 second processing lease. Keep the returned lease_token private; renew while working, acknowledge only completed work, and release when finished. after initializes a new consumer only.",
    inputSchema: object({ name: schemas.consumerName, ...schemas.consumerClaim.properties }, ["name", "holder"]),
    call: ({ name, ...body }) => ({ method: "POST", rest: route(name, "claim"), body }) },
  { name: "read_consumer_events", description: "Replay events after this consumer's durable handled checkpoint. Reading does not acknowledge them. A history gap is explicit; recover context before acknowledging missing history.",
    inputSchema: object({ ...identity, limit: { type: "integer", minimum: 1, maximum: 500 } }, ["name", "lease_token"]),
    call: args => ({ method: "GET", rest: route(args.name, "events"), headers: proof(args), query: { limit: String(args.limit ?? 100) } }) },
  { name: "renew_event_consumer", description: "Extend an active processing lease. Expired or reassigned leases cannot be renewed; stop acting if renewal fails.",
    inputSchema: object({ ...identity, ...schemas.consumerRenew.properties }, ["name", "lease_token"]),
    call: args => ({ method: "POST", rest: route(args.name, "renew"), headers: proof(args), body: { ttl_seconds: args.ttl_seconds } }) },
  { name: "acknowledge_consumer_events", description: "Advance the handled checkpoint only after the reply/state/external work succeeds. Cannot acknowledge unseen ranges. Missing retained history requires explicit gap_acknowledged:true; this does not make external side effects exactly once.",
    inputSchema: object({ ...identity, ...schemas.consumerAck.properties }, ["name", "lease_token", "through"]),
    call: args => ({ method: "POST", rest: route(args.name, "ack"), headers: proof(args), body: { through: args.through, gap_acknowledged: args.gap_acknowledged } }) },
  { name: "release_event_consumer", description: "Release processing ownership without moving the handled checkpoint. The next holder will replay unacknowledged events.",
    inputSchema: object(identity, ["name", "lease_token"]), call: args => ({ method: "POST", rest: route(args.name, "release"), headers: proof(args) }) },
];
