import {
  canonicalEventPayload,
  canonicalJson,
  exportEd25519PrivateKey,
  generateEd25519KeyPair,
  importEd25519PrivateKey,
  importEd25519PublicKey
} from "./chunk-MAGRVNAE.mjs";
import {
  bytesToHex,
  hexToBytes,
  sha256
} from "./chunk-HYFY2E3E.mjs";

// packages/authority/src/codec.ts
function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function hex(value, length = 32) {
  check(typeof value === "string" && new RegExp(`^[0-9a-f]{${length * 2}}$`, "u").test(value), "AUTHORITY_HEX_INVALID");
}
function normalized(value, depth = 0) {
  check(depth < 32, "RECORD_DEPTH_LIMIT");
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  if (typeof value === "bigint") return { $integer: value.toString() };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    check(Number.isSafeInteger(value), "RECORD_INTEGER_INVALID");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalized(item, depth + 1));
  check(value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), "RECORD_INVALID");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key], depth + 1)]));
}
function encodeRecord(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(normalized(value)));
  check(bytes.length <= 32 * 1024 * 1024, "RECORD_BYTES_LIMIT");
  return bytes;
}
function decodeRecord(bytes) {
  check(bytes.length <= 32 * 1024 * 1024, "RECORD_BYTES_LIMIT");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const record = item;
      if (Object.keys(record).length === 1 && typeof record.$bytes === "string") {
        check(/^(?:[0-9a-f]{2})*$/u.test(record.$bytes), "RECORD_BYTES_INVALID");
        return hexToBytes(record.$bytes);
      }
      if (Object.keys(record).length === 1 && typeof record.$integer === "string") {
        check(/^-?(?:0|[1-9][0-9]*)$/u.test(record.$integer), "RECORD_INTEGER_INVALID");
        return BigInt(record.$integer);
      }
    }
    return item;
  });
  check(equalRecord(value, decodeUncanonical(bytes)), "RECORD_INVALID");
  check(bytesToHex(encodeRecord(value)) === bytesToHex(bytes), "RECORD_NOT_CANONICAL");
  return value;
}
function decodeUncanonical(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}
function equalRecord(a, b) {
  return bytesToHex(encodeRecord(a)) === bytesToHex(encodeRecord(b));
}
async function recordDigest(value) {
  return bytesToHex(await sha256(encodeRecord(value)));
}
function signedBytes(domain, payload) {
  return encodeRecord(["chronolog/authored/v1", domain, payload]);
}
async function signRecord(domain, payload, identity) {
  hex(identity.publicKey);
  const captured = structuredClone(payload);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign("Ed25519", identity.privateKey, Uint8Array.from(signedBytes(domain, captured)).buffer)));
  const result = { payload: captured, signer: identity.publicKey, signature };
  await verifyRecord(domain, result, identity.publicKey);
  return result;
}
async function verifyRecord(domain, signed, expectedSigner) {
  hex(signed.signer);
  hex(signed.signature, 64);
  check(expectedSigner === void 0 || signed.signer === expectedSigner, "AUTHORITY_SIGNER_MISMATCH");
  const key = await importEd25519PublicKey(hexToBytes(signed.signer));
  check(await crypto.subtle.verify("Ed25519", key, Uint8Array.from(hexToBytes(signed.signature)).buffer, Uint8Array.from(signedBytes(domain, signed.payload)).buffer), "AUTHORITY_SIGNATURE_INVALID");
}
async function createSigningIdentity() {
  const pair = await generateEd25519KeyPair();
  return { publicKey: bytesToHex(pair.publicKeyBytes), privateKey: pair.privateKey };
}
async function exportSigningIdentity(identity) {
  return { publicKey: identity.publicKey, privateKey: bytesToHex(await exportEd25519PrivateKey(identity.privateKey)) };
}
async function importSigningIdentity(value) {
  hex(value.publicKey);
  return { publicKey: value.publicKey, privateKey: await importEd25519PrivateKey(hexToBytes(value.privateKey)) };
}

// packages/authority/src/definition.ts
function isArray(value) {
  return Array.isArray(value);
}
function object(value, keys) {
  check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), "APPLICATION_DESCRIPTION_INVALID");
}
function parseApplicationInput(schema, value) {
  const copy = JSON.parse(canonicalEventPayload(value));
  const visit = (spec, item, path2) => {
    const invalid = () => {
      throw new Error(`APPLICATION_INPUT_INVALID:${path2}`);
    };
    if ("anyOf" in spec) {
      for (const option of spec.anyOf) {
        try {
          visit(option, item, path2);
          return;
        } catch {
        }
      }
      invalid();
    } else if (spec.type === "null") {
      if (item !== null) invalid();
    } else if (spec.type === "boolean") {
      if (typeof item !== "boolean") invalid();
    } else if (spec.type === "string") {
      if (typeof item !== "string") return invalid();
      const length = [...item].length;
      if (length < (spec.minLength ?? 0) || length > (spec.maxLength ?? 16384) || spec.enum !== void 0 && !spec.enum.includes(item)) invalid();
    } else if (spec.type === "number" || spec.type === "integer") {
      if (typeof item !== "number" || spec.type === "integer" && !Number.isSafeInteger(item) || item < (spec.minimum ?? -Infinity) || item > (spec.maximum ?? Infinity)) invalid();
    } else if (spec.type === "array") {
      if (!Array.isArray(item) || item.length < (spec.minItems ?? 0) || item.length > (spec.maxItems ?? 4096)) return invalid();
      const items = item;
      items.forEach((child, index) => visit(spec.items, child, `${path2}[${index}]`));
    } else if (spec.type === "object") {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return invalid();
      const object2 = item;
      for (const name of spec.required ?? []) if (!Object.hasOwn(object2, name)) invalid();
      for (const [name, child] of Object.entries(object2)) {
        if (!Object.hasOwn(spec.properties, name)) invalid();
        visit(spec.properties[name], child, `${path2}.${name}`);
      }
    }
  };
  visit(schema, copy, "$");
  return freeze(copy);
}
function checkedApplicationInputSchema(value) {
  const copy = JSON.parse(canonicalEventPayload(value));
  let nodes = 0;
  const visit = (schema, depth) => {
    if (++nodes > 256 || depth > 16 || schema === null || typeof schema !== "object" || Array.isArray(schema)) throw new Error("APPLICATION_SCHEMA_INVALID");
    const keys = /* @__PURE__ */ new Set(["description"]);
    const allow = (...names) => {
      for (const name of names) keys.add(name);
    };
    const bound = (value2, max) => {
      if (value2 !== void 0 && (!Number.isSafeInteger(value2) || value2 < 0 || value2 > max)) throw new Error("APPLICATION_SCHEMA_INVALID");
    };
    if (schema.description !== void 0 && typeof schema.description !== "string") throw new Error("APPLICATION_SCHEMA_INVALID");
    if ("anyOf" in schema) {
      allow("anyOf");
      if (!Array.isArray(schema.anyOf) || schema.anyOf.length < 1 || schema.anyOf.length > 16) throw new Error("APPLICATION_SCHEMA_INVALID");
      const alternatives = schema.anyOf;
      alternatives.forEach((option) => visit(option, depth + 1));
    } else {
      allow("type");
      switch (schema.type) {
        case "string":
          allow("minLength", "maxLength", "enum");
          bound(schema.minLength, 16384);
          bound(schema.maxLength, 16384);
          if ((schema.minLength ?? 0) > (schema.maxLength ?? 16384) || schema.enum !== void 0 && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 256 || schema.enum.some((item) => typeof item !== "string"))) throw new Error("APPLICATION_SCHEMA_INVALID");
          break;
        case "number":
        case "integer":
          allow("minimum", "maximum");
          if ([schema.minimum, schema.maximum].some((value2) => value2 !== void 0 && !Number.isFinite(value2)) || (schema.minimum ?? -Infinity) > (schema.maximum ?? Infinity)) throw new Error("APPLICATION_SCHEMA_INVALID");
          break;
        case "boolean":
        case "null":
          break;
        case "array":
          allow("items", "minItems", "maxItems");
          bound(schema.minItems, 4096);
          bound(schema.maxItems, 4096);
          if ((schema.minItems ?? 0) > (schema.maxItems ?? 4096)) throw new Error("APPLICATION_SCHEMA_INVALID");
          visit(schema.items, depth + 1);
          break;
        case "object":
          allow("properties", "required", "additionalProperties");
          if (schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties) || schema.additionalProperties !== void 0 && schema.additionalProperties !== false) throw new Error("APPLICATION_SCHEMA_INVALID");
          for (const child of Object.values(schema.properties)) visit(child, depth + 1);
          if (schema.required !== void 0 && (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string" || !Object.hasOwn(schema.properties, name)) || new Set(schema.required).size !== schema.required.length)) {
            throw new Error("APPLICATION_SCHEMA_INVALID");
          }
          Object.assign(schema, { additionalProperties: false });
          break;
        default:
          throw new Error("APPLICATION_SCHEMA_UNSUPPORTED");
      }
    }
    if (Object.keys(schema).some((key) => !keys.has(key))) throw new Error("APPLICATION_SCHEMA_UNSUPPORTED");
  };
  visit(copy, 0);
  return freeze(copy);
}
function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validateApplicationDescription(value) {
  const bytes = descriptionJson(value);
  check(new TextEncoder().encode(bytes).length <= 262144, "APPLICATION_DESCRIPTION_TOO_LARGE");
  const copy = JSON.parse(bytes);
  object(copy, ["id", "version", "commands", "queries"]);
  for (const text of [copy.id, copy.version]) check(typeof text === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(text), "APPLICATION_DEFINITION_ID_INVALID");
  for (const entries of [copy.commands, copy.queries]) {
    check(isArray(entries) && entries.length <= 128, "APPLICATION_DEFINITION_TOO_LARGE");
    let previous = "";
    for (const entry of entries) {
      object(entry, ["name", "description", "input"]);
      check(typeof entry.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(entry.name) && !["__proto__", "constructor", "prototype"].includes(entry.name) && entry.name > previous, "APPLICATION_DEFINITION_NAME_INVALID");
      previous = entry.name;
      check(typeof entry.description === "string" && entry.description.length <= 4096, "APPLICATION_DESCRIPTION_INVALID");
      const checked = checkedApplicationInputSchema(entry.input);
      check(canonicalEventPayload(entry.input) === canonicalEventPayload(checked), "APPLICATION_SCHEMA_NOT_CANONICAL");
    }
  }
  return freeze(copy);
}
async function applicationDescriptionDigest(value) {
  const description = validateApplicationDescription(value);
  return recordDigest(["application-description/v1", descriptionJson(description)]);
}
function descriptionJson(value) {
  return canonicalJson(value, { maxBytes: 262144, maxNodes: 65536, maxDepth: 32 });
}

// packages/authority/src/control.ts
function exactRecord(value, keys, code) {
  check(value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  check(Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field !== void 0 && "value" in field;
  }), code);
}
function validateFinalityPolicy(input) {
  check(input !== null && typeof input === "object", "FINALITY_POLICY_UNSUPPORTED");
  const kind = Object.getOwnPropertyDescriptor(input, "kind")?.value;
  if (kind === "none") {
    exactRecord(input, ["kind"], "FINALITY_POLICY_FIELDS_INVALID");
    return { kind: "none" };
  }
  check(kind === "fixed-validator" || kind === "signed-frontier", "FINALITY_POLICY_UNSUPPORTED");
  exactRecord(input, kind === "fixed-validator" ? ["kind", "validators", "threshold", "scopes"] : ["kind", "signer", "scopes"], "FINALITY_POLICY_FIELDS_INVALID");
  check(Array.isArray(input.scopes) && input.scopes.length > 0 && input.scopes.length <= 4096, "FINALITY_SCOPE_INVALID");
  const scopes = [], ids = /* @__PURE__ */ new Set();
  let bound = -1n;
  for (const value of input.scopes) {
    exactRecord(value, ["id", "authorTimeAfterMs"], "FINALITY_SCOPE_INVALID");
    hex(value.id);
    check(typeof value.authorTimeAfterMs === "bigint" && value.authorTimeAfterMs >= bound && value.authorTimeAfterMs <= (1n << 63n) - 1n && (scopes.length > 0 || value.authorTimeAfterMs === -1n) && !ids.has(value.id), "FINALITY_SCOPE_INVALID");
    scopes.push({ id: value.id, authorTimeAfterMs: value.authorTimeAfterMs });
    ids.add(value.id);
    bound = value.authorTimeAfterMs;
  }
  if (kind === "signed-frontier") {
    hex(input.signer);
    return { kind, signer: input.signer, scopes };
  }
  check(Array.isArray(input.validators) && input.validators.length > 0 && input.validators.length <= 4096, "FINALITY_VALIDATORS_INVALID");
  const validators = [];
  for (const key of input.validators) {
    hex(key);
    validators.push(key);
  }
  check(new Set(validators).size === validators.length && typeof input.threshold === "number" && Number.isSafeInteger(input.threshold) && input.threshold > 0 && input.threshold <= validators.length, "FINALITY_VALIDATORS_INVALID");
  return { kind, validators, threshold: input.threshold, scopes };
}
function validateDescriptor(value) {
  exactRecord(value, ["applicationId", "rootPrincipal", "authorityPublicKey", "executionManifestDigest", "finalityPolicy"], "AUTHORITY_DESCRIPTOR_FIELDS_INVALID");
  hex(value.applicationId);
  hex(value.rootPrincipal);
  hex(value.authorityPublicKey);
  hex(value.executionManifestDigest);
  validateFinalityPolicy(value.finalityPolicy);
}
async function signAppDescriptor(descriptor, signer) {
  validateDescriptor(descriptor);
  check(signer.publicKey === descriptor.authorityPublicKey, "AUTHORITY_SIGNER_MISMATCH");
  return signRecord("descriptor", descriptor, signer);
}
async function signMembership(membership, signer) {
  return signRecord("membership", membership, signer);
}
async function verifyAuthorityBundle(input, pinned) {
  const bundle = structuredClone(input), descriptor = bundle.descriptor.payload;
  validateDescriptor(descriptor);
  await verifyRecord("descriptor", bundle.descriptor, descriptor.authorityPublicKey);
  check(pinned === void 0 || equalRecord(pinned, bundle.descriptor), "AUTHORITY_DESCRIPTOR_MISMATCH");
  check(bundle.memberships.length > 0 && bundle.memberships.length <= 4096, "AUTHORITY_MEMBERSHIP_LIMIT");
  let previous = null;
  for (const [revision, signed] of bundle.memberships.entries()) {
    const value = signed.payload;
    check(value.applicationId === descriptor.applicationId && value.revision === revision && value.previous === previous && Number.isSafeInteger(value.epoch) && value.epoch >= 0, "AUTHORITY_CHAIN_INVALID");
    hex(value.epochKeyDigest);
    const priorEpoch = bundle.memberships.slice(0, revision).find((item) => item.payload.epoch === value.epoch);
    check(priorEpoch === void 0 || priorEpoch.payload.epochKeyDigest === value.epochKeyDigest, "AUTHORITY_EPOCH_COMMITMENT_CHANGED");
    check(typeof value.authorTimeAfterMs === "bigint" && (revision === 0 ? value.authorTimeAfterMs === -1n : value.authorTimeAfterMs > bundle.memberships[revision - 1].payload.authorTimeAfterMs), "AUTHORITY_ACTIVATION_INVALID");
    check(value.members.length <= 4096 && new Set(value.members.map((member) => member.publicKey)).size === value.members.length, "AUTHORITY_MEMBERS_INVALID");
    for (const member of value.members) {
      hex(member.publicKey);
      for (const flag of [member.reader, member.writer, member.publisher, member.administrator, member.finalizer]) check(typeof flag === "boolean", "AUTHORITY_MEMBERS_INVALID");
    }
    if (revision === 0) check(value.members.some((member) => member.publicKey === descriptor.rootPrincipal), "AUTHORITY_ROOT_MISSING");
    if (signed.signer !== descriptor.authorityPublicKey) check(bundle.memberships[revision - 1]?.payload.members.some((member) => member.publicKey === signed.signer && member.administrator), "AUTHORITY_ADMIN_REQUIRED");
    await verifyRecord("membership", signed);
    previous = await recordDigest(signed);
  }
}
function writerAuthorizedAt(authority, publicKey, membershipId, authorTimestampMs, throughRevision = Number.MAX_SAFE_INTEGER) {
  const base = authority.membership(membershipId);
  if (base === null) return null;
  if (authorTimestampMs <= base.authorTimeAfterMs || base.members.find((member) => member.publicKey === publicKey)?.writer !== true) return false;
  for (const successor of authority.bundle().memberships.slice(base.revision + 1)) {
    if (successor.payload.revision > throughRevision || authorTimestampMs <= successor.payload.authorTimeAfterMs) break;
    if (successor.payload.members.find((member) => member.publicKey === publicKey)?.writer !== true) return false;
  }
  return true;
}
function finalizerAuthorizedAt(authority, publicKey, authorityHead, throughMs) {
  const head = authority.membership(authorityHead);
  if (head === null) return null;
  if (head.members.find((member) => member.publicKey === publicKey)?.finalizer !== true) return false;
  for (const successor of authority.bundle().memberships.slice(head.revision + 1)) {
    if (throughMs <= successor.payload.authorTimeAfterMs) break;
    if (successor.payload.members.find((member) => member.publicKey === publicKey)?.finalizer !== true) return false;
  }
  return true;
}
async function epochKeyCommitment(applicationId, epoch, key) {
  hex(applicationId);
  check(Number.isSafeInteger(epoch) && epoch >= 0 && key.length === 32, "AUTHORITY_EPOCH_KEY_INVALID");
  return recordDigest(["epoch-key", applicationId, epoch, key]);
}
var owners = /* @__PURE__ */ new WeakSet();
async function createAuthorityProvider(options) {
  check(!owners.has(options.store), "AUTHORITY_STORE_BUSY");
  owners.add(options.store);
  try {
    const applicationId = options.bundle?.descriptor.payload.applicationId ?? options.applicationId;
    hex(applicationId);
    const key = `authority/${applicationId}`, cached = await options.store.get(key);
    let bundle = cached === null ? options.bundle : decodeRecord(cached);
    check(bundle !== void 0, "AUTHORITY_CACHE_MISSING");
    await verifyAuthorityBundle(bundle);
    if (options.bundle !== void 0 && cached !== null) {
      await verifyAuthorityBundle(options.bundle, bundle.descriptor);
      for (let i = 0; i < Math.min(bundle.memberships.length, options.bundle.memberships.length); i++) check(equalRecord(bundle.memberships[i], options.bundle.memberships[i]), "AUTHORITY_CHAIN_FORK");
      if (options.bundle.memberships.length > bundle.memberships.length) bundle = structuredClone(options.bundle);
    }
    await options.store.put(key, encodeRecord(bundle));
    const keys = /* @__PURE__ */ new Map(), listeners = /* @__PURE__ */ new Set();
    const keyBytes = await options.store.get(`${key}/epoch-keys`);
    if (keyBytes !== null) for (const [epoch, bytes] of decodeRecord(keyBytes)) keys.set(epoch, bytes);
    const validateKey = async (epoch, bytes) => {
      check(bytes instanceof Uint8Array && bytes.length === 32 && Number.isSafeInteger(epoch) && epoch >= 0, "AUTHORITY_EPOCH_KEY_INVALID");
      const membership = bundle.memberships.find((item) => item.payload.epoch === epoch);
      check(membership !== void 0 && membership.payload.epochKeyDigest === await epochKeyCommitment(applicationId, epoch, bytes), "AUTHORITY_EPOCH_KEY_COMMITMENT_MISMATCH");
    };
    for (const [epoch, bytes] of keys) await validateKey(epoch, bytes);
    const persistKeys = async () => {
      await options.store.put(`${key}/epoch-keys`, encodeRecord([...keys]));
    };
    for (const [epoch, bytes] of options.epochKeys ?? []) {
      await validateKey(epoch, bytes);
      check(!keys.has(epoch) || equalRecord(keys.get(epoch), bytes), "AUTHORITY_EPOCH_KEY_CONFLICT");
      keys.set(epoch, bytes.slice());
    }
    if (options.epochKeys !== void 0) await persistKeys();
    const ids = /* @__PURE__ */ new Map();
    const index = async () => {
      ids.clear();
      for (const signed of bundle.memberships) ids.set(await recordDigest(signed), signed.payload);
    };
    await index();
    if (cached === null) await options.store.put(key, encodeRecord(bundle));
    let tail = Promise.resolve();
    const provider = {
      get descriptor() {
        return structuredClone(bundle.descriptor.payload);
      },
      descriptorId: await recordDigest(bundle.descriptor),
      get currentMembershipId() {
        return [...ids.keys()].at(-1);
      },
      get currentMembership() {
        return structuredClone(bundle.memberships.at(-1).payload);
      },
      bundle: () => structuredClone(bundle),
      grant: (publicKey, id) => structuredClone((id === void 0 ? bundle.memberships.at(-1).payload : ids.get(id))?.members.find((member) => member.publicKey === publicKey) ?? null),
      hasMembership: (id) => ids.has(id),
      membership: (id) => structuredClone(ids.get(id) ?? null),
      epochKey: (epoch) => keys.get(epoch)?.slice() ?? null,
      installEpochKey(epoch, input) {
        const bytes = input.slice();
        const task = tail.then(async () => {
          await validateKey(epoch, bytes);
          check(!keys.has(epoch) || equalRecord(keys.get(epoch), bytes), "AUTHORITY_EPOCH_KEY_CONFLICT");
          const next = new Map(keys);
          next.set(epoch, bytes);
          await options.store.put(`${key}/epoch-keys`, encodeRecord([...next]));
          keys.set(epoch, bytes);
          for (const listener of listeners) {
            try {
              listener();
            } catch {
            }
          }
        });
        tail = task.catch(() => void 0);
        return task;
      },
      merge(input) {
        const captured = structuredClone(input);
        const task = tail.then(async () => {
          await verifyAuthorityBundle(captured, bundle.descriptor);
          for (let i = 0; i < Math.min(captured.memberships.length, bundle.memberships.length); i++) check(equalRecord(captured.memberships[i], bundle.memberships[i]), "AUTHORITY_CHAIN_FORK");
          if (captured.memberships.length <= bundle.memberships.length) return;
          await options.store.put(key, encodeRecord(captured));
          bundle = captured;
          await index();
          for (const listener of listeners) {
            try {
              listener();
            } catch {
            }
          }
        });
        tail = task.catch(() => void 0);
        return task;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    };
    if (options.bundle !== void 0 && cached !== null) await provider.merge(options.bundle);
    return provider;
  } finally {
    owners.delete(options.store);
  }
}
async function signEnrollmentRequest(request, identity) {
  hex(request.applicationId);
  hex(request.publicKey);
  hex(request.epochKeyDigest);
  check(Number.isSafeInteger(request.epoch) && request.epoch >= 0, "ENROLLMENT_EPOCH_INVALID");
  check(request.publicKey === identity.publicKey && request.challenge.length > 0 && request.challenge.length <= 512, "ENROLLMENT_REQUEST_INVALID");
  return signRecord("enrollment", request, identity);
}
async function verifyEnrollmentRequest(request) {
  hex(request.payload.applicationId);
  hex(request.payload.publicKey);
  hex(request.payload.epochKeyDigest);
  check(Number.isSafeInteger(request.payload.epoch) && request.payload.epoch >= 0, "ENROLLMENT_EPOCH_INVALID");
  check(typeof request.payload.challenge === "string" && request.payload.challenge.length > 0 && request.payload.challenge.length <= 512, "ENROLLMENT_REQUEST_INVALID");
  await verifyRecord("enrollment", request, request.payload.publicKey);
}

// packages/authority/src/finality.ts
var isArray2 = (value) => Array.isArray(value);
async function finalityPolicyDigest(policy) {
  return recordDigest(["finality-policy", policy]);
}
async function signFinalityStatement(statement, signer) {
  return signRecord("finality", statement, signer);
}
async function finalityAdmissionScopes(authority) {
  const policy = authority.descriptor.finalityPolicy;
  if (policy.kind === "none") return [];
  const scopes = new Map(policy.scopes.map((scope) => [scope.id, scope]));
  for (const membership of authority.bundle().memberships) {
    const id = await recordDigest(membership);
    check(!scopes.has(id), "FINALITY_SCOPE_COLLISION");
    scopes.set(id, { id, authorTimeAfterMs: membership.payload.authorTimeAfterMs });
  }
  return [...scopes.values()];
}
async function mergeFinalityProofs(...histories) {
  const statements = /* @__PURE__ */ new Map();
  for (const history of histories) for (const input of history) {
    const proof = structuredClone(input), id = await recordDigest(proof.statement);
    check(proof.signatures.length <= 4096, "FINALITY_SIGNATURE_LIMIT");
    let entry = statements.get(id);
    if (entry === void 0) {
      entry = { statement: proof.statement, signatures: /* @__PURE__ */ new Map() };
      statements.set(id, entry);
    }
    for (const signature of proof.signatures) {
      check(equalRecord(signature.payload, proof.statement), "FINALITY_SIGNATURE_SCOPE");
      await verifyRecord("finality", signature);
      const prior = entry.signatures.get(signature.signer);
      if (prior === void 0 || signature.signature < prior.signature) entry.signatures.set(signature.signer, signature);
    }
  }
  check(statements.size <= 65536, "FINALITY_PROOF_LIMIT");
  return [...statements.values()].map((entry) => ({ statement: entry.statement, signatures: [...entry.signatures.values()].sort((a, b) => a.signer.localeCompare(b.signer)) })).sort((a, b) => a.statement.scope.localeCompare(b.statement.scope) || a.statement.sequence - b.statement.sequence);
}
async function verifyFinalityProofs(descriptor, input, authority, knownProposals = []) {
  const policy = descriptor.finalityPolicy;
  if (policy.kind === "none") {
    check(input.length === 0, "FINALITY_UNSUPPORTED");
    return { closedThroughMs: null, included: /* @__PURE__ */ new Map(), excludedProposalIds: /* @__PURE__ */ new Set(), proofs: [] };
  }
  check(authority !== void 0, "FINALITY_AUTHORITY_REQUIRED");
  check(equalRecord(descriptor, authority.descriptor), "FINALITY_AUTHORITY_SCOPE_MISMATCH");
  const proofs = await mergeFinalityProofs(input), scopes = await finalityAdmissionScopes(authority), policyDigest = await finalityPolicyDigest(policy);
  const allowed = policy.kind === "signed-frontier" ? [policy.signer] : policy.validators, threshold = policy.kind === "signed-frontier" ? 1 : policy.threshold;
  const heads = /* @__PURE__ */ new Map(), first = /* @__PURE__ */ new Map();
  const candidates = /* @__PURE__ */ new Map(), dependencies = /* @__PURE__ */ new Set(), verifiedProofs = [];
  const candidate = (value) => {
    hex(value.proposalId);
    hex(value.membershipId);
    hex(value.author);
    check(typeof value.authorTimestampMs === "bigint" && value.authorTimestampMs >= 0n && value.authorTimestampMs <= (1n << 63n) - 1n, "FINALITY_INCLUSION_INVALID");
    const prior = candidates.get(value.proposalId);
    check(prior === void 0 || prior.authorTimestampMs === value.authorTimestampMs && prior.membershipId === value.membershipId && prior.author === value.author, "FINALITY_INCLUSION_CONFLICT");
    candidates.set(value.proposalId, value);
  };
  for (const value of knownProposals) candidate(value);
  for (const proof of proofs) {
    const statement = proof.statement, scope = scopes.find((item) => item.id === statement.scope), head = heads.get(statement.scope);
    hex(statement.scope);
    hex(statement.authorityHead);
    check(statement.applicationId === descriptor.applicationId && statement.policyDigest === policyDigest, "FINALITY_SCOPE_MISMATCH");
    check(Number.isSafeInteger(statement.sequence) && statement.sequence >= 0 && typeof statement.closedThroughMs === "bigint" && statement.closedThroughMs >= -1n && statement.closedThroughMs <= (1n << 63n) - 1n && isArray2(statement.inclusions) && isArray2(statement.blockers) && statement.inclusions.length <= 65536 && statement.blockers.length <= 65536, "FINALITY_STATEMENT_INVALID");
    check(proof.signatures.length <= allowed.length, "FINALITY_SIGNATURE_LIMIT");
    for (const signature of proof.signatures) check(allowed.includes(signature.signer), "FINALITY_SIGNATURE_SCOPE");
    const headMembership = authority.membership(statement.authorityHead);
    if (headMembership === null) {
      dependencies.add(`authority/${statement.authorityHead}`);
      continue;
    }
    const eligible = proof.signatures.filter((signature) => finalizerAuthorizedAt(authority, signature.signer, statement.authorityHead, statement.closedThroughMs) === true);
    if (eligible.length < threshold) {
      dependencies.add(`quorum/${await recordDigest(statement)}`);
      continue;
    }
    check(scope !== void 0, "FINALITY_SCOPE_MISMATCH");
    {
      const membership = authority.membership(statement.scope);
      check(membership === null || membership.revision <= headMembership.revision, "FINALITY_SCOPE_NOT_ACTIVE");
    }
    if (statement.sequence > (head?.sequence ?? -1) + 1) {
      dependencies.add(`history/${statement.scope}/${(head?.sequence ?? -1) + 1}`);
      continue;
    }
    check(statement.sequence === (head?.sequence ?? -1) + 1 && statement.previous === (head?.id ?? null), "FINALITY_HISTORY_FORK");
    check(statement.closedThroughMs >= (head?.closed ?? scope.authorTimeAfterMs), "FINALITY_CLOSURE_INVALID");
    for (const blocker of statement.blockers) {
      candidate(blocker);
      check(statement.closedThroughMs < blocker.authorTimestampMs, "FINALITY_BLOCKER_NOT_RESPECTED");
    }
    const scopedFirst = first.get(statement.scope) ?? /* @__PURE__ */ new Map();
    first.set(statement.scope, scopedFirst);
    for (const inclusion of statement.inclusions) {
      candidate(inclusion);
      check(inclusion.authorTimestampMs > scope.authorTimeAfterMs, "FINALITY_INCLUSION_INVALID");
      {
        const membership = authority.membership(inclusion.membershipId);
        check(membership !== null && membership.revision <= headMembership.revision && writerAuthorizedAt(authority, inclusion.author, inclusion.membershipId, inclusion.authorTimestampMs, headMembership.revision) === true, "FINALITY_INCLUSION_SCOPE_INVALID");
        check(!authority.hasMembership(statement.scope) || statement.scope === inclusion.membershipId, "FINALITY_INCLUSION_SCOPE_INVALID");
      }
      check(!scopedFirst.has(inclusion.proposalId), "FINALITY_FIRST_INCLUSION_REPEATED");
      scopedFirst.set(inclusion.proposalId, { inclusion, late: inclusion.authorTimestampMs <= (head?.closed ?? scope.authorTimeAfterMs) });
    }
    heads.set(statement.scope, { sequence: statement.sequence, id: await recordDigest(statement), closed: statement.closedThroughMs });
    verifiedProofs.push(proof);
  }
  const memberships = authority.bundle().memberships, membershipIds = await Promise.all(memberships.map((membership) => recordDigest(membership)));
  for (let index = 1; index < memberships.length; index++) {
    const priorScopes = [...policy.scopes, ...memberships.slice(0, index).map((membership, position) => ({ id: membershipIds[position], authorTimeAfterMs: membership.payload.authorTimeAfterMs }))];
    let sealed = (1n << 63n) - 1n;
    for (const scope of priorScopes) {
      const prior = verifiedProofs.filter((proof) => proof.statement.scope === scope.id && (authority.membership(proof.statement.authorityHead)?.revision ?? Infinity) < index).at(-1)?.statement, cutoff = prior?.closedThroughMs ?? scope.authorTimeAfterMs;
      if (cutoff < sealed) sealed = cutoff;
    }
    check(memberships[index].payload.authorTimeAfterMs >= sealed, "FINALITY_MEMBERSHIP_BEHIND_SEAL");
  }
  const included = /* @__PURE__ */ new Map(), excluded = /* @__PURE__ */ new Set();
  for (const value of candidates.values()) {
    const applicable = policy.scopes.filter((scope) => value.authorTimestampMs > scope.authorTimeAfterMs).map((scope) => scope.id);
    {
      if (writerAuthorizedAt(authority, value.author, value.membershipId, value.authorTimestampMs) === false) excluded.add(value.proposalId);
      applicable.push(value.membershipId);
    }
    let complete = applicable.length > 0;
    for (const id of applicable) {
      const admission = first.get(id)?.get(value.proposalId), closed = heads.get(id)?.closed;
      if (admission?.late === true || admission === void 0 && closed !== void 0 && value.authorTimestampMs <= closed) excluded.add(value.proposalId);
      if (admission === void 0 || admission.late) complete = false;
    }
    if (complete && !excluded.has(value.proposalId)) included.set(value.proposalId, value);
  }
  let closedThroughMs = null;
  for (const scope of scopes) {
    const cutoff = heads.get(scope.id)?.closed ?? scope.authorTimeAfterMs;
    if (closedThroughMs === null || cutoff < closedThroughMs) closedThroughMs = cutoff;
  }
  if (closedThroughMs !== null && closedThroughMs < 0n) closedThroughMs = null;
  return { closedThroughMs, included, excludedProposalIds: excluded, proofs, certifiedProofs: verifiedProofs, pendingDependencies: [...dependencies].sort() };
}

// packages/authority/src/publication.ts
var PUBLICATION_LIMITS = Object.freeze({ files: 128, bytes: 8 * 1024 * 1024, manifestBytes: 256 * 1024, revisions: 4096 });
function path(value) {
  check(typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\\?#%]/u.test(value) && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."), "PUBLICATION_PATH_INVALID");
}
function validatePublicationManifest(value) {
  hex(value.applicationId);
  hex(value.membershipId);
  hex(value.author);
  hex(value.executionManifestDigest);
  check(typeof value.operationId === "string" && value.operationId.length > 0 && value.operationId.length <= 512 && Number.isSafeInteger(value.revision) && value.revision >= 0, "PUBLICATION_INVALID");
  if (value.previous !== null) hex(value.previous);
  check(value.previous === null === (value.revision === 0), "PUBLICATION_CHAIN_INVALID");
  path(value.entry);
  check(value.files.length > 0 && value.files.length <= PUBLICATION_LIMITS.files, "PUBLICATION_FILES_LIMIT");
  let previous = "", total = 0;
  for (const file of value.files) {
    path(file.path);
    hex(file.hash);
    check(file.path > previous && Number.isSafeInteger(file.size) && file.size >= 0 && typeof file.type === "string" && /^[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[ -~]*)?$/iu.test(file.type), "PUBLICATION_FILE_INVALID");
    previous = file.path;
    total += file.size;
  }
  check(total <= PUBLICATION_LIMITS.bytes && value.files.some((file) => file.path === value.entry) && encodeRecord(value).length <= PUBLICATION_LIMITS.manifestBytes, "PUBLICATION_BYTES_LIMIT");
  return structuredClone(value);
}
async function signPublicationManifest(value, identity) {
  const payload = validatePublicationManifest(value);
  check(payload.author === identity.publicKey, "PUBLICATION_SIGNER_MISMATCH");
  const signed = await signRecord("publication", payload, identity);
  return { ...signed, id: await recordDigest(["publication", payload]) };
}
function publicationScope(authority) {
  if ("descriptor" in authority) return { applicationId: authority.descriptor.applicationId, executionManifestDigest: authority.descriptor.executionManifestDigest, grantId: authority.currentMembershipId, publisherKeys: authority.currentMembership.members.filter((member) => member.publisher).map((member) => member.publicKey) };
  return authority;
}
async function verifyPublicationManifest(value, authority) {
  const payload = validatePublicationManifest(value.payload), scope = publicationScope(authority);
  check(payload.applicationId === scope.applicationId && payload.executionManifestDigest === scope.executionManifestDigest, "PUBLICATION_SCOPE_MISMATCH");
  check("descriptor" in authority ? authority.grant(payload.author, payload.membershipId)?.publisher : scope.grantId === payload.membershipId && scope.publisherKeys.includes(payload.author), "PUBLICATION_PUBLISHER_REQUIRED");
  check(value.id === await recordDigest(["publication", payload]), "PUBLICATION_ID_INVALID");
  await verifyRecord("publication", value, payload.author);
}
async function authorizePublication(value, authority, previous) {
  await verifyPublicationManifest(value, authority);
  const scope = publicationScope(authority);
  check(value.payload.membershipId === scope.grantId && scope.publisherKeys.includes(value.payload.author), "PUBLICATION_AUTHORITY_CHANGED");
  check(value.payload.previous === (previous?.id ?? null) && value.payload.revision === (previous === null ? 0 : previous.payload.revision + 1), "PUBLICATION_CONFLICT");
}
async function verifyPublicationAsset(file, bytes) {
  path(file.path);
  hex(file.hash);
  const { sha256: sha2562, bytesToHex: bytesToHex2 } = await import("./src-WSE7JXXZ.mjs");
  check(bytes.length === file.size && bytesToHex2(await sha2562(bytes)) === file.hash, "PUBLICATION_ASSET_MISMATCH");
}
async function createPublicationRegistry(options) {
  const key = `authority/${options.authority.descriptor.applicationId}/publications`;
  let tail = Promise.resolve();
  const read = async () => {
    const bytes = await options.store.get(key), values = bytes === null ? [] : decodeRecord(bytes);
    check(values.length <= PUBLICATION_LIMITS.revisions, "PUBLICATION_HISTORY_LIMIT");
    for (const [i, value] of values.entries()) {
      await verifyPublicationManifest(value, options.authority);
      check(value.payload.revision === i && value.payload.previous === (values[i - 1]?.id ?? null), "PUBLICATION_CHAIN_INVALID");
    }
    return values;
  };
  return { read, publish(input) {
    const value = structuredClone(input);
    const task = tail.then(async () => {
      const values = await read(), retry = values.find((item) => item.payload.operationId === value.payload.operationId);
      if (retry !== void 0) {
        check(equalRecord(retry, value), "PUBLICATION_OPERATION_REUSED");
        return retry;
      }
      await authorizePublication(value, options.authority, values.at(-1) ?? null);
      check(values.length < PUBLICATION_LIMITS.revisions, "PUBLICATION_HISTORY_LIMIT");
      await options.store.put(key, encodeRecord([...values, value]));
      return structuredClone(value);
    });
    tail = task.catch(() => void 0);
    return task;
  } };
}

// packages/authority/src/participant.ts
async function signParticipantRequest(value, identity) {
  return signRecord("participant-request", value, identity);
}
function createAuthorityParticipant(options) {
  return { async handle(request) {
    await verifyRecord("participant-request", request);
    const value = request.payload, grant = options.authority.grant(request.signer);
    check(value.applicationId === options.authority.descriptor.applicationId && typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 128 && grant !== null, "PARTICIPANT_FORBIDDEN");
    switch (value.action) {
      case "authority.read":
        return { requestId: value.requestId, authority: options.authority.bundle() };
      case "publication.read":
        return { requestId: value.requestId, publications: await options.publications.read() };
      case "publication.publish":
        check(grant.publisher && value.publication !== void 0 && value.publication.signer === request.signer, "PARTICIPANT_PUBLISHER_REQUIRED");
        await options.publications.publish(value.publication);
        return { requestId: value.requestId };
      case "finality.read":
        check(options.finality !== void 0, "FINALITY_UNSUPPORTED");
        return { requestId: value.requestId, proofs: await options.finality.read() };
      case "finality.publish":
        check(grant.finalizer && options.finality !== void 0 && value.proof !== void 0, "PARTICIPANT_FINALIZER_REQUIRED");
        await options.finality.publish(value.proof);
        return { requestId: value.requestId };
      default:
        throw new Error("PARTICIPANT_ACTION_UNSUPPORTED");
    }
  } };
}

export {
  check,
  hex,
  encodeRecord,
  decodeRecord,
  equalRecord,
  recordDigest,
  signRecord,
  verifyRecord,
  createSigningIdentity,
  exportSigningIdentity,
  importSigningIdentity,
  parseApplicationInput,
  checkedApplicationInputSchema,
  validateApplicationDescription,
  applicationDescriptionDigest,
  validateFinalityPolicy,
  validateDescriptor,
  signAppDescriptor,
  signMembership,
  verifyAuthorityBundle,
  writerAuthorizedAt,
  finalizerAuthorizedAt,
  epochKeyCommitment,
  createAuthorityProvider,
  signEnrollmentRequest,
  verifyEnrollmentRequest,
  finalityPolicyDigest,
  signFinalityStatement,
  finalityAdmissionScopes,
  mergeFinalityProofs,
  verifyFinalityProofs,
  PUBLICATION_LIMITS,
  validatePublicationManifest,
  signPublicationManifest,
  verifyPublicationManifest,
  authorizePublication,
  verifyPublicationAsset,
  createPublicationRegistry,
  signParticipantRequest,
  createAuthorityParticipant
};
