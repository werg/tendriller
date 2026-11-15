import { assertValid } from "./index.mjs";

export function streamReadQuery({ after, limit = 100 } = {}) {
  if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("Stream reads require an explicit nonnegative after cursor");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("limit must be an integer from 1 to 500");
  return new URLSearchParams({ after: String(after), limit: String(limit) }).toString();
}

/** Agent/producer clients share the wire contract; server grants determine which calls are allowed. */
export function createStreamsClient(request) {
  const path = name => `/streams/${encodeURIComponent(assertValid("streamName", name))}`;
  return {
    streams: {
      list: () => request("/streams", undefined, "streamList"),
      create: body => request("/streams", { method: "POST", body: assertValid("streamCreate", body) }, "streamInfo"),
      info: name => request(path(name), undefined, "streamInfo"),
      append: (name, body) => request(`${path(name)}/records`, { method: "POST", body: assertValid("streamAppend", body) }, "streamAppendResult"),
      read: (name, options) => request(`${path(name)}/records?${streamReadQuery(options)}`, { signal: options?.signal }, "streamBatch"),
      latest: (name, options = {}) => request(`${path(name)}/latest`, { signal: options.signal }, "streamLatest"),
    },
    producers: {
      list: () => request("/producers", undefined, "producerList"),
      create: body => request("/producers", { method: "POST", body: assertValid("producerCreate", body) }, "producerResult"),
      revoke: name => request(`/producers/${encodeURIComponent(assertValid("streamName", name))}`, { method: "DELETE" }),
    },
  };
}
