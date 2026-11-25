import {
  CanonicalError,
  DEFAULT_DECODE_LIMITS,
  assertCanonicalCbor,
  bytesToHex,
  compareBytes,
  concatBytes,
  domainSeparatedBytes,
  encodeCanonicalCbor,
  equalBytes,
  hashDomain,
  hexToBytes,
  sha256,
  utf8
} from "./chunk-HYFY2E3E.mjs";

// packages/protocol/src/errors.ts
var ProtocolError = class extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return this.details === void 0 ? { name: this.name, code: this.code, message: this.message } : { name: this.name, code: this.code, message: this.message, details: this.details };
  }
};
function protocolInvariant(condition, code, message, details) {
  if (!condition) throw new ProtocolError(code, message, details);
}

// packages/protocol/src/bytes.ts
function wrap(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    if (error instanceof CanonicalError) throw new ProtocolError(error.code, error.message, error.details);
    throw error;
  }
}
function utf82(value) {
  return wrap(() => utf8(value));
}
function bytesToHex2(value) {
  return bytesToHex(value);
}
function hexToBytes2(value) {
  return wrap(() => hexToBytes(value));
}
function bytesToBase64Url(value) {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 16384) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 16384));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

// packages/protocol/src/cbor.ts
function sharedLimits(limits) {
  return {
    maxBytes: limits.maxBytes ?? DEFAULT_DECODE_LIMITS.maxBytes,
    maxDepth: limits.maxDepth ?? DEFAULT_DECODE_LIMITS.maxDepth,
    maxArrayItems: limits.maxItems ?? DEFAULT_DECODE_LIMITS.maxArrayItems,
    maxMapItems: limits.maxItems ?? DEFAULT_DECODE_LIMITS.maxMapItems,
    maxTextBytes: limits.maxTextBytes ?? DEFAULT_DECODE_LIMITS.maxTextBytes,
    maxBlobBytes: limits.maxByteStringBytes ?? DEFAULT_DECODE_LIMITS.maxBlobBytes
  };
}
function protocolError(error) {
  if (error instanceof ProtocolError) throw error;
  if (error instanceof CanonicalError) throw new ProtocolError(error.code, error.message, error.details);
  throw error;
}
function assertCanonicalCbor2(input, limits = {}) {
  try {
    return assertCanonicalCbor(input, sharedLimits(limits));
  } catch (error) {
    return protocolError(error);
  }
}

// packages/protocol/src/schema.ts
function integerMap(entries) {
  const result = /* @__PURE__ */ new Map();
  for (const [key, value] of entries) {
    if (value !== void 0) result.set(BigInt(key), value);
  }
  return result;
}
function expectMap(value, name2) {
  protocolInvariant(value instanceof Map, "SCHEMA_INVALID", `${name2} must be a CBOR map`);
  return value;
}
function expectArray(value, name2) {
  protocolInvariant(Array.isArray(value), "SCHEMA_INVALID", `${name2} must be a CBOR array`);
  return value;
}
function expectBytes(value, name2, length) {
  protocolInvariant(value instanceof Uint8Array, "SCHEMA_INVALID", `${name2} must be bytes`);
  if (length !== void 0) {
    protocolInvariant(value.length === length, "SCHEMA_INVALID", `${name2} must contain ${length} bytes`);
  }
  return value;
}
function expectString(value, name2) {
  protocolInvariant(typeof value === "string", "SCHEMA_INVALID", `${name2} must be text`);
  return value;
}
function expectBigint(value, name2) {
  protocolInvariant(typeof value === "bigint", "SCHEMA_INVALID", `${name2} must be an integer`);
  return value;
}
function expectUint64(value, name2) {
  const integer = expectBigint(value, name2);
  protocolInvariant(integer >= 0n && integer <= (1n << 64n) - 1n, "INTEGER_OUT_OF_RANGE", `${name2} is outside uint64 range`);
  return integer;
}
function expectInt64(value, name2) {
  const integer = expectBigint(value, name2);
  protocolInvariant(integer >= -(1n << 63n) && integer <= (1n << 63n) - 1n, "INTEGER_OUT_OF_RANGE", `${name2} is outside int64 range`);
  return integer;
}
function required(map, key, name2) {
  const value = map.get(BigInt(key));
  if (value === void 0) throw new ProtocolError("SCHEMA_INVALID", `Missing required field ${name2}`, { field: name2 });
  return value;
}
function optional(map, key) {
  return map.get(BigInt(key));
}
function assertKnownIntegerKeys(map, knownKeys, name2) {
  const known = new Set(knownKeys.map(BigInt));
  for (const key of map.keys()) {
    protocolInvariant(typeof key === "bigint", "SCHEMA_INVALID", `${name2} contains a non-integer field key`);
    protocolInvariant(known.has(key), "SCHEMA_INVALID", `${name2} contains unknown critical field ${String(key)}`);
  }
}
function expectVersion(map, expected, name2) {
  const version2 = expectUint64(required(map, 0, `${name2}.version`), `${name2}.version`);
  protocolInvariant(version2 === expected, "UNSUPPORTED_VERSION", `Unsupported ${name2} version`, { version: version2.toString() });
}

// packages/protocol/src/sql.ts
var MAX_SQL_STATEMENT_BINDINGS = 1e3;
var MIN_INT64 = -(1n << 63n);
var MAX_INT64 = (1n << 63n) - 1n;
var sqlValue = Object.freeze({
  null: () => ({ kind: "null" }),
  integer: (value) => {
    const integer = typeof value === "bigint" ? value : BigInt(value);
    protocolInvariant(integer >= MIN_INT64 && integer <= MAX_INT64, "INTEGER_OUT_OF_RANGE", "SQL INTEGER must be signed 64-bit");
    return { kind: "integer", value: integer };
  },
  real: (value) => {
    protocolInvariant(Number.isFinite(value), "SCHEMA_INVALID", "SQL REAL must be finite");
    return { kind: "real", value };
  },
  text: (value) => {
    utf82(value);
    return { kind: "text", value };
  },
  blob: (value) => ({ kind: "blob", value: Uint8Array.from(value) })
});
function toSqlValue(value) {
  if (value === null || value === void 0) return sqlValue.null();
  if (typeof value === "bigint") return sqlValue.integer(value);
  if (typeof value === "number") return Number.isSafeInteger(value) ? sqlValue.integer(value) : sqlValue.real(value);
  if (typeof value === "boolean") return sqlValue.integer(value ? 1n : 0n);
  if (typeof value === "string") return sqlValue.text(value);
  if (value instanceof Uint8Array) return sqlValue.blob(value);
  if (isSqlValue(value)) return value;
  throw new TypeError("SQL values must be null, boolean, bigint, number, string, Uint8Array or a tagged SqlValue");
}
function isSqlValue(value) {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const tagged = value;
  switch (tagged.kind) {
    case "null":
      return true;
    case "integer":
      return typeof tagged.value === "bigint";
    case "real":
      return typeof tagged.value === "number";
    case "text":
      return typeof tagged.value === "string";
    case "blob":
      return tagged.value instanceof Uint8Array;
    default:
      return false;
  }
}
function sqlStatement(sql, parameters = []) {
  const bindings = Array.isArray(parameters) ? parameters.map((value, index) => ({ parameter: { kind: "index", index: index + 1 }, value: toSqlValue(value) })) : Object.entries(parameters).map(([name2, value]) => ({
    parameter: { kind: "name", name: /^[:@$]/u.test(name2) ? name2 : `:${name2}` },
    value: toSqlValue(value)
  }));
  const statement = { sql, bindings };
  sqlStatementToCanonicalCbor(statement);
  return statement;
}
function realBits(value) {
  const bits = new Uint8Array(8);
  new DataView(bits.buffer).setFloat64(0, value, false);
  return bits;
}
function sqlValueToCanonicalCbor(value) {
  switch (value.kind) {
    case "null":
      return [0n];
    case "integer":
      protocolInvariant(value.value >= MIN_INT64 && value.value <= MAX_INT64, "INTEGER_OUT_OF_RANGE", "SQL INTEGER must be signed 64-bit");
      return [1n, value.value];
    case "real":
      protocolInvariant(Number.isFinite(value.value), "SCHEMA_INVALID", "SQL REAL must be finite");
      return [2n, realBits(value.value)];
    case "text":
      utf82(value.value);
      return [3n, value.value];
    case "blob":
      return [4n, Uint8Array.from(value.value)];
  }
}
function sqlValueFromCanonicalCbor(value, name2 = "sql_value") {
  const tuple = expectArray(value, name2);
  const kind = expectUint64(tuple[0] ?? null, `${name2}.kind`);
  protocolInvariant(tuple.length === (kind === 0n ? 1 : 2), "SCHEMA_INVALID", `${name2} has invalid arity`);
  switch (kind) {
    case 0n:
      return { kind: "null" };
    case 1n:
      return { kind: "integer", value: expectInt64(tuple[1] ?? null, `${name2}.integer`) };
    case 2n: {
      const bits = expectBytes(tuple[1] ?? null, `${name2}.real`, 8);
      const real = new DataView(bits.buffer, bits.byteOffset, 8).getFloat64(0, false);
      protocolInvariant(Number.isFinite(real), "SCHEMA_INVALID", `${name2}.real must be finite`);
      return { kind: "real", value: real };
    }
    case 3n:
      return { kind: "text", value: expectString(tuple[1] ?? null, `${name2}.text`) };
    case 4n:
      return { kind: "blob", value: Uint8Array.from(expectBytes(tuple[1] ?? null, `${name2}.blob`)) };
    default:
      protocolInvariant(false, "SCHEMA_INVALID", `${name2} has unknown kind`);
  }
}
function bindingToCbor(binding) {
  if (binding.parameter.kind === "index") {
    const index = binding.parameter.index;
    protocolInvariant(Number.isSafeInteger(index) && index >= 1, "INTEGER_OUT_OF_RANGE", "SQL binding index must be a positive integer");
    return [[0n, BigInt(index)], sqlValueToCanonicalCbor(binding.value)];
  }
  protocolInvariant(/^[:@$].+/u.test(binding.parameter.name), "SCHEMA_INVALID", "Named SQL bindings must keep their SQLite prefix (:, @ or $)");
  return [[1n, binding.parameter.name], sqlValueToCanonicalCbor(binding.value)];
}
function bindingFromCbor(value, name2) {
  const tuple = expectArray(value, name2);
  protocolInvariant(tuple.length === 2, "SCHEMA_INVALID", `${name2} has invalid arity`);
  const parameter = expectArray(tuple[0] ?? null, `${name2}.parameter`);
  protocolInvariant(parameter.length === 2, "SCHEMA_INVALID", `${name2}.parameter has invalid arity`);
  const kind = expectUint64(parameter[0] ?? null, `${name2}.parameter.kind`);
  let decoded;
  if (kind === 0n) {
    const index = expectUint64(parameter[1] ?? null, `${name2}.parameter.index`);
    protocolInvariant(index >= 1n && index <= BigInt(MAX_SQL_STATEMENT_BINDINGS), "INTEGER_OUT_OF_RANGE", `${name2}.parameter.index is out of range`);
    decoded = { kind: "index", index: Number(index) };
  } else {
    protocolInvariant(kind === 1n, "SCHEMA_INVALID", `${name2}.parameter has unknown kind`);
    const parameterName = expectString(parameter[1] ?? null, `${name2}.parameter.name`);
    protocolInvariant(/^[:@$].+/u.test(parameterName), "SCHEMA_INVALID", `${name2}.parameter.name must keep its SQLite prefix`);
    decoded = { kind: "name", name: parameterName };
  }
  return { parameter: decoded, value: sqlValueFromCanonicalCbor(tuple[1] ?? null, `${name2}.value`) };
}
function parameterKey(parameter) {
  return parameter.kind === "index" ? `#${parameter.index}` : parameter.name;
}
function sqlStatementToCanonicalCbor(value) {
  protocolInvariant(typeof value.sql === "string" && value.sql.trim().length > 0, "SCHEMA_INVALID", "SQL statement source cannot be empty");
  protocolInvariant(!value.sql.includes("\0"), "SCHEMA_INVALID", "SQL statement source cannot contain U+0000");
  utf82(value.sql);
  protocolInvariant(value.bindings.length <= MAX_SQL_STATEMENT_BINDINGS, "SCHEMA_INVALID", "SQL statement has too many bindings");
  const seen = /* @__PURE__ */ new Set();
  for (const binding of value.bindings) {
    const key = parameterKey(binding.parameter);
    protocolInvariant(!seen.has(key), "SCHEMA_INVALID", "SQL statement binds a parameter twice");
    seen.add(key);
  }
  return integerMap([[0, value.sql], [1, value.bindings.map(bindingToCbor)]]);
}
function sqlStatementFromCanonicalCbor(value, name2 = "sql_statement") {
  const map = expectMap(value, name2);
  assertKnownIntegerKeys(map, [0, 1], name2);
  const statement = {
    sql: expectString(required(map, 0, `${name2}.sql`), `${name2}.sql`),
    bindings: expectArray(required(map, 1, `${name2}.bindings`), `${name2}.bindings`).map((binding, index) => bindingFromCbor(binding, `${name2}.bindings[${index}]`))
  };
  sqlStatementToCanonicalCbor(statement);
  return statement;
}
var DEFAULT_EXECUTION_LIMITS = Object.freeze({
  maxSqlBytes: 1e6,
  maxVmSteps: 1e6,
  maxValueBytes: 16 * 1024 * 1024
});
function createExecutionManifest(options) {
  const manifest = {
    version: 2,
    profile: options.profile,
    engine: options.engine ?? "doltlite",
    engineDigest: Uint8Array.from(options.engineDigest),
    programVersion: 3,
    platformDigest: Uint8Array.from(options.platformDigest),
    recursiveTriggers: true,
    limits: { ...DEFAULT_EXECUTION_LIMITS, ...options.limits }
  };
  executionManifestToCbor(manifest);
  return manifest;
}
function positiveLimit(value, name2) {
  protocolInvariant(Number.isSafeInteger(value) && value >= 1, "INTEGER_OUT_OF_RANGE", `${name2} must be a positive safe integer`);
  return BigInt(value);
}
function executionManifestToCbor(value) {
  protocolInvariant(value.version === 2 && value.programVersion === 3, "UNSUPPORTED_VERSION", "Unsupported execution manifest version");
  protocolInvariant(value.profile.length > 0 && value.engine.length > 0, "SCHEMA_INVALID", "Execution manifest needs a profile and engine");
  protocolInvariant(value.engineDigest.length === 32, "SCHEMA_INVALID", "Execution manifest engine digest must be 32 bytes");
  protocolInvariant(value.platformDigest.length === 32, "SCHEMA_INVALID", "Execution manifest platform digest must be 32 bytes");
  protocolInvariant(value.recursiveTriggers === true, "SCHEMA_INVALID", "Consensus execution requires recursive_triggers");
  return integerMap([
    [0, 2n],
    [1, value.profile],
    [2, value.engine],
    [3, Uint8Array.from(value.engineDigest)],
    [4, 3n],
    [5, integerMap([
      [0, positiveLimit(value.limits.maxSqlBytes, "maxSqlBytes")],
      [1, positiveLimit(value.limits.maxVmSteps, "maxVmSteps")],
      [2, positiveLimit(value.limits.maxValueBytes, "maxValueBytes")]
    ])],
    [6, Uint8Array.from(value.platformDigest)],
    [7, integerMap([[0, true]])]
  ]);
}
function encodeExecutionManifest(value) {
  return encodeCanonicalCbor(executionManifestToCbor(value));
}
async function digestExecutionManifest(value) {
  return hashDomain("executionManifest", encodeExecutionManifest(value));
}
async function executionManifestArtifacts(value) {
  return {
    executionManifestDigest: await digestExecutionManifest(value),
    canonicalExecutionManifest: encodeExecutionManifest(value)
  };
}

// packages/protocol/src/sealed.ts
var MAX_SEALED_READERS = 256;
var MAX_SEALED_NAME_BYTES = 128;
var MAX_SEALED_ROW_KEY_VALUES = 64;
var MAX_SEALED_PLAINTEXT_BYTES = 1024 * 1024;
var MAX_SEALED_ENVELOPE_BYTES = MAX_SEALED_PLAINTEXT_BYTES + MAX_SEALED_READERS * 192 + 1024;
var MAX_SEALED_VERSION = (1n << 63n) - 1n;
var SEALED_OP_CODES = Object.freeze({
  register_reader_key: 64n,
  reader_policy: 65n,
  sealed_put: 66n
});
function isSealedPlatformOp(value) {
  return typeof value === "object" && value !== null && "op" in value && typeof value.op === "string" && Object.hasOwn(SEALED_OP_CODES, value.op);
}
var sealedOp = Object.freeze({
  registerReaderKey: (publicKey) => checked({ op: "register_reader_key", publicKey: id(publicKey, "register_reader_key.public_key") }),
  readerPolicy: (input) => checked({
    op: "reader_policy",
    table: input.table,
    rowKey: input.rowKey.map(toSqlValue),
    expectedVersion: input.expectedVersion,
    ...input.expectedPolicyId === void 0 ? {} : { expectedPolicyId: id(input.expectedPolicyId, "reader_policy.expected_policy_id") },
    readers: input.readers.map((reader) => id(reader, "reader_policy.reader")).sort(compareBytes)
  }),
  put: (input) => checked({
    op: "sealed_put",
    policyId: id(input.policyId, "sealed_put.policy_id"),
    expectedPolicyVersion: input.expectedPolicyVersion,
    expectedDataVersion: input.expectedDataVersion,
    slot: input.slot,
    envelope: decodeSealedEnvelope(encodeSealedEnvelope(input.envelope))
  })
});
function checked(op) {
  return sealedPlatformOpFromCanonicalCbor(sealedPlatformOpToCanonicalCbor(op));
}
function id(value, field) {
  protocolInvariant(value instanceof Uint8Array && value.length === 32, "SCHEMA_INVALID", `${field} must contain 32 bytes`);
  return Uint8Array.from(value);
}
function name(value, field) {
  protocolInvariant(typeof value === "string" && value.length > 0 && !value.includes("\0"), "SCHEMA_INVALID", `${field} must be nonempty text without U+0000`);
  protocolInvariant(utf82(value).length <= MAX_SEALED_NAME_BYTES, "SCHEMA_INVALID", `${field} is too long`);
  return value;
}
function version(value, field, minimum = 1n, maximum = MAX_SEALED_VERSION) {
  const parsed = expectUint64(value, field);
  protocolInvariant(parsed >= minimum && parsed <= maximum, "INTEGER_OUT_OF_RANGE", `${field} is outside the supported version range`);
  return parsed;
}
var isList = (value) => Array.isArray(value);
function orderedReaders(readers, field) {
  protocolInvariant(isList(readers) && readers.length <= MAX_SEALED_READERS, "SCHEMA_INVALID", `${field} has too many readers or is not an array`);
  return readers.map((reader, index) => {
    const key = id(reader, field);
    if (index > 0) protocolInvariant(compareBytes(readers[index - 1], reader) < 0, "SCHEMA_INVALID", `${field} must be sorted and unique`);
    return key;
  });
}
function sealedContextToCanonicalCbor(value) {
  return integerMap([
    [0, 1n],
    [1, id(value.groupId, "sealed_context.group_id")],
    [2, id(value.policyId, "sealed_context.policy_id")],
    [3, version(value.policyVersion, "sealed_context.policy_version")],
    [4, name(value.slot, "sealed_context.slot")],
    [5, version(value.dataVersion, "sealed_context.data_version")]
  ]);
}
function sealedContextFromCanonicalCbor(value) {
  const map = expectMap(value, "sealed_context");
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5], "sealed_context");
  expectVersion(map, 1n, "sealed_context");
  const context = {
    groupId: id(expectBytes(required(map, 1, "group_id"), "group_id", 32), "group_id"),
    policyId: id(expectBytes(required(map, 2, "policy_id"), "policy_id", 32), "policy_id"),
    policyVersion: expectUint64(required(map, 3, "policy_version"), "policy_version"),
    slot: expectString(required(map, 4, "slot"), "slot"),
    dataVersion: expectUint64(required(map, 5, "data_version"), "data_version")
  };
  sealedContextToCanonicalCbor(context);
  return context;
}
function sealedEnvelopeToCanonicalCbor(value) {
  protocolInvariant(value.nonce instanceof Uint8Array && value.nonce.length === 12, "SCHEMA_INVALID", "sealed_envelope.nonce must contain 12 bytes");
  protocolInvariant(
    value.ciphertext instanceof Uint8Array && value.ciphertext.length >= 16 && value.ciphertext.length <= MAX_SEALED_PLAINTEXT_BYTES + 16,
    "SCHEMA_INVALID",
    "sealed_envelope.ciphertext has an invalid length"
  );
  protocolInvariant(isList(value.wraps), "SCHEMA_INVALID", "sealed_envelope.wraps must be an array");
  orderedReaders(value.wraps.map((wrap2) => wrap2.readerId), "sealed_envelope.wraps");
  return integerMap([
    [0, 1n],
    [1, sealedContextToCanonicalCbor(value.context)],
    [2, Uint8Array.from(value.nonce)],
    [3, Uint8Array.from(value.ciphertext)],
    [4, value.wraps.map((wrap2) => {
      protocolInvariant(wrap2.ciphertext instanceof Uint8Array && wrap2.ciphertext.length === 48, "SCHEMA_INVALID", "sealed_wrap.ciphertext must contain 48 bytes");
      return [
        id(wrap2.readerId, "sealed_wrap.reader_id"),
        id(wrap2.publicKey, "sealed_wrap.public_key"),
        id(wrap2.encapsulatedKey, "sealed_wrap.encapsulated_key"),
        Uint8Array.from(wrap2.ciphertext)
      ];
    })]
  ]);
}
function sealedEnvelopeFromCanonicalCbor(value) {
  const map = expectMap(value, "sealed_envelope");
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4], "sealed_envelope");
  expectVersion(map, 1n, "sealed_envelope");
  const envelope = {
    context: sealedContextFromCanonicalCbor(required(map, 1, "context")),
    nonce: Uint8Array.from(expectBytes(required(map, 2, "nonce"), "nonce", 12)),
    ciphertext: Uint8Array.from(expectBytes(required(map, 3, "ciphertext"), "ciphertext")),
    wraps: expectArray(required(map, 4, "wraps"), "wraps").map((entry) => {
      const fields = expectArray(entry, "sealed_wrap");
      protocolInvariant(fields.length === 4, "SCHEMA_INVALID", "sealed_wrap must contain four fields");
      return {
        readerId: id(expectBytes(fields[0], "reader_id", 32), "reader_id"),
        publicKey: id(expectBytes(fields[1], "public_key", 32), "public_key"),
        encapsulatedKey: id(expectBytes(fields[2], "encapsulated_key", 32), "encapsulated_key"),
        ciphertext: Uint8Array.from(expectBytes(fields[3], "wrapped_key", 48))
      };
    })
  };
  sealedEnvelopeToCanonicalCbor(envelope);
  return envelope;
}
function encodeSealedEnvelope(envelope) {
  return encodeCanonicalCbor(sealedEnvelopeToCanonicalCbor(envelope));
}
function decodeSealedEnvelope(bytes2) {
  protocolInvariant(bytes2.length <= MAX_SEALED_ENVELOPE_BYTES, "SCHEMA_INVALID", "sealed_envelope exceeds the encoded size limit");
  return sealedEnvelopeFromCanonicalCbor(assertCanonicalCbor2(bytes2));
}
function sealedPlatformOpToCanonicalCbor(op) {
  protocolInvariant(isSealedPlatformOp(op), "SCHEMA_INVALID", "Unknown sealed operation");
  const entries = [[0, SEALED_OP_CODES[op.op]]];
  switch (op.op) {
    case "register_reader_key":
      entries.push([1, id(op.publicKey, "register_reader_key.public_key")]);
      break;
    case "reader_policy": {
      const expected = version(op.expectedVersion, "reader_policy.expected_version", 0n, MAX_SEALED_VERSION - 1n);
      protocolInvariant(expected === 0n === (op.expectedPolicyId === void 0), "SCHEMA_INVALID", "reader_policy creation uses version 0 without an id; replacement requires an id and positive version");
      protocolInvariant(isList(op.rowKey) && op.rowKey.length >= 1 && op.rowKey.length <= MAX_SEALED_ROW_KEY_VALUES, "SCHEMA_INVALID", "reader_policy.row_key has an invalid length");
      entries.push(
        [1, name(op.table, "reader_policy.table")],
        [2, op.rowKey.map(sqlValueToCanonicalCbor)],
        [3, op.expectedPolicyId === void 0 ? void 0 : id(op.expectedPolicyId, "reader_policy.expected_policy_id")],
        [4, expected],
        [5, orderedReaders(op.readers, "reader_policy.readers")]
      );
      break;
    }
    case "sealed_put": {
      const policyId = id(op.policyId, "sealed_put.policy_id");
      const policyVersion = version(op.expectedPolicyVersion, "sealed_put.expected_policy_version");
      const dataVersion = version(op.expectedDataVersion, "sealed_put.expected_data_version", 0n, MAX_SEALED_VERSION - 1n);
      const slot = name(op.slot, "sealed_put.slot");
      const envelope = sealedEnvelopeToCanonicalCbor(op.envelope);
      protocolInvariant(
        equalBytes(op.envelope.context.policyId, policyId) && op.envelope.context.policyVersion === policyVersion && op.envelope.context.slot === slot && op.envelope.context.dataVersion === dataVersion + 1n,
        "SCHEMA_INVALID",
        "sealed_put envelope does not match its policy, slot or next data version"
      );
      entries.push([1, policyId], [2, policyVersion], [3, dataVersion], [4, slot], [5, envelope]);
      break;
    }
  }
  return integerMap(entries);
}
function sealedPlatformOpFromCanonicalCbor(value, field = "sealed_op") {
  const map = expectMap(value, field);
  const code = expectUint64(required(map, 0, `${field}.op`), `${field}.op`);
  let op;
  if (code === SEALED_OP_CODES.register_reader_key) {
    assertKnownIntegerKeys(map, [0, 1], field);
    op = { op: "register_reader_key", publicKey: id(expectBytes(required(map, 1, "public_key"), "public_key", 32), "public_key") };
  } else if (code === SEALED_OP_CODES.reader_policy) {
    assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5], field);
    const expectedPolicyId = optional(map, 3);
    op = {
      op: "reader_policy",
      table: expectString(required(map, 1, "table"), "table"),
      rowKey: expectArray(required(map, 2, "row_key"), "row_key").map((item, index) => sqlValueFromCanonicalCbor(item, `row_key[${index}]`)),
      ...expectedPolicyId === void 0 ? {} : { expectedPolicyId: id(expectBytes(expectedPolicyId, "expected_policy_id", 32), "expected_policy_id") },
      expectedVersion: expectUint64(required(map, 4, "expected_version"), "expected_version"),
      readers: expectArray(required(map, 5, "readers"), "readers").map((reader) => id(expectBytes(reader, "reader", 32), "reader"))
    };
  } else if (code === SEALED_OP_CODES.sealed_put) {
    assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5], field);
    op = {
      op: "sealed_put",
      policyId: id(expectBytes(required(map, 1, "policy_id"), "policy_id", 32), "policy_id"),
      expectedPolicyVersion: expectUint64(required(map, 2, "expected_policy_version"), "expected_policy_version"),
      expectedDataVersion: expectUint64(required(map, 3, "expected_data_version"), "expected_data_version"),
      slot: expectString(required(map, 4, "slot"), "slot"),
      envelope: sealedEnvelopeFromCanonicalCbor(required(map, 5, "envelope"))
    };
  } else {
    protocolInvariant(false, "SCHEMA_INVALID", `${field} has an unknown sealed operation`);
  }
  sealedPlatformOpToCanonicalCbor(op);
  return op;
}

// packages/protocol/src/platform.ts
var PLATFORM_ID_BYTES = 32;
var MAX_PLATFORM_NAME_BYTES = 128;
var MAX_PLATFORM_LIST_ENTRIES = 256;
var MAX_ROW_KEY_VALUES = 64;
var MAX_SEED_ROWS = 1e4;
var GROUP_COLLECTIVE_ID = new Uint8Array(PLATFORM_ID_BYTES);
var OP_CODES = [
  "grant",
  "revoke_grant",
  "create_collective",
  "accept_membership",
  "leave",
  "set_members",
  "transfer_offer",
  "transfer_accept",
  "seed_rows",
  "end_seeding",
  "transfer_cancel",
  "grant_ddl",
  "revoke_ddl"
];
var DDL_OPERATIONS = ["create", "alter", "drop", "index", "trigger"];
var OPERATION_BITS = { insert: 1n, update: 2n, delete: 4n };
var GRANT_OPERATIONS = ["insert", "update", "delete"];
function isPlatformOp(value) {
  return isSealedPlatformOp(value) || typeof value === "object" && value !== null && "op" in value && OP_CODES.includes(value.op);
}
var bytes = (value) => Uint8Array.from(value);
var rowKey = (values) => values.map(toSqlValue);
var platformOp = Object.freeze({
  ...sealedOp,
  grantDdl: (input) => checked2({ op: "grant_ddl", scope: { ...input.scope }, grantee: bytes(input.grantee), operations: [...input.operations] }),
  revokeDdl: (grantId) => checked2({ op: "revoke_ddl", grantId: bytes(grantId) }),
  grant: (input) => checked2({
    op: "grant",
    table: input.table,
    grantee: bytes(input.grantee),
    operations: [...input.operations],
    ...input.grantor === void 0 ? {} : { grantor: bytes(input.grantor) },
    ...input.rowKey === void 0 ? {} : { rowKey: rowKey(input.rowKey) },
    ...input.columns === void 0 ? {} : { columns: [...input.columns] }
  }),
  revokeGrant: (grantId) => checked2({ op: "revoke_grant", grantId: bytes(grantId) }),
  createCollective: (input) => checked2({ op: "create_collective", governance: { ...input.governance }, invitees: (input.invitees ?? []).map(bytes) }),
  acceptMembership: (collectiveId) => checked2({ op: "accept_membership", collectiveId: bytes(collectiveId) }),
  leave: (collectiveId) => checked2({ op: "leave", collectiveId: bytes(collectiveId) }),
  setMembers: (collectiveId, changes) => checked2({
    op: "set_members",
    collectiveId: bytes(collectiveId),
    changes: changes.map((change) => ({ member: bytes(change.member), role: change.role }))
  }),
  transferRow: (input) => checked2({
    op: "transfer_offer",
    scope: { kind: "row", table: input.table, rowKey: rowKey(input.rowKey) },
    toOwner: bytes(input.toOwner),
    carry: input.carry ?? false,
    ...input.fromOwner === void 0 ? {} : { fromOwner: bytes(input.fromOwner) }
  }),
  transferAll: (input) => checked2({
    op: "transfer_offer",
    scope: { kind: "all" },
    toOwner: bytes(input.toOwner),
    carry: true,
    ...input.fromOwner === void 0 ? {} : { fromOwner: bytes(input.fromOwner) }
  }),
  acceptTransfer: (offerId) => checked2({ op: "transfer_accept", offerId: bytes(offerId) }),
  cancelTransfer: (offerId) => checked2({ op: "transfer_cancel", offerId: bytes(offerId) }),
  seedRows: (table, columns, rows) => checked2({ op: "seed_rows", table, columns: [...columns], rows: rows.map(rowKey) }),
  endSeeding: () => checked2({ op: "end_seeding" })
});
function checked2(op) {
  platformOpToCanonicalCbor(op);
  return op;
}
function nameToCbor(value, field) {
  protocolInvariant(typeof value === "string" && value.length > 0, "SCHEMA_INVALID", `${field} cannot be empty`);
  protocolInvariant(!value.includes("\0"), "SCHEMA_INVALID", `${field} cannot contain U+0000`);
  protocolInvariant(utf82(value).length <= MAX_PLATFORM_NAME_BYTES, "SCHEMA_INVALID", `${field} is too long`);
  return value;
}
function idToCbor(value, field) {
  protocolInvariant(value instanceof Uint8Array && value.length === PLATFORM_ID_BYTES, "SCHEMA_INVALID", `${field} must contain ${PLATFORM_ID_BYTES} bytes`);
  return Uint8Array.from(value);
}
function listToCbor(values, field, encode, minimum = 0) {
  protocolInvariant(isList2(values), "SCHEMA_INVALID", `${field} must be a list`);
  protocolInvariant(values.length >= minimum && values.length <= MAX_PLATFORM_LIST_ENTRIES, "SCHEMA_INVALID", `${field} has an invalid number of entries`);
  return values.map(encode);
}
function uniqueBy(values, key, field) {
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    const entry = key(value);
    protocolInvariant(!seen.has(entry), "SCHEMA_INVALID", `${field} contains a duplicate`);
    seen.add(entry);
  }
}
var hex = (value) => bytesToHex2(value);
var isList2 = (value) => Array.isArray(value);
function rowKeyToCbor(values, field) {
  protocolInvariant(isList2(values) && values.length >= 1 && values.length <= MAX_ROW_KEY_VALUES, "SCHEMA_INVALID", `${field} must have 1 to ${MAX_ROW_KEY_VALUES} values`);
  return values.map(sqlValueToCanonicalCbor);
}
function roleCode(role, field) {
  protocolInvariant(role === "member" || role === "admin", "SCHEMA_INVALID", `${field} must be member or admin`);
  return role === "member" ? 0n : 1n;
}
function roleFromCode(value, field) {
  const code = expectUint64(value, field);
  protocolInvariant(code <= 1n, "SCHEMA_INVALID", `${field} must be member or admin`);
  return code === 0n ? "member" : "admin";
}
function platformOpToCanonicalCbor(op) {
  if (isSealedPlatformOp(op)) return sealedPlatformOpToCanonicalCbor(op);
  const code = OP_CODES.indexOf(op.op);
  protocolInvariant(code >= 0, "SCHEMA_INVALID", "Unknown platform operation");
  const entries = [[0, BigInt(code)]];
  switch (op.op) {
    case "grant_ddl": {
      protocolInvariant(op.scope.kind === "namespace" || op.scope.kind === "object", "SCHEMA_INVALID", "Unknown DDL scope");
      protocolInvariant(op.scope.kind !== "namespace" || op.scope.name === "main", "SCHEMA_INVALID", "Only the main namespace exists");
      protocolInvariant(isList2(op.operations) && op.operations.length > 0, "SCHEMA_INVALID", "DDL operations cannot be empty");
      uniqueBy(op.operations, (value) => value, "grant_ddl.operations");
      protocolInvariant(op.operations.every((operation) => DDL_OPERATIONS.includes(operation) && (op.scope.kind === "namespace" ? operation === "create" : operation !== "create")), "SCHEMA_INVALID", "Invalid DDL operation for scope");
      protocolInvariant(
        DDL_OPERATIONS.filter((operation) => op.operations.includes(operation)).every((operation, index) => op.operations[index] === operation),
        "SCHEMA_INVALID",
        "DDL operations must be in create, alter, drop, index, trigger order"
      );
      entries.push(
        [1, [op.scope.kind === "namespace" ? 0n : 1n, nameToCbor(op.scope.name, "grant_ddl.scope")]],
        [2, idToCbor(op.grantee, "grant_ddl.grantee")],
        [3, op.operations.map((operation) => BigInt(DDL_OPERATIONS.indexOf(operation)))]
      );
      break;
    }
    case "revoke_ddl":
      entries.push([1, idToCbor(op.grantId, "revoke_ddl.grant_id")]);
      break;
    case "grant": {
      protocolInvariant(isList2(op.operations) && op.operations.length > 0, "SCHEMA_INVALID", "grant.operations cannot be empty");
      uniqueBy(op.operations, (value) => value, "grant.operations");
      let mask = 0n;
      for (const operation of op.operations) {
        protocolInvariant(GRANT_OPERATIONS.includes(operation), "SCHEMA_INVALID", "grant.operations has an unknown operation");
        mask |= OPERATION_BITS[operation];
      }
      protocolInvariant(
        GRANT_OPERATIONS.filter((operation) => op.operations.includes(operation)).every((operation, index) => op.operations[index] === operation),
        "SCHEMA_INVALID",
        "grant.operations must be in insert, update, delete order"
      );
      if (op.columns !== void 0) uniqueBy(op.columns, (value) => value, "grant.columns");
      entries.push(
        [1, nameToCbor(op.table, "grant.table")],
        [2, idToCbor(op.grantee, "grant.grantee")],
        [3, mask],
        [4, op.grantor === void 0 ? void 0 : idToCbor(op.grantor, "grant.grantor")],
        [5, op.rowKey === void 0 ? void 0 : rowKeyToCbor(op.rowKey, "grant.row_key")],
        [6, op.columns === void 0 ? void 0 : listToCbor(op.columns, "grant.columns", (column) => nameToCbor(column, "grant.columns"), 1)]
      );
      break;
    }
    case "revoke_grant":
      entries.push([1, idToCbor(op.grantId, "revoke_grant.grant_id")]);
      break;
    case "create_collective":
      uniqueBy(op.invitees, hex, "create_collective.invitees");
      entries.push(
        [1, integerMap([
          [0, roleCode(op.governance.insert, "governance.insert")],
          [1, roleCode(op.governance.update, "governance.update")],
          [2, roleCode(op.governance.delete, "governance.delete")]
        ])],
        [2, listToCbor(op.invitees, "create_collective.invitees", (key) => idToCbor(key, "create_collective.invitees"))]
      );
      break;
    case "accept_membership":
    case "leave":
      entries.push([1, idToCbor(op.collectiveId, `${op.op}.collective_id`)]);
      break;
    case "set_members":
      uniqueBy(op.changes, (change) => hex(change.member), "set_members.changes");
      entries.push(
        [1, idToCbor(op.collectiveId, "set_members.collective_id")],
        [2, listToCbor(op.changes, "set_members.changes", (change) => [
          idToCbor(change.member, "set_members.member"),
          change.role === "remove" ? 2n : roleCode(change.role, "set_members.role")
        ], 1)]
      );
      break;
    case "transfer_offer": {
      protocolInvariant(typeof op.carry === "boolean", "SCHEMA_INVALID", "transfer_offer.carry must be a boolean");
      let scope;
      if (op.scope.kind === "all") {
        protocolInvariant(op.carry, "SCHEMA_INVALID", "A transfer of all rows always carries dependents");
        scope = [1n];
      } else {
        protocolInvariant(op.scope.kind === "row", "SCHEMA_INVALID", "transfer_offer.scope is unknown");
        scope = [0n, nameToCbor(op.scope.table, "transfer_offer.table"), rowKeyToCbor(op.scope.rowKey, "transfer_offer.row_key")];
      }
      entries.push(
        [1, scope],
        [2, op.fromOwner === void 0 ? void 0 : idToCbor(op.fromOwner, "transfer_offer.from_owner")],
        [3, idToCbor(op.toOwner, "transfer_offer.to_owner")],
        [4, op.carry ? 1n : 0n]
      );
      break;
    }
    case "transfer_accept":
    case "transfer_cancel":
      entries.push([1, idToCbor(op.offerId, `${op.op}.offer_id`)]);
      break;
    case "seed_rows": {
      uniqueBy(op.columns, (value) => value.toLowerCase(), "seed_rows.columns");
      protocolInvariant(isList2(op.rows) && op.rows.length >= 1 && op.rows.length <= MAX_SEED_ROWS, "SCHEMA_INVALID", "seed_rows.rows has an invalid number of rows");
      entries.push(
        [1, nameToCbor(op.table, "seed_rows.table")],
        [2, listToCbor(op.columns, "seed_rows.columns", (column) => nameToCbor(column, "seed_rows.columns"), 1)],
        [3, op.rows.map((row) => {
          protocolInvariant(isList2(row) && row.length === op.columns.length, "SCHEMA_INVALID", "seed_rows row width must match its columns");
          return row.map(sqlValueToCanonicalCbor);
        })]
      );
      break;
    }
    case "end_seeding":
      break;
  }
  return integerMap(entries);
}
var KNOWN_KEYS = {
  grant_ddl: [0, 1, 2, 3],
  revoke_ddl: [0, 1],
  grant: [0, 1, 2, 3, 4, 5, 6],
  revoke_grant: [0, 1],
  create_collective: [0, 1, 2],
  accept_membership: [0, 1],
  leave: [0, 1],
  set_members: [0, 1, 2],
  transfer_offer: [0, 1, 2, 3, 4],
  transfer_accept: [0, 1],
  transfer_cancel: [0, 1],
  seed_rows: [0, 1, 2, 3],
  end_seeding: [0]
};
function platformOpFromCanonicalCbor(value, name2 = "platform_op") {
  const map = expectMap(value, name2);
  const code = expectUint64(required(map, 0, `${name2}.op`), `${name2}.op`);
  if (code >= 64n) return sealedPlatformOpFromCanonicalCbor(value, name2);
  protocolInvariant(code < BigInt(OP_CODES.length), "SCHEMA_INVALID", `${name2} has an unknown operation`);
  const kind = OP_CODES[Number(code)];
  assertKnownIntegerKeys(map, KNOWN_KEYS[kind], name2);
  const text = (key, field) => expectString(required(map, key, `${name2}.${field}`), `${name2}.${field}`);
  const id2 = (key, field) => Uint8Array.from(expectBytes(required(map, key, `${name2}.${field}`), `${name2}.${field}`, PLATFORM_ID_BYTES));
  const optionalId = (key, field) => {
    const entry = optional(map, key);
    return entry === void 0 ? void 0 : Uint8Array.from(expectBytes(entry, `${name2}.${field}`, PLATFORM_ID_BYTES));
  };
  const values = (entry, field) => expectArray(entry, field).map((item, index) => sqlValueFromCanonicalCbor(item, `${field}[${index}]`));
  let op;
  switch (kind) {
    case "grant_ddl": {
      const scope = expectArray(required(map, 1, `${name2}.scope`), `${name2}.scope`);
      protocolInvariant(scope.length === 2, "SCHEMA_INVALID", "Invalid DDL scope arity");
      const scopeKind = expectUint64(scope[0] ?? null, `${name2}.scope.kind`);
      protocolInvariant(scopeKind <= 1n, "SCHEMA_INVALID", "Invalid DDL scope kind");
      const operations = expectArray(required(map, 3, `${name2}.operations`), `${name2}.operations`).map((entry) => {
        const code2 = expectUint64(entry, `${name2}.operation`);
        protocolInvariant(code2 < BigInt(DDL_OPERATIONS.length), "SCHEMA_INVALID", "Unknown DDL operation");
        return DDL_OPERATIONS[Number(code2)];
      });
      op = {
        op: kind,
        scope: { kind: scopeKind === 0n ? "namespace" : "object", name: expectString(scope[1] ?? null, `${name2}.scope.name`) },
        grantee: id2(2, "grantee"),
        operations
      };
      break;
    }
    case "revoke_ddl":
      op = { op: kind, grantId: id2(1, "grant_id") };
      break;
    case "grant": {
      const mask = expectUint64(required(map, 3, `${name2}.operations`), `${name2}.operations`);
      protocolInvariant(mask >= 1n && mask <= 7n, "SCHEMA_INVALID", `${name2}.operations is invalid`);
      const grantor = optionalId(4, "grantor");
      const key = optional(map, 5);
      const columns = optional(map, 6);
      op = {
        op: kind,
        table: text(1, "table"),
        grantee: id2(2, "grantee"),
        operations: GRANT_OPERATIONS.filter((operation) => (mask & OPERATION_BITS[operation]) !== 0n),
        ...grantor === void 0 ? {} : { grantor },
        ...key === void 0 ? {} : { rowKey: values(key, `${name2}.row_key`) },
        ...columns === void 0 ? {} : { columns: expectArray(columns, `${name2}.columns`).map((column) => expectString(column, `${name2}.columns`)) }
      };
      break;
    }
    case "revoke_grant":
      op = { op: kind, grantId: id2(1, "grant_id") };
      break;
    case "create_collective": {
      const governance = expectMap(required(map, 1, `${name2}.governance`), `${name2}.governance`);
      assertKnownIntegerKeys(governance, [0, 1, 2], `${name2}.governance`);
      op = {
        op: kind,
        governance: {
          insert: roleFromCode(required(governance, 0, "governance.insert"), "governance.insert"),
          update: roleFromCode(required(governance, 1, "governance.update"), "governance.update"),
          delete: roleFromCode(required(governance, 2, "governance.delete"), "governance.delete")
        },
        invitees: expectArray(required(map, 2, `${name2}.invitees`), `${name2}.invitees`).map((key) => Uint8Array.from(expectBytes(key, `${name2}.invitees`, PLATFORM_ID_BYTES)))
      };
      break;
    }
    case "accept_membership":
    case "leave":
      op = { op: kind, collectiveId: id2(1, "collective_id") };
      break;
    case "set_members":
      op = {
        op: kind,
        collectiveId: id2(1, "collective_id"),
        changes: expectArray(required(map, 2, `${name2}.changes`), `${name2}.changes`).map((entry) => {
          const tuple = expectArray(entry, `${name2}.change`);
          protocolInvariant(tuple.length === 2, "SCHEMA_INVALID", `${name2}.change has invalid arity`);
          const role = expectUint64(tuple[1] ?? null, `${name2}.change.role`);
          protocolInvariant(role <= 2n, "SCHEMA_INVALID", `${name2}.change.role is unknown`);
          return {
            member: Uint8Array.from(expectBytes(tuple[0] ?? null, `${name2}.change.member`, PLATFORM_ID_BYTES)),
            role: role === 0n ? "member" : role === 1n ? "admin" : "remove"
          };
        })
      };
      break;
    case "transfer_offer": {
      const scope = expectArray(required(map, 1, `${name2}.scope`), `${name2}.scope`);
      const scopeKind = expectUint64(scope[0] ?? null, `${name2}.scope.kind`);
      let decodedScope;
      if (scopeKind === 1n) {
        protocolInvariant(scope.length === 1, "SCHEMA_INVALID", `${name2}.scope has invalid arity`);
        decodedScope = { kind: "all" };
      } else {
        protocolInvariant(scopeKind === 0n && scope.length === 3, "SCHEMA_INVALID", `${name2}.scope is invalid`);
        decodedScope = {
          kind: "row",
          table: expectString(scope[1] ?? null, `${name2}.scope.table`),
          rowKey: values(scope[2] ?? null, `${name2}.scope.row_key`)
        };
      }
      const carry = expectUint64(required(map, 4, `${name2}.carry`), `${name2}.carry`);
      protocolInvariant(carry <= 1n, "SCHEMA_INVALID", `${name2}.carry must be 0 or 1`);
      const fromOwner = optionalId(2, "from_owner");
      op = {
        op: kind,
        scope: decodedScope,
        ...fromOwner === void 0 ? {} : { fromOwner },
        toOwner: id2(3, "to_owner"),
        carry: carry === 1n
      };
      break;
    }
    case "transfer_accept":
    case "transfer_cancel":
      op = { op: kind, offerId: id2(1, "offer_id") };
      break;
    case "seed_rows":
      op = {
        op: kind,
        table: text(1, "table"),
        columns: expectArray(required(map, 2, `${name2}.columns`), `${name2}.columns`).map((column) => expectString(column, `${name2}.columns`)),
        rows: expectArray(required(map, 3, `${name2}.rows`), `${name2}.rows`).map((row, index) => values(row, `${name2}.rows[${index}]`))
      };
      break;
    case "end_seeding":
      op = { op: kind };
      break;
  }
  platformOpToCanonicalCbor(op);
  return op;
}
function platformObjectIdPreimage(txId, stepIndex) {
  protocolInvariant(Number.isSafeInteger(stepIndex) && stepIndex >= 0 && stepIndex <= 4294967295, "INTEGER_OUT_OF_RANGE", "Step index is out of range");
  const index = new Uint8Array(4);
  new DataView(index.buffer).setUint32(0, stepIndex, false);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, txId.length, false);
  return concatBytes(length, txId, index);
}
function platformObjectIdHashInput(txId, stepIndex) {
  return domainSeparatedBytes("platformObject", platformObjectIdPreimage(txId, stepIndex));
}

// packages/protocol/src/program.ts
var MAX_PROGRAM_STEPS = 256;
var MAX_PROGRAM_BYTES = 262144;
var MAX_PROGRAM_EVENTS = 64;
var MAX_EVENT_BYTES = 16384;
var MAX_TOPIC_BYTES = 128;
function assertEventTopic(topic) {
  protocolInvariant(
    typeof topic === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(topic) && utf82(topic).length <= MAX_TOPIC_BYTES,
    "SCHEMA_INVALID",
    "Event topic must be a bounded application label"
  );
}
function canonicalJson(payload, limits) {
  for (const bound of [limits.maxBytes, limits.maxNodes, limits.maxDepth]) protocolInvariant(Number.isSafeInteger(bound) && bound > 0, "SCHEMA_INVALID", "Invalid JSON limits");
  let nodes = 0;
  const visit = (value, depth) => {
    protocolInvariant(depth <= limits.maxDepth && ++nodes <= limits.maxNodes, "SCHEMA_INVALID", "JSON payload is too complex");
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
      protocolInvariant(Number.isFinite(value), "SCHEMA_INVALID", "Event numbers must be finite");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      protocolInvariant(Reflect.ownKeys(value).length === value.length + 1, "SCHEMA_INVALID", "Event arrays cannot carry extra properties");
      const entries = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, i);
        protocolInvariant(
          descriptor !== void 0 && "value" in descriptor && descriptor.enumerable === true,
          "SCHEMA_INVALID",
          "Event arrays require dense data elements"
        );
        entries.push(visit(descriptor.value, depth + 1));
      }
      return `[${entries.join(",")}]`;
    }
    protocolInvariant(
      typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
      "SCHEMA_INVALID",
      "Event payload must contain JSON values"
    );
    protocolInvariant(Reflect.ownKeys(value).length === Object.keys(value).length, "SCHEMA_INVALID", "Event objects require enumerable string keys");
    return `{${Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      protocolInvariant("value" in descriptor, "SCHEMA_INVALID", "Event payload cannot contain accessors");
      return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  };
  const encoded = visit(payload, 0);
  protocolInvariant(utf82(encoded).length <= limits.maxBytes, "SCHEMA_INVALID", "JSON payload is too large");
  return encoded;
}
function canonicalEventPayload(payload) {
  return canonicalJson(payload, { maxBytes: MAX_EVENT_BYTES, maxNodes: 4096, maxDepth: 32 });
}
function emit(topic, payload) {
  assertEventTopic(topic);
  return { op: "emit", topic, payload: JSON.parse(canonicalEventPayload(payload)) };
}
function isEmitStep(step) {
  return typeof step === "object" && step !== null && "op" in step && step.op === "emit";
}
function program(...steps) {
  const result = { version: 3, steps: steps.map((step) => typeof step === "string" ? sqlStatement(step) : step) };
  assertValidChangeProgram(result);
  return result;
}
function stepToCbor(step) {
  if (isEmitStep(step)) {
    protocolInvariant(Object.keys(step).every((key) => ["op", "topic", "payload"].includes(key)), "SCHEMA_INVALID", "Unknown emit field");
    assertEventTopic(step.topic);
    return [2n, step.topic, canonicalEventPayload(step.payload)];
  }
  return isPlatformOp(step) ? [1n, platformOpToCanonicalCbor(step)] : [0n, sqlStatementToCanonicalCbor(step)];
}
function stepFromCbor(value, name2) {
  const tuple = expectArray(value, name2);
  const kind = expectUint64(tuple[0] ?? null, `${name2}.kind`);
  if (kind === 2n) {
    protocolInvariant(tuple.length === 3, "SCHEMA_INVALID", `${name2} has invalid arity`);
    const encoded = expectString(tuple[2] ?? null, `${name2}.payload`);
    protocolInvariant(utf82(encoded).length <= MAX_EVENT_BYTES, "SCHEMA_INVALID", "Event payload is too large");
    let payload;
    try {
      payload = JSON.parse(encoded);
    } catch {
      throw new Error("EVENT_PAYLOAD_INVALID");
    }
    protocolInvariant(canonicalEventPayload(payload) === encoded, "SCHEMA_INVALID", "Event payload must be canonical");
    return emit(expectString(tuple[1] ?? null, `${name2}.topic`), payload);
  }
  protocolInvariant(tuple.length === 2, "SCHEMA_INVALID", `${name2} has invalid arity`);
  if (kind === 0n) return sqlStatementFromCanonicalCbor(tuple[1] ?? null, `${name2}.statement`);
  protocolInvariant(kind === 1n, "SCHEMA_INVALID", `${name2} has an unknown kind`);
  return platformOpFromCanonicalCbor(tuple[1] ?? null, `${name2}.platform_op`);
}
function assertValidChangeProgram(value) {
  protocolInvariant(value.version === 3, "UNSUPPORTED_VERSION", "Unsupported change program version");
  protocolInvariant(
    Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= MAX_PROGRAM_STEPS,
    "SCHEMA_INVALID",
    "Change program requires a bounded nonempty step list"
  );
  protocolInvariant(value.steps.filter(isEmitStep).length <= MAX_PROGRAM_EVENTS, "SCHEMA_INVALID", "Too many emitted events");
  protocolInvariant(
    encodeCanonicalCbor(value.steps.map(stepToCbor)).length <= MAX_PROGRAM_BYTES,
    "SCHEMA_INVALID",
    "Change program is too large"
  );
}
function changeProgramToCanonicalCbor(value) {
  assertValidChangeProgram(value);
  return integerMap([[0, 3n], [1, value.steps.map(stepToCbor)]]);
}
function changeProgramFromCanonicalCbor(value) {
  const map = expectMap(value, "change_program");
  assertKnownIntegerKeys(map, [0, 1], "change_program");
  expectVersion(map, 3n, "change_program");
  const result = { version: 3, steps: expectArray(required(map, 1, "change_program.steps"), "change_program.steps").map((step, index) => stepFromCbor(step, `change_program.steps[${index}]`)) };
  assertValidChangeProgram(result);
  return result;
}
function encodeChangeProgram(value) {
  return encodeCanonicalCbor(changeProgramToCanonicalCbor(value));
}

// packages/protocol/src/primitives.ts
var DOMAINS = {
  transaction: "chronolog/transaction-core/v1",
  materializedLog: "chronolog/materialized-log/v1",
  celldApplicationInvitation: "chronolog/celld/application-invitation/v1",
  celldWorkspacePublication: "chronolog/celld/workspace-publication/v1",
  publication: "chronolog/publication/v1"
};
function domainSeparatedBytes2(domain, payload) {
  return concatBytes(utf82(domain), Uint8Array.of(0), payload);
}
async function hashDomain2(domain, payload) {
  return sha256(domainSeparatedBytes2(domain, payload));
}
var ED25519 = { name: "Ed25519" };
function bufferSource(value) {
  return Uint8Array.from(value).buffer;
}
async function generateEd25519KeyPair(extractable = true) {
  const pair = await globalThis.crypto.subtle.generateKey(ED25519, extractable, ["sign", "verify"]);
  const publicKeyBytes = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicKeyBytes };
}
async function importEd25519PublicKey(raw) {
  protocolInvariant(raw.length === 32, "INVALID_KEY", "Ed25519 public key must contain 32 bytes");
  try {
    return await globalThis.crypto.subtle.importKey("raw", bufferSource(raw), ED25519, true, ["verify"]);
  } catch {
    throw new ProtocolError("INVALID_KEY", "Unable to import Ed25519 public key");
  }
}
async function importEd25519PrivateKey(pkcs8, extractable = true) {
  try {
    return await globalThis.crypto.subtle.importKey("pkcs8", bufferSource(pkcs8), ED25519, extractable, ["sign"]);
  } catch {
    throw new ProtocolError("INVALID_KEY", "Unable to import Ed25519 private key");
  }
}
async function exportEd25519PrivateKey(privateKey) {
  try {
    return new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", privateKey));
  } catch {
    throw new ProtocolError("INVALID_KEY", "Ed25519 private key is not extractable");
  }
}

// packages/protocol/src/messages.ts
function metadataToCbor(metadata) {
  if (metadata === void 0) return void 0;
  return new Map([...metadata.entries()].map(([key, value]) => [key, value]));
}
function metadataFromCbor(value) {
  const map = expectMap(value, "transaction.metadata"), result = /* @__PURE__ */ new Map();
  for (const [key, item] of map) {
    protocolInvariant(typeof key === "string", "SCHEMA_INVALID", "Transaction metadata keys must be text");
    result.set(key, expectBytes(item, `transaction.metadata.${String(key)}`));
  }
  return result;
}
function transactionToCbor(value) {
  protocolInvariant(typeof value.operationId === "string" && value.operationId.length > 0 && value.operationId.length <= 512 && [...value.operationId].every((character) => character.charCodeAt(0) >= 32), "SCHEMA_INVALID", "Operation identity must be bounded nonempty text");
  for (const [field, bytes2] of [
    ["groupId", value.groupId],
    ["membershipRevision", value.membershipRevision],
    ["validationPolicy", value.validationPolicy],
    ["authorId", value.authorId]
  ]) protocolInvariant(bytes2.length === 32, "SCHEMA_INVALID", `${field} must contain 32 bytes`);
  protocolInvariant(value.authorTimestampMs >= 0n && value.authorTimestampMs <= (1n << 63n) - 1n, "INTEGER_OUT_OF_RANGE", "Author timestamp must be a nonnegative int64");
  protocolInvariant(value.nonce.length >= 16, "SCHEMA_INVALID", "Transaction nonce must contain at least 16 bytes");
  protocolInvariant(value.executionManifestDigest.length === 32, "SCHEMA_INVALID", "Execution-manifest digest must contain 32 bytes");
  if (value.writerCapability !== void 0) protocolInvariant(value.writerCapability.length === 32, "SCHEMA_INVALID", "Writer capability must contain 32 bytes");
  assertValidChangeProgram(value.program);
  return integerMap([
    [0, 2n],
    [1, value.groupId],
    [2, value.membershipRevision],
    [3, value.validationPolicy],
    [4, value.authorId],
    [5, value.authorTimestampMs],
    [6, value.nonce],
    [7, value.executionManifestDigest],
    [8, changeProgramToCanonicalCbor(value.program)],
    [9, metadataToCbor(value.metadata)],
    [10, value.writerCapability],
    [11, value.operationId]
  ]);
}
function encodeTransactionCore(value) {
  return encodeCanonicalCbor(transactionToCbor(value));
}
function decodeTransactionCore(bytes2) {
  const map = expectMap(assertCanonicalCbor2(bytes2), "transaction");
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "transaction");
  expectVersion(map, 2n, "transaction");
  const authorTimestampMs = expectUint64(required(map, 5, "transaction.author_timestamp_ms"), "transaction.author_timestamp_ms");
  protocolInvariant(authorTimestampMs <= (1n << 63n) - 1n, "INTEGER_OUT_OF_RANGE", "Author timestamp is outside nonnegative int64");
  const nonce = expectBytes(required(map, 6, "transaction.nonce"), "transaction.nonce");
  protocolInvariant(nonce.length >= 16, "SCHEMA_INVALID", "Transaction nonce must contain at least 16 bytes");
  const program2 = changeProgramFromCanonicalCbor(required(map, 8, "transaction.program"));
  assertValidChangeProgram(program2);
  const metadata = optional(map, 9);
  const writerCapability = optional(map, 10);
  const core = {
    operationId: expectString(required(map, 11, "transaction.operation_id"), "transaction.operation_id"),
    groupId: expectBytes(required(map, 1, "transaction.group_id"), "transaction.group_id", 32),
    membershipRevision: expectBytes(required(map, 2, "transaction.membership_revision"), "transaction.membership_revision", 32),
    validationPolicy: expectBytes(required(map, 3, "transaction.validation_policy"), "transaction.validation_policy", 32),
    authorId: expectBytes(required(map, 4, "transaction.author_id"), "transaction.author_id", 32),
    authorTimestampMs,
    nonce,
    executionManifestDigest: expectBytes(required(map, 7, "transaction.execution_manifest_digest"), "transaction.execution_manifest_digest", 32),
    program: program2,
    ...metadata === void 0 ? {} : { metadata: metadataFromCbor(metadata) },
    ...writerCapability === void 0 ? {} : { writerCapability: expectBytes(writerCapability, "transaction.writer_capability", 32) }
  };
  transactionToCbor(core);
  return core;
}
async function transactionDigest(value) {
  return hashDomain("transaction", value instanceof Uint8Array ? value : encodeTransactionCore(value));
}
function transactionOrderKey(core, txId) {
  return { authorTimestampMs: core.authorTimestampMs, authorId: core.authorId, txId };
}
function compareTransactionOrder(left, right) {
  if (left.authorTimestampMs !== right.authorTimestampMs) return left.authorTimestampMs < right.authorTimestampMs ? -1 : 1;
  const authorOrder = compareBytes(left.authorId, right.authorId);
  if (authorOrder !== 0) return authorOrder;
  return compareBytes(left.txId, right.txId);
}

// packages/protocol/src/row-key.ts
var ROW_KEY_PREFIX = "rk1:";
var MAX_ROW_KEY_PARTS = 64;
function decodeRowKey(key) {
  const fail = () => {
    throw new Error("ROW_KEY_INVALID");
  };
  if (!key.startsWith(ROW_KEY_PREFIX)) fail();
  const hex2 = key.slice(ROW_KEY_PREFIX.length);
  if (hex2.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(hex2)) fail();
  const bytes2 = Uint8Array.from(hex2.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
  const view = new DataView(bytes2.buffer);
  let offset = 0;
  const take = (length) => {
    const start = offset;
    if (length > bytes2.length - offset) fail();
    offset += length;
    return start;
  };
  const count = view.getUint16(take(2), false);
  if (count < 1 || count > MAX_ROW_KEY_PARTS) fail();
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const kind = bytes2[take(1)];
    if (kind === 0) values.push({ kind: "null" });
    else if (kind === 1) values.push({ kind: "integer", value: view.getBigInt64(take(8), false) });
    else if (kind === 2) {
      const value = view.getFloat64(take(8), false);
      if (Number.isNaN(value)) fail();
      values.push({ kind: "real", value });
    } else if (kind === 3 || kind === 4) {
      const length = view.getUint32(take(4), false);
      const start = take(length);
      values.push({ kind: kind === 3 ? "text" : "blob", value: bytes2.slice(start, start + length) });
    } else fail();
  }
  if (offset !== bytes2.length) fail();
  return values;
}

export {
  ProtocolError,
  protocolInvariant,
  utf82 as utf8,
  bytesToHex2 as bytesToHex,
  hexToBytes2 as hexToBytes,
  bytesToBase64Url,
  assertCanonicalCbor2 as assertCanonicalCbor,
  integerMap,
  sqlStatement,
  createExecutionManifest,
  executionManifestArtifacts,
  isSealedPlatformOp,
  encodeSealedEnvelope,
  GROUP_COLLECTIVE_ID,
  isPlatformOp,
  platformOp,
  platformObjectIdHashInput,
  canonicalJson,
  canonicalEventPayload,
  emit,
  isEmitStep,
  program,
  assertValidChangeProgram,
  encodeChangeProgram,
  encodeTransactionCore,
  decodeTransactionCore,
  transactionDigest,
  transactionOrderKey,
  compareTransactionOrder,
  DOMAINS,
  hashDomain2 as hashDomain,
  generateEd25519KeyPair,
  importEd25519PublicKey,
  importEd25519PrivateKey,
  exportEd25519PrivateKey,
  decodeRowKey
};
