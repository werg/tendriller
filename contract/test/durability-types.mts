import { createClient } from "../client.mjs";
import type { ConsumerBatch, ConsumerAck, EventConsumer, TimerDelivery, TimerRun } from "../index.mjs";

const client = createClient({ api: "https://example.test/api/t/id", token: "tk_private" });
const claim = await client.claimConsumer("main", { holder: "worker", ttl_seconds: 90 });
const consumer: EventConsumer = claim.consumer;
const batch: ConsumerBatch = await client.readConsumer("main", claim.lease_token, { limit: 100 });
const ack: ConsumerAck = { through: batch.cursor };
await client.ackConsumer("main", claim.lease_token, ack);
await client.renewConsumer("main", claim.lease_token);
await client.releaseConsumer("main", claim.lease_token);
// @ts-expect-error a processing read requires the active lease token.
await client.readConsumer("main");
// @ts-expect-error handled acknowledgement requires a sequence.
await client.ackConsumer("main", claim.lease_token, {});
// @ts-expect-error a public listing never reveals the lease secret.
consumer.lease_token;
const delivery: TimerDelivery = { state: "pending", attempts: 1, next_attempt_at: 100, last_attempt_at: 90, last_error: null, sent: 1, failed: 1 };
declare const run: TimerRun;
const retryAt: number | null | undefined = run.delivery?.next_attempt_at;
void [consumer, delivery, retryAt];
