/** The public wire contract. This module has no runtime dependencies and works in
 * browsers, Workers and Node. Matching declarations are in index.d.mts. */
import { durabilitySchemas } from "./durability.mjs";
export const CONTRACT_VERSION = 1;
export const ROLES = Object.freeze(["owner", "guest", "display"]);
export const DEVICE_PURPOSES = Object.freeze(["general", "camera", "controller", "display", "speaker"]);
const string = { type: "string" };
const integer = { type: "integer", minimum: 0 };
const object = (properties, required = [], additionalProperties = false) => ({ type: "object", properties, required, additionalProperties });
const path = { anyOf: [string, { type: "array", items: { anyOf: [string, { type: "integer" }] } }] };
const jsonObject = { type: "object" };
const boolean = { type: "boolean" };
const nullableString = { type: ["string", "null"] };
const nullableTime = { anyOf: [integer, { type: "null" }] };
const shortText = { type: "string", minLength: 1, maxLength: 200 };
const sayProperties = { text: string, speak: boolean, in_reply_to: { type: "integer", minimum: 1 }, device: string, speak_on: string };
const error = object({ code: string, message: string, details: { type: "array", items: object({ path: string, message: string }, ["path", "message"]) } }, ["code", "message"], true);
const blobReference = object({ id: { type: "string", pattern: "^b_[a-z2-7]{20}$" }, url: string,
  retention: object({ keep: { type: "boolean" }, expires_at: { anyOf: [integer, { type: "null" }] }, reason: { enum: ["pinned", "page_default", "agent_asset", "icon"] } }, ["keep", "expires_at"]),
}, ["id", "url"]);
const stateOperation = { anyOf: [
  object({ op: { const: "set" }, path, value: {} }, ["op", "path", "value"]),
  object({ op: { const: "delete" }, path }, ["op", "path"]),
] };
const block = object({
  id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,80}$" },
  type: { enum: ["message", "status", "choice", "text", "slider", "button", "photo", "location", "file", "drawing", "hardware"] },
  connector: { enum: ["screen", "clipboard", "contacts", "directory", "gamepad", "midi", "hid", "usb", "serial", "bluetooth", "nfc", "xr", "ambient_light", "magnetometer", "proximity", "accelerometer", "gyroscope"] },
  label: { type: "string", maxLength: 200 }, text: { type: "string", maxLength: 2000 },
  options: { type: "array", maxItems: 30, items: string },
  min: { type: "number" }, max: { type: "number" }, value: { type: "number" },
}, ["id", "type"]);
const deviceInfo = object({ id: string, name: nullableString, role: { enum: ROLES }, purpose: { enum: DEVICE_PURPOSES },
  pending: boolean, connected: boolean, primary: boolean, last_seen: nullableTime, ua: nullableString, link: nullableString,
}, ["id", "name", "role", "purpose", "pending", "connected", "primary", "last_seen", "ua", "link"]);
const focus = object({ device: string, expires_at: integer }, ["device", "expires_at"]);
const timerRepeat = { anyOf: [
  object({ every_minutes: { type: "integer", minimum: 1, maximum: 525600 } }, ["every_minutes"]),
  object({ at: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, days: { type: "array", minItems: 1, maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 } } }, ["at"]),
] };
const timerProperties = {
  title: shortText, due_at: { type: "integer", minimum: 0, maximum: 8640000000000000 }, timezone: { type: "string", minLength: 1, maxLength: 100 },
  repeat: timerRepeat, missed: { enum: ["fire_once", "skip"] }, device: string, notify: boolean, state: { enum: ["scheduled", "cancelled", "completed"] },
};
const timerWriteProperties = { ...timerProperties, repeat: { anyOf: [timerRepeat, { type: "null" }] }, device: nullableString };
const timer = object({ ...timerProperties, id: string, created_at: integer, updated_at: integer }, ["id", "title", "due_at", "timezone", "missed", "notify", "state", "created_at", "updated_at"]);
const sessionProperties = {
  purpose: { type: "string", maxLength: 4000 }, current_task: { type: "string", maxLength: 4000 },
  ...Object.fromEntries(["completed", "decisions", "open_questions"].map(key => [key, { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } }])),
  last_handled_seq: integer, source: { type: "string", maxLength: 4000 },
};
const session = object(sessionProperties, ["purpose", "current_task", "completed", "decisions", "open_questions", "last_handled_seq"]);
const decisionProperties = { title: shortText, summary: { type: "string", minLength: 1, maxLength: 8000 }, proposal: {}, expires_at: nullableTime };
const decision = object({ ...decisionProperties, id: string, version: { type: "integer", minimum: 1 },
  status: { enum: ["pending", "approved", "rejected", "revision_requested", "working", "completed", "failed"] },
  created_at: integer, updated_at: integer, responded_at: integer, event_seq: { type: "integer", minimum: 1 }, note: { type: "string", maxLength: 4000 }, result: { type: "string", maxLength: 8000 },
}, ["id", "title", "summary", "version", "expires_at", "status", "created_at", "updated_at"]);
const responseProperties = { prompt_id: { type: "string", minLength: 1, maxLength: 100 }, answer: { type: "string", minLength: 1, maxLength: 8000 } };
const assignmentProperties = { title: shortText, prompt: { type: "string", minLength: 1, maxLength: 8000 }, feedback: { type: "string", maxLength: 8000 }, status: { enum: ["open", "closed"] } };
const assignment = object({ ...assignmentProperties, id: string, participant: string, prompt_id: string,
  revision: { type: "integer", minimum: 1 }, created_at: integer, updated_at: integer }, ["id", "participant", "prompt_id", "title", "prompt", "feedback", "status", "revision", "created_at", "updated_at"]);
const archiveScope = { enum: ["notebook", "guide", "workshop", "experiment", "decisions", "facilitation"] };

const coreSchemas = {
  ...durabilitySchemas,
  error,
  errorResponse: object({ error }, ["error"]),
  create: object({ name: { type: "string", maxLength: 200 }, owner: { type: "string", maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" }, lifetime: { const: "ad_hoc" } }, ["owner"]),
  say: object(sayProperties, ["text"]),
  sayMessage: object({ ...sayProperties, message_id: string, ts: integer, present: boolean }, ["text"], true),
  stateOperation,
  stateOperations: { type: "array", items: stateOperation },
  stateUpdate: { anyOf: [object({ ops: { type: "array", items: stateOperation } }, ["ops"]), jsonObject] },
  interface: object({ title: { type: "string", maxLength: 200 }, description: { type: "string", maxLength: 2000 }, blocks: { type: "array", maxItems: 40, items: block } }, ["blocks"]),
  sendResult: { anyOf: [
    object({ status: { const: "accepted" }, queued: { const: false }, seq: { type: "integer", minimum: 1 } }, ["status", "queued", "seq"]),
    object({ status: { const: "queued" }, queued: { const: true } }, ["status", "queued"]),
    object({ status: { const: "rejected" }, queued: { const: false }, error: string, message: string }, ["status", "queued", "error"]),
  ] },
  blobReference,
  captureOptions: object({ name: string, data: jsonObject, dataPath: { type: "array", items: string }, keep: { type: "boolean" }, wake: { type: "boolean" } }, ["data"]),
  captureResult: { anyOf: [
    object({ capture_id: string, status: { const: "accepted" }, queued: { const: false }, seq: { type: "integer", minimum: 1 }, blob: blobReference }, ["capture_id", "status", "queued", "seq", "blob"]),
    object({ capture_id: string, status: { const: "queued" }, queued: { const: true } }, ["capture_id", "status", "queued"]),
    object({ capture_id: string, status: { const: "rejected" }, queued: { const: false }, error: string, message: string }, ["capture_id", "status", "queued", "error"]),
  ] },
  event: object({ seq: { type: "integer", minimum: 1 }, ts: integer, type: string, role: { enum: [...ROLES, null] }, device: { anyOf: [string, { type: "null" }] }, by: nullableString, data: {}, wake: { type: "boolean" }, withheld: { type: "boolean" } }, ["seq", "ts", "type", "data"], true),
  device: object({ id: string, name: string, role: { enum: ROLES }, purpose: { enum: DEVICE_PURPOSES }, pending: { type: "boolean" } }, ["id", "role"], true),
  deviceInfo,
  deviceUpdate: object({ id: string, name: { anyOf: [{ type: "string", minLength: 1, maxLength: 100 }, { type: "null" }] }, purpose: { enum: DEVICE_PURPOSES } }),
  deviceConfiguration: object({ devices: { type: "array", items: deviceInfo }, focus: { anyOf: [focus, { type: "null" }] } }, ["devices", "focus"]),
  focus,
  focusRequest: object({ device: nullableString, ttl_seconds: { type: "integer", minimum: 30, maximum: 86400 } }, ["device"]),
  timerRepeat,
  timer,
  timerWrite: object(timerWriteProperties),
  timerCreate: object(timerWriteProperties, ["title"]),
  timerRun: object({ id: string, timer_id: string, scheduled_at: integer, fired_at: integer, status: { enum: ["fired", "skipped"] }, event_seq: nullableTime, notification: nullableString,
    delivery: { anyOf: [durabilitySchemas.timerDelivery, { type: "null" }] },
  }, ["id", "timer_id", "scheduled_at", "fired_at", "status", "event_seq", "notification"]),
  session,
  sessionWrite: object({ ...sessionProperties, expected_revision: integer }),
  sessionSummary: object({ session, revision: integer, version: integer, staged_remix: boolean,
    pending_inputs: object({ after: integer, count: integer, earliest_available_seq: nullableTime, history_gap: boolean }, ["after", "count", "earliest_available_seq", "history_gap"]),
    timers: { type: "array", items: timer }, devices: { type: "array", items: deviceInfo },
    recent_activity: { type: "array", items: object({ ts: integer, kind: string, summary: string }, ["ts", "kind", "summary"]) },
  }, ["session", "revision", "version", "staged_remix", "pending_inputs", "timers", "devices", "recent_activity"]),
  bundle: object({ format: { const: "tendriller-bundle" }, version: { const: 1 }, name: { type: "string", minLength: 1, maxLength: 200 },
    files: { type: "array", minItems: 1, maxItems: 2000, items: object({ path: string, type: { type: "string", maxLength: 200 }, base64: string }, ["path", "type", "base64"]) },
    state: jsonObject, session,
    media: { type: "array", items: object({ id: blobReference.properties.id, type: { type: "string", maxLength: 200 }, name: { anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] }, base64: string }, ["id", "type", "name", "base64"]) },
  }, ["format", "version", "name", "files", "media"]),
  bundlePublish: object({ expected_version: integer }, ["expected_version"]),
  remix: object({ owner: { type: "string", maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" }, name: { type: "string", maxLength: 200 }, include_data: boolean }, ["owner"]),
  remixPage: object({ name: { type: "string", maxLength: 200 }, include_data: boolean }),
  decision,
  decisionCreate: object({ ...decisionProperties, status: { const: "pending" } }, ["title", "summary"]),
  decisionUpdate: object({ ...decisionProperties, expected_version: { type: "integer", minimum: 1 }, status: { enum: ["pending", "working", "completed", "failed"] }, result: { type: "string", maxLength: 8000 } }, ["expected_version"]),
  decisionResponse: object({ expected_version: { type: "integer", minimum: 1 }, decision: { enum: ["approve", "reject", "revise"] }, note: { type: "string", maxLength: 4000 } }, ["expected_version", "decision"]),
  participantResponse: object({ ...responseProperties, id: string, participant: string, revision: { type: "integer", minimum: 1 }, created_at: integer, updated_at: integer }, ["id", "participant", "prompt_id", "answer", "revision", "created_at", "updated_at"]),
  participantResponseWrite: object({ ...responseProperties, expected_revision: { type: "integer", minimum: 1 }, expected_assignment_revision: { type: "integer", minimum: 1 }, expected_session_id: { type: "string", minLength: 1, maxLength: 100 } }, ["prompt_id", "answer"]),
  assignment,
  assignmentCreate: object({ ...assignmentProperties, participant: { type: "string", minLength: 1, maxLength: 200 } }, ["participant", "title", "prompt"]),
  assignmentUpdate: object({ ...assignmentProperties, expected_revision: { type: "integer", minimum: 1 } }, ["expected_revision"]),
  archiveScope,
  archiveCreate: object({ scope: archiveScope, title: shortText, expected_state_revision: integer, expected_interaction_revision: integer,
    request_id: { type: "string", pattern: "^[a-zA-Z0-9-]{16,80}$" } }, ["scope", "expected_state_revision", "expected_interaction_revision", "request_id"]),
};
const list = items => ({ type: "array", items });
const pageHandle = object({ id: string, api: string, token: string, page_url: string, name: string }, ["id", "api", "token", "page_url"], true);
const archiveMetadata = { id: string, scope: archiveScope, title: string, created_at: integer };
const archive = object({ ...archiveMetadata, format: { const: "tendriller-session-archive" }, version: { const: 1 }, shared_state: jsonObject,
  decisions: list(decision), responses: list(coreSchemas.participantResponse), assignments: list(assignment) }, ["id", "scope", "title", "created_at", "format", "version", "shared_state"]);
export const schemas = Object.freeze({
  ...coreSchemas,
  pageHandle,
  objectResponse: jsonObject,
  sayResult: object({ ok: { const: true }, message_id: string, in_reply_to: nullableTime }, ["ok", "message_id", "in_reply_to"], true),
  stateSnapshot: object({ state: jsonObject, rev: integer }, ["state", "rev"], true),
  stateRevision: object({ rev: integer }, ["rev"], true),
  eventBatch: object({ events: list(coreSchemas.event), cursor: integer, withheld: integer }, ["events", "cursor", "withheld"], true),
  timerList: object({ timers: list(timer), execution: { const: "server" }, lifetime: { enum: ["ad_hoc", "resident"] }, expires_at: nullableTime }, ["timers", "execution", "lifetime", "expires_at"], true),
  timerHistory: object({ runs: list(coreSchemas.timerRun) }, ["runs"], true),
  sessionResult: object({ session, revision: integer }, ["session", "revision"], true),
  bundleStage: object({ staged: { const: true }, files: integer, media: integer, expected_version: integer, requires_publication: { const: true } }, ["staged", "files", "media", "expected_version", "requires_publication"], true),
  publicationResult: object({ version: integer }, ["version"], true),
  remixResult: object({ ...pageHandle.properties, remix: object({ staged: { const: true }, requires_receiver: { const: true }, publish_url: string, expected_version: integer }, ["staged", "requires_receiver", "publish_url", "expected_version"], true) }, [...pageHandle.required, "remix"], true),
  decisionList: object({ decisions: list(decision) }, ["decisions"], true),
  responseList: object({ participant: string, responses: list(coreSchemas.participantResponse) }, ["responses"], true),
  assignmentList: object({ participant: string, assignments: list(assignment) }, ["assignments"], true),
  participantList: object({ participants: list(object({ id: string, label: string, role: { enum: ["owner", "guest"] } }, ["id", "label", "role"])) }, ["participants"], true),
  archive,
  archivePreview: object({ scope: archiveScope, state_revision: integer, interaction_revision: integer, counts: { type: "object", additionalProperties: integer } }, ["scope", "state_revision", "interaction_revision", "counts"]),
  archiveResult: object({ archive, state_revision: integer, interaction_revision: integer }, ["archive", "state_revision", "interaction_revision"]),
  archiveList: object({ archives: list(object({ ...archiveMetadata, bytes: integer }, [...Object.keys(archiveMetadata), "bytes"])), limit: integer, byte_limit: integer }, ["archives", "limit", "byte_limit"]),
});

export const schemaDocument = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://tendriller.dev/contract/v1.json",
  title: "Tendriller public contract v1",
  $defs: schemas,
});

/** Validate the JSON Schema subset used above. Unknown fields are rejected only
 * where a schema says so; event data and application state remain extensible. */
export function validateSchema(schema, value, path = "$") {
  const issues = [];
  const issue = message => issues.push({ path, message });
  if (schema.$ref) {
    const name = /^#\/\$defs\/([A-Za-z0-9]+)$/.exec(schema.$ref)?.[1];
    if (!name || !Object.hasOwn(schemas, name)) throw new TypeError(`Unknown contract reference: ${schema.$ref}`);
    issues.push(...validateSchema(schemas[name], value, path));
  }
  if (schema.anyOf) {
    const alternatives = schema.anyOf.map(s => validateSchema(s, value, path));
    if (alternatives.every(a => a.length)) issues.push(...alternatives.sort((a, b) => a.length - b.length)[0]);
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) issue(`Expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) issue(`Expected one of ${schema.enum.map(v => JSON.stringify(v)).join(", ")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const valid = types.some(type => type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : type === "array" ? Array.isArray(value) : type === "null" ? value === null
      : type === "integer" ? Number.isSafeInteger(value)
      : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type);
    if (!valid) { issue(`Expected ${types.join(" or ")}`); return issues; }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issue(`Minimum length is ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issue(`Maximum length is ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issue("Value does not match the required format");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issue(`Minimum is ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) issue(`Maximum is ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issue(`Minimum number of items is ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issue(`Maximum number of items is ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => issues.push(...validateSchema(schema.items, v, `${path}[${i}]`)));
  } else if (value !== null && typeof value === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) issues.push({ path: `${path}.${key}`, message: "Required field" });
    for (const [key, v] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) { issues.push({ path: `${path}.${key}`, message: "Reserved key" }); continue; }
      const child = schema.properties?.[key];
      if (child) issues.push(...validateSchema(child, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push({ path: `${path}.${key}`, message: "Unknown field" });
      else if (typeof schema.additionalProperties === "object") issues.push(...validateSchema(schema.additionalProperties, v, `${path}.${key}`));
    }
  }
  return issues;
}

export function validate(name, value) {
  if (!Object.hasOwn(schemas, name)) throw new TypeError(`Unknown contract schema: ${name}`);
  return validateSchema(schemas[name], value);
}

export class ContractError extends TypeError {
  constructor(issues) {
    super(issues.map(i => `${i.path}: ${i.message}`).join("; "));
    this.name = "ContractError";
    this.code = "bad_request";
    this.issues = issues;
  }
}

export function assertValid(name, value) {
  const issues = validate(name, value);
  if (issues.length) throw new ContractError(issues);
  return value;
}
