import type { ConsumerAck, ConsumerBatch, ConsumerClaim, ConsumerLease, ConsumerRenew, EventConsumer } from "./index.mjs";
export interface DurabilityClient {
  consumers(): Promise<{ consumers: EventConsumer[] }>;
  claimConsumer(name: string, body: ConsumerClaim): Promise<ConsumerLease>;
  readConsumer(name: string, leaseToken: string, options?: { limit?: number; signal?: AbortSignal }): Promise<ConsumerBatch>;
  renewConsumer(name: string, leaseToken: string, body?: ConsumerRenew): Promise<{ consumer: EventConsumer }>;
  ackConsumer(name: string, leaseToken: string, body: ConsumerAck): Promise<{ consumer: EventConsumer }>;
  releaseConsumer(name: string, leaseToken: string): Promise<{ consumer: EventConsumer }>;
}
export function createDurabilityClient(request: (path: string, options?: Record<string, unknown>, responseSchema?: string) => Promise<unknown>): DurabilityClient;
