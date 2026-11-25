/** Public page host metadata and browser composition contract. */
import { isWellFormedUnicode } from './paths.mjs';
export { assertFilePath } from './paths.mjs';
export { RESOURCE_LIMITS } from './limits.mjs';
export const CONTRACT_VERSION = 3;
export const CORE_RELEASE = '0.3.0-rc.17';
export const ROLES = Object.freeze(['owner', 'guest', 'display']);
const string = { type: 'string' }, integer = { type: 'integer', minimum: 0 };
const object = (properties, required = [], additionalProperties = false) => ({ type: 'object', properties, required, additionalProperties });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const application = object({ id: { type: 'string', pattern: '^[0-9a-f]{64}$' } }, ['id']);
const pageId = { type: 'string', pattern: '^[a-z2-7]{12}$' }, agentId = { type: 'string', pattern: '^ag_[a-z2-7]{26}$' };
const email = { type: 'string', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' };
const agentName = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]*$' };
const publicKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const error = object({ code: string, message: string, details: {} }, ['code', 'message'], true);
export const schemas = Object.freeze({
  agentRegistration: object({ owner: email, name: agentName, publicKey }, ['owner', 'name', 'publicKey']),
  agentJoin: object({ code: { type: 'string', minLength: 1, maxLength: 128 }, name: agentName, publicKey }, ['code', 'name', 'publicKey']),
  agentCredential: object({ id: agentId, name: string, token: { type: 'string', pattern: '^ta_[a-z2-7]{32}$' },
    account_state: { enum: ['unclaimed', 'claimed'] } }, ['id', 'name', 'token'], true),
  agentPageCreate: object({ name: { type: 'string', minLength: 1, maxLength: 200 } }),
  // A listed page whose details are momentarily unavailable has null name, page_url and application.
  agentPage: object({ id: pageId, name: nullable(string), page_url: nullable(string), scopes: { type: 'array', items: string, maxItems: 16 },
    application: { anyOf: [application, { type: 'null' }] }, lifetime: string }, ['id', 'page_url', 'application'], true),
  agentPageList: object({ pages: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/agentPage' } },
    next_cursor: { anyOf: [string, { type: 'null' }] } }, ['pages'], true),
  serviceDescriptor: object({ contract: { const: 3 }, core_release: string, limits: { type: 'object' } }, ['contract', 'core_release', 'limits']),
  objectResponse: { type: 'object' }, error, errorResponse: object({ error }, ['error']),
});

export const schemaDocument = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://tendriller.dev/contract/v3.json",
  title: "Tendriller public contract v3",
  $defs: schemas,
});

/** Validate the JSON Schema subset used above. Unknown fields are rejected only
 * where a schema says so; event data and application state remain extensible. */
export function validateSchema(schema, value, path = "$", depth = 0) {
  // Recursive JSON schemas must reject cycles and excessively nested input, not
  // exhaust the stack before a caller can return a normal validation error.
  if (depth > 128) return [{ path, message: "Maximum validation depth exceeded" }];
  const issues = [];
  const issue = message => issues.push({ path, message });
  if (schema.$ref) {
    const name = /^#\/\$defs\/([A-Za-z0-9]+)$/.exec(schema.$ref)?.[1];
    if (!name || !Object.hasOwn(schemas, name)) throw new TypeError(`Unknown contract reference: ${schema.$ref}`);
    issues.push(...validateSchema(schemas[name], value, path, depth + 1));
  }
  if (schema.anyOf) {
    const alternatives = schema.anyOf.map(s => validateSchema(s, value, path, depth + 1));
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
    if (schema["x-well-formed-unicode"] && !isWellFormedUnicode(value)) issue("Value must contain well-formed Unicode");
    if (schema["x-canonical-nfc"] && value.normalize("NFC") !== value) issue("Value must use canonical Unicode NFC");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issue(`Minimum is ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) issue(`Maximum is ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issue(`Minimum number of items is ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issue(`Maximum number of items is ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => issues.push(...validateSchema(schema.items, v, `${path}[${i}]`, depth + 1)));
  } else if (value !== null && typeof value === "object") {
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) issue(`Maximum number of properties is ${schema.maxProperties}`);
    if (schema.propertyNames) for (const key of Object.keys(value)) issues.push(...validateSchema(schema.propertyNames, key, `${path}.${key}`, depth + 1));
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) issues.push({ path: `${path}.${key}`, message: "Required field" });
    for (const [key, v] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) { issues.push({ path: `${path}.${key}`, message: "Reserved key" }); continue; }
      const child = schema.properties?.[key];
      if (child) issues.push(...validateSchema(child, v, `${path}.${key}`, depth + 1));
      else if (schema.additionalProperties === false) issues.push({ path: `${path}.${key}`, message: "Unknown field" });
      else if (typeof schema.additionalProperties === "object") issues.push(...validateSchema(schema.additionalProperties, v, `${path}.${key}`, depth + 1));
    }
  }
  return issues;
}

export function validate(name, value) {
  if (!Object.hasOwn(schemas, name)) throw new TypeError(`Unknown contract schema: ${name}`);
  const issues = validateSchema(schemas[name], value);
  return issues;
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
