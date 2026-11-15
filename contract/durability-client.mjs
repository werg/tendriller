import { assertValid } from "./index.mjs";

export function createDurabilityClient(request) {
  const path = name => `/consumers/${encodeURIComponent(assertValid("consumerName", name))}`;
  const headers = token => ({ "X-Tendril-Lease": assertValid("consumerLeaseToken", token) });
  return {
    consumers: () => request("/consumers", undefined, "consumerList"),
    claimConsumer: (name, body) => request(path(name) + "/claim", { method: "POST", body: assertValid("consumerClaim", body) }, "consumerLease"),
    readConsumer: (name, token, { limit = 100, signal } = {}) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("limit must be 1..500");
      return request(path(name) + `/events?limit=${limit}`, { headers: headers(token), signal }, "consumerBatch");
    },
    renewConsumer: (name, token, body = {}) => request(path(name) + "/renew", { method: "POST", headers: headers(token), body: assertValid("consumerRenew", body) }, "consumerResult"),
    ackConsumer: (name, token, body) => request(path(name) + "/ack", { method: "POST", headers: headers(token), body: assertValid("consumerAck", body) }, "consumerResult"),
    releaseConsumer: (name, token) => request(path(name) + "/release", { method: "POST", headers: headers(token) }, "consumerResult"),
  };
}
