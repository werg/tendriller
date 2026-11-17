// packages/peer-generation/src/participant.ts
var PARTICIPANT_PROTOCOL = "chronolog-participant-v1";
var PARTICIPANT_LIMITS = Object.freeze({
  pending: 4,
  depth: 32,
  bytes: Object.freeze({
    control: 16 * 1024 * 1024,
    publication: 12 * 1024 * 1024,
    discovery: 256 * 1024,
    ephemeral: 64 * 1024,
    database: 32 * 1024 * 1024,
    content: 512 * 1024
  })
});
function policy(role, actions) {
  return Object.freeze({ role, interests: Object.freeze(Object.entries(actions).flatMap(([facet, names]) => names.map((action) => Object.freeze({ facet, action })))) });
}
var CONTROL_PARTICIPANT_POLICY = policy("control", {
  control: ["read", "configure", "select", "administer"],
  publication: ["definition", "read", "publish"],
  discovery: ["read", "advertise", "withdraw"],
  ephemeral: ["invite"]
});
var PEER_PARTICIPANT_POLICY = policy("peer", {
  control: ["state", "keyShare"],
  publication: ["definition", "read"],
  database: ["submit", "range", "coverage"],
  content: ["manifest", "chunk", "retained", "observeRetention"],
  ephemeral: ["signal", "hint"]
});
var ParticipantProtocolError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ParticipantProtocolError";
  }
  code;
};
function requireParticipant(condition, code) {
  if (!condition) throw new ParticipantProtocolError(code);
}
function applicationId(value) {
  requireParticipant(typeof value === "string" && /^[0-9a-f]{64}$/u.test(value), "PEER_PARTICIPANT_SCOPE_INVALID");
}
function dataProperties(value, code) {
  const properties = Object.entries(Object.getOwnPropertyDescriptors(value));
  requireParticipant(properties.every(([, descriptor]) => Object.hasOwn(descriptor, "value")), code);
  return properties;
}
function jsonValue(value, depth = 0) {
  requireParticipant(depth <= PARTICIPANT_LIMITS.depth, "PEER_PARTICIPANT_DEPTH_LIMIT");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    requireParticipant(Number.isFinite(value), "PEER_PARTICIPANT_PAYLOAD_INVALID");
    return;
  }
  const array = Array.isArray(value);
  requireParticipant(
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype),
    "PEER_PARTICIPANT_PAYLOAD_INVALID"
  );
  const properties = dataProperties(value, "PEER_PARTICIPANT_PAYLOAD_INVALID");
  if (array) requireParticipant(
    properties.filter(([key]) => /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length).length === value.length,
    "PEER_PARTICIPANT_PAYLOAD_INVALID"
  );
  for (const [key, descriptor] of properties) {
    if (!array || key !== "length") jsonValue(descriptor.value, depth + 1);
  }
}
function participantAccepts(policy2, interest) {
  return policy2.interests.some((value) => value.facet === interest.facet && value.action === interest.action);
}
function validateParticipantRequest(value, selected = CONTROL_PARTICIPANT_POLICY) {
  requireParticipant(
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype,
    "PEER_PARTICIPANT_ENVELOPE_INVALID"
  );
  const request = value;
  const fields = ["protocol", "applicationId", "requestId", "facet", "action", "payload"];
  const properties = dataProperties(request, "PEER_PARTICIPANT_ENVELOPE_INVALID");
  requireParticipant(
    properties.length === fields.length && Object.keys(request).length === fields.length && Object.getOwnPropertySymbols(request).length === 0 && fields.every((key) => Object.hasOwn(request, key)),
    "PEER_PARTICIPANT_ENVELOPE_INVALID"
  );
  requireParticipant(request.protocol === PARTICIPANT_PROTOCOL, "PEER_PARTICIPANT_PROTOCOL_UNSUPPORTED");
  applicationId(request.applicationId);
  requireParticipant(
    typeof request.requestId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(request.requestId),
    "PEER_PARTICIPANT_REQUEST_INVALID"
  );
  requireParticipant(typeof request.facet === "string" && Object.hasOwn(PARTICIPANT_LIMITS.bytes, request.facet) && typeof request.action === "string" && /^[a-z][A-Za-z-]{0,47}$/u.test(request.action), "PEER_PARTICIPANT_INTEREST_INVALID");
  requireParticipant(participantAccepts(selected, request), "PEER_PARTICIPANT_FACET_FORBIDDEN");
  jsonValue(request.payload);
  requireParticipant(
    new TextEncoder().encode(JSON.stringify(request)).length <= PARTICIPANT_LIMITS.bytes[request.facet],
    "PEER_PARTICIPANT_SIZE_LIMIT"
  );
  return structuredClone(request);
}
function createParticipantRequest(input, selected = CONTROL_PARTICIPANT_POLICY) {
  return validateParticipantRequest({
    protocol: PARTICIPANT_PROTOCOL,
    applicationId: input.applicationId,
    requestId: input.requestId ?? crypto.randomUUID(),
    facet: input.facet,
    action: input.action,
    payload: input.payload
  }, selected);
}
function createParticipantResponse(request, payload, selected = CONTROL_PARTICIPANT_POLICY) {
  return validateParticipantRequest({ ...validateParticipantRequest(request, selected), payload }, selected);
}
function validateParticipantResponse(value, request, selected = CONTROL_PARTICIPANT_POLICY) {
  const response = validateParticipantRequest(value, selected);
  requireParticipant(response.applicationId === request.applicationId && response.requestId === request.requestId && response.facet === request.facet && response.action === request.action, "PEER_PARTICIPANT_RESPONSE_MISMATCH");
  return response;
}
function createParticipantTransport(options) {
  applicationId(options.applicationId);
  const scope = options.applicationId, dispatch = options.exchange;
  const selected = structuredClone(options.policy ?? CONTROL_PARTICIPANT_POLICY);
  let pending = 0;
  const exchange = async (input, inputOptions = {}) => {
    const request = validateParticipantRequest(input, selected);
    const signal = inputOptions.signal;
    requireParticipant(request.applicationId === scope, "PEER_PARTICIPANT_SCOPE_MISMATCH");
    signal?.throwIfAborted();
    requireParticipant(pending < PARTICIPANT_LIMITS.pending, "PEER_PARTICIPANT_BUSY");
    pending++;
    const completion = (async () => {
      try {
        return await dispatch(request, signal === void 0 ? {} : { signal });
      } finally {
        pending--;
      }
    })();
    const response = await (signal === void 0 ? completion : new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      function onAbort() {
        cleanup();
        reject(signal.reason);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void completion.then((value) => {
        cleanup();
        resolve(value);
      }, (error) => {
        cleanup();
        reject(error);
      });
      if (signal.aborted) onAbort();
    }));
    signal?.throwIfAborted();
    return validateParticipantResponse(response, request, selected);
  };
  return Object.freeze({
    applicationId: scope,
    policy: policy(
      selected.role,
      Object.fromEntries([...new Set(selected.interests.map((value) => value.facet))].map((facet) => [facet, selected.interests.filter((value) => value.facet === facet).map((value) => value.action)]))
    ),
    exchange,
    async request(facet, action, payload, inputOptions = {}) {
      return (await exchange(createParticipantRequest({ applicationId: scope, facet, action, payload }, selected), inputOptions)).payload;
    }
  });
}
export {
  CONTROL_PARTICIPANT_POLICY,
  PARTICIPANT_LIMITS,
  PARTICIPANT_PROTOCOL,
  PEER_PARTICIPANT_POLICY,
  ParticipantProtocolError,
  createParticipantRequest,
  createParticipantResponse,
  createParticipantTransport,
  participantAccepts,
  validateParticipantRequest,
  validateParticipantResponse
};
