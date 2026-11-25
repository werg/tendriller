import {
  ApplicationContent,
  SignalChannel,
  decryptEpochPayload,
  encryptEpochPayload,
  exportX25519PrivateKey,
  generateX25519KeyPair,
  hpkeOpenBase,
  hpkeSealBase,
  importX25519PrivateKey
} from "./chunk-MNRPZTZP.mjs";
import {
  createEventMaterializationRuntime
} from "./chunk-JQFYN2T4.mjs";
import "./chunk-7JXKVFZF.mjs";
import {
  claimApplicationDevice
} from "./chunk-J4G5U5FU.mjs";
import "./chunk-GEKQN4CD.mjs";
import {
  check,
  createAuthorityProvider,
  decodeRecord,
  encodeRecord,
  finalityAdmissionScopes,
  finalityPolicyDigest,
  mergeFinalityProofs,
  recordDigest,
  signFinalityStatement,
  signRecord,
  verifyFinalityProofs,
  verifyRecord,
  writerAuthorizedAt
} from "./chunk-CZMLHZUQ.mjs";
import {
  awaitOwnedTask
} from "./chunk-KSC4KBWO.mjs";
import "./chunk-MCU2YKH4.mjs";
import {
  compareTransactionOrder,
  decodeTransactionCore,
  encodeChangeProgram,
  encodeTransactionCore,
  isEmitStep,
  transactionDigest,
  transactionOrderKey
} from "./chunk-MAGRVNAE.mjs";
import {
  bytesToHex,
  hexToBytes
} from "./chunk-HYFY2E3E.mjs";

// packages/peer-session/src/provisioning.ts
function createApplicationProvisioning(options) {
  const { authority, identity, store } = options, prefix = `provisioning/${authority.descriptor.applicationId}`;
  const context = (request) => encodeRecord(["provisioning", request]);
  let tail = Promise.resolve();
  const serial = (work) => {
    const task = tail.then(work);
    tail = task.catch(() => void 0);
    return task;
  };
  return {
    createProvisioningRequest: () => serial(async () => {
      const indexRaw = await store.get(`${prefix}/requests`), ids = indexRaw === null ? [] : decodeRecord(indexRaw);
      check(ids.length < 8, "PROVISIONING_REQUEST_LIMIT");
      const pair = await generateX25519KeyPair(), requestId = crypto.randomUUID();
      const request = await signRecord("provisioning-request", { applicationId: authority.descriptor.applicationId, descriptorId: authority.descriptorId, requestId, recipient: identity.publicKey, agreementPublicKey: bytesToHex(pair.publicKeyBytes) }, identity);
      await store.put(`${prefix}/${requestId}`, encodeRecord({ request, privateKey: await exportX25519PrivateKey(pair.privateKey) }));
      await store.put(`${prefix}/requests`, encodeRecord([...ids, requestId]));
      return request;
    }),
    exportProvisioning: (request) => serial(async () => {
      await verifyRecord("provisioning-request", request, request.payload.recipient);
      check(request.payload.applicationId === authority.descriptor.applicationId && request.payload.descriptorId === authority.descriptorId && authority.grant(request.payload.recipient)?.reader && authority.grant(identity.publicKey)?.reader && /^[0-9a-f]{64}$/u.test(request.payload.agreementPublicKey), "PROVISIONING_SCOPE_INVALID");
      const epochs = [...new Set(authority.bundle().memberships.map((item) => item.payload.epoch))];
      const keys = epochs.map((epoch) => {
        const key = authority.epochKey(epoch);
        check(key !== null, "PROVISIONING_SENDER_KEY_MISSING");
        return [epoch, key];
      });
      const encrypted = await hpkeSealBase(hexToBytes(request.payload.agreementPublicKey), encodeRecord(keys), context(request), context(request));
      return signRecord("provisioning-package", { request, authority: authority.bundle(), encrypted }, identity);
    }),
    importProvisioning: (value) => serial(async () => {
      await verifyRecord("provisioning-package", value);
      const request = value.payload.request;
      await verifyRecord("provisioning-request", request, identity.publicKey);
      check(request.payload.recipient === identity.publicKey && request.payload.applicationId === authority.descriptor.applicationId && request.payload.descriptorId === authority.descriptorId && /^[0-9a-f-]{36}$/u.test(request.payload.requestId), "PROVISIONING_RECIPIENT_MISMATCH");
      const raw = await store.get(`${prefix}/${request.payload.requestId}`);
      check(raw !== null, "PROVISIONING_REQUEST_MISSING");
      const saved = decodeRecord(raw);
      check(await recordDigest(saved.request) === await recordDigest(request), "PROVISIONING_REQUEST_MISMATCH");
      await authority.merge(value.payload.authority);
      check(authority.grant(value.signer)?.reader && authority.grant(identity.publicKey)?.reader, "PROVISIONING_READER_REQUIRED");
      const rawKeys = decodeRecord(await hpkeOpenBase(await importX25519PrivateKey(saved.privateKey, false), hexToBytes(request.payload.agreementPublicKey), value.payload.encrypted.encapsulatedKey, value.payload.encrypted.ciphertext, context(request), context(request)));
      check(Array.isArray(rawKeys) && rawKeys.length <= 4096, "PROVISIONING_KEYS_INVALID");
      const values = rawKeys, seen = /* @__PURE__ */ new Set();
      for (const item of values) {
        check(Array.isArray(item) && item.length === 2, "PROVISIONING_KEYS_INVALID");
        const entry = item, epoch = entry[0], key = entry[1];
        check(typeof epoch === "number" && Number.isSafeInteger(epoch) && !seen.has(epoch) && key instanceof Uint8Array, "PROVISIONING_KEYS_INVALID");
        seen.add(epoch);
        await authority.installEpochKey(epoch, key);
      }
    })
  };
}

// packages/peer-session/src/operation.ts
var ApplicationOperation = class {
  constructor(id, operationId, owner) {
    this.id = id;
    this.operationId = operationId;
    this.owner = owner;
  }
  id;
  operationId;
  owner;
  stored = true;
  inspect() {
    return this.owner.inspectOperation(this.id);
  }
  async materialized(options) {
    return (await this.owner.waitOperation(this.id, "materialized", options)).materialized;
  }
  async retained(options) {
    return (await this.owner.waitOperation(this.id, "retained", options)).retained;
  }
  async finalized(options) {
    return (await this.owner.waitOperation(this.id, "finalized", options)).materialized;
  }
};

// packages/peer-session/src/operation-codec.ts
async function signOperation(core, identity) {
  const canonicalCore = encodeTransactionCore(core), proposalId = bytesToHex(await transactionDigest(canonicalCore));
  check(bytesToHex(core.authorId) === identity.publicKey, "OPERATION_SIGNER_MISMATCH");
  return signRecord("operation", { proposalId, canonicalCore }, identity);
}
async function verifyOperation(body) {
  await verifyRecord("operation", body);
  const core = decodeTransactionCore(body.payload.canonicalCore);
  check(bytesToHex(core.authorId) === body.signer && bytesToHex(await transactionDigest(body.payload.canonicalCore)) === body.payload.proposalId, "OPERATION_IDENTITY_INVALID");
  return core;
}
function membershipAt(authority, id, timestamp, author) {
  const valid = writerAuthorizedAt(authority, author, id, timestamp);
  return valid === null ? "pending" : valid ? "valid" : "invalid";
}
function aad(applicationId, proposalId) {
  return encodeRecord(["operation-envelope", applicationId, proposalId]);
}
async function wrapOperation(body, identity, epoch, key) {
  const core = await verifyOperation(body);
  check(body.signer === identity.publicKey, "OPERATION_SIGNER_MISMATCH");
  const applicationId = bytesToHex(core.groupId);
  const payload = { applicationId, proposalId: body.payload.proposalId, author: body.signer, authorTimestampMs: core.authorTimestampMs, membershipId: bytesToHex(core.membershipRevision), executionManifestDigest: bytesToHex(core.executionManifestDigest), encrypted: await encryptEpochPayload(key, BigInt(epoch), encodeRecord(body), aad(applicationId, body.payload.proposalId)) };
  return signRecord("operation-envelope", payload, identity);
}
async function verifyEnvelope(envelope, authority) {
  await verifyRecord("operation-envelope", envelope, envelope.payload.author);
  const value = envelope.payload, descriptor = authority.descriptor;
  hexToBytes(value.proposalId);
  check(/^[0-9a-f]{64}$/u.test(value.proposalId) && value.applicationId === descriptor.applicationId && value.executionManifestDigest === descriptor.executionManifestDigest && typeof value.authorTimestampMs === "bigint" && value.authorTimestampMs >= 0n && value.authorTimestampMs <= (1n << 63n) - 1n && value.encrypted.epoch >= 0n && value.encrypted.epoch <= BigInt(Number.MAX_SAFE_INTEGER), "OPERATION_SCOPE_INVALID");
  const membership = membershipAt(authority, value.membershipId, value.authorTimestampMs, value.author);
  if (membership === "pending") return "pending";
  const base = authority.membership(value.membershipId);
  check(value.authorTimestampMs > base.authorTimeAfterMs && authority.grant(value.author, value.membershipId)?.writer === true, "OPERATION_WRITER_FORBIDDEN");
  if (membership === "invalid") return "excluded";
  return authority.bundle().memberships.some((item) => item.payload.epoch === Number(value.encrypted.epoch)) ? "valid" : "pending";
}
async function unwrapOperation(envelope, authority) {
  const admission = await verifyEnvelope(envelope, authority);
  if (admission === "pending") return "authority";
  const value = envelope.payload, key = authority.epochKey(Number(value.encrypted.epoch));
  if (key === null) return "key";
  const body = decodeRecord(await decryptEpochPayload(key, value.encrypted, aad(value.applicationId, value.proposalId)));
  const core = await verifyOperation(body);
  check(body.payload.proposalId === value.proposalId && body.signer === value.author && core.authorTimestampMs === value.authorTimestampMs && bytesToHex(core.membershipRevision) === value.membershipId && bytesToHex(core.groupId) === value.applicationId && bytesToHex(core.executionManifestDigest) === value.executionManifestDigest && bytesToHex(core.validationPolicy) === await recordDigest(["finality-policy", authority.descriptor.finalityPolicy]), "OPERATION_ENVELOPE_MISMATCH");
  return { body, core, admission };
}

// packages/peer-session/src/session.ts
var ApplicationSession = class _ApplicationSession {
  authority;
  definition;
  device;
  content;
  provisioning;
  signals;
  #options;
  #key;
  #journal;
  #prepared = /* @__PURE__ */ new Map();
  #tail = Promise.resolve();
  #replayTail = Promise.resolve();
  #runtime = null;
  #openingRuntime = null;
  #lifetime = new AbortController();
  #closed = false;
  #closing;
  #database = "idle";
  #error = null;
  #connectedPeers = 0;
  #connectionRevision = 0;
  #pending = /* @__PURE__ */ new Map();
  #invalid = /* @__PURE__ */ new Set();
  #invalidEnvelopes = /* @__PURE__ */ new Set();
  #envelopeDigests = /* @__PURE__ */ new WeakMap();
  #envelopesByDigest = /* @__PURE__ */ new Map();
  #resolved = /* @__PURE__ */ new Map();
  #outcomes = /* @__PURE__ */ new Map();
  #finality = { closedThroughMs: null, included: /* @__PURE__ */ new Map(), excludedProposalIds: /* @__PURE__ */ new Set(), proofs: [] };
  #revision;
  #listeners = /* @__PURE__ */ new Set();
  #statusListeners = /* @__PURE__ */ new Set();
  #factListeners = /* @__PURE__ */ new Set();
  #changeListeners = /* @__PURE__ */ new Set();
  #stopAuthority;
  constructor(options, journal, policyDigest) {
    this.#options = options;
    this.authority = options.authority;
    this.definition = options.definition;
    this.device = options.device;
    this.#key = `operation-set/${options.authority.descriptor.applicationId}`;
    this.#journal = journal;
    this.#revision = { digest: "", view: "local", executionManifestDigest: this.authority.descriptor.executionManifestDigest, policyDigest };
    this.provisioning = createApplicationProvisioning({ store: options.device.store, authority: options.authority, identity: options.device.identity });
    this.content = new ApplicationContent({ store: options.store, authority: options.authority, identity: options.device.identity, storageId: options.device.storageId });
    this.signals = new SignalChannel({ scope: options.authority.descriptor.applicationId, identity: { publicKeyBytes: hexToBytes(options.device.identity.publicKey), privateKey: options.device.identity.privateKey }, localEcho: true, relay: true, authorize: (input) => options.authority.grant(bytesToHex(input.authorId))?.reader === true });
    this.#stopAuthority = this.authority.subscribe(() => {
      this.#scheduleReplay();
      this.#factsChanged();
    });
  }
  static async open(options) {
    const applicationId = options.authority.descriptor.applicationId, bytes = await options.store.get(`operation-set/${applicationId}`);
    const journal = bytes === null ? { format: "authored-operation-set-v1", applicationId, envelopes: [], requests: [], retentions: [], finality: [] } : decodeRecord(bytes);
    check(journal.format === "authored-operation-set-v1" && journal.applicationId === applicationId && journal.requests.every((request) => typeof request.authorTimestampMs === "bigint" && request.authorTimestampMs >= 0n && request.authorTimestampMs <= (1n << 63n) - 1n), "OPERATION_STORE_FORMAT_INVALID");
    const session = new _ApplicationSession(options, journal, await finalityPolicyDigest(options.authority.descriptor.finalityPolicy));
    for (const envelope of journal.envelopes) await verifyEnvelope(envelope, session.authority);
    await session.#indexEnvelopes();
    for (const retention of journal.retentions) await session.#verifyRetention(retention);
    session.#finality = await verifyFinalityProofs(session.authority.descriptor, journal.finality, session.authority);
    if (bytes === null) await options.store.put(session.#key, encodeRecord(journal));
    session.#scheduleReplay();
    return session;
  }
  get signal() {
    return this.#lifetime.signal;
  }
  connectPeer(options) {
    return import("./network-HJJS7TRI.mjs").then((module) => module.connectApplicationPeer(this, options));
  }
  diagnostics() {
    return import("./network-HJJS7TRI.mjs").then((module) => module.applicationPeerDiagnostics(this));
  }
  get applicationId() {
    return this.authority.descriptor.applicationId;
  }
  get identity() {
    return { publicKey: this.device.identity.publicKey };
  }
  get revision() {
    return { ...this.#revision };
  }
  get status() {
    return { pendingDependencies: [...this.#finality.pendingDependencies ?? [], ...[...this.#pending].filter(([, kind]) => kind !== "materializer").map(([id, kind]) => `${kind}/${id}`)], canAuthor: !this.#closed && this.authority.grant(this.device.identity.publicKey)?.writer === true && this.authority.epochKey(this.authority.currentMembership.epoch) !== null, phase: this.#closed ? "closed" : [...this.#pending.values()].includes("key") ? "awaiting-keys" : "ready", database: this.#database, connectedPeers: this.#connectedPeers, connectionRevision: this.#connectionRevision, pendingOperations: this.#pending.size, materializationError: this.#error?.message ?? null };
  }
  #serial(work) {
    const task = this.#tail.then(() => {
      check(!this.#closed, "SESSION_CLOSED");
      return work();
    });
    this.#tail = task.catch(() => void 0);
    return task;
  }
  async #indexEnvelopes() {
    const indexed = /* @__PURE__ */ new Map();
    for (const envelope of this.#journal.envelopes) {
      let digest = this.#envelopeDigests.get(envelope);
      if (digest === void 0) {
        digest = await recordDigest(envelope);
        this.#envelopeDigests.set(envelope, digest);
      }
      indexed.set(digest, envelope);
    }
    this.#envelopesByDigest = indexed;
  }
  #canonicalAuthor(id) {
    if (this.#journal.requests.some((request) => request.proposalId === id)) return this.device.identity.publicKey;
    const resolved = this.#resolved.get(id);
    return resolved === void 0 ? void 0 : bytesToHex(resolved.core.authorId);
  }
  #subjectEnvelope(id) {
    const knownAuthor = this.#canonicalAuthor(id), candidates = [...this.#envelopesByDigest].filter(([digest, envelope]) => envelope.payload.proposalId === id && !this.#invalidEnvelopes.has(digest) && (knownAuthor === void 0 || envelope.payload.author === knownAuthor));
    const authors = new Set(candidates.map(([, envelope]) => envelope.payload.author));
    return authors.size === 1 ? candidates[0]?.[1] : void 0;
  }
  #retained(id) {
    const author = this.#canonicalAuthor(id) ?? this.#subjectEnvelope(id)?.payload.author;
    if (author === void 0) return [];
    return this.#journal.retentions.filter((evidence) => {
      const receipt = evidence.payload, envelope = this.#envelopesByDigest.get(receipt.envelopeDigest);
      return receipt.proposalId === id && receipt.author === author && this.authority.grant(evidence.signer) !== null && evidence.signer !== this.device.identity.publicKey && receipt.storageId !== this.device.storageId && envelope?.payload.proposalId === id && envelope.payload.author === author && !this.#invalidEnvelopes.has(receipt.envelopeDigest);
    });
  }
  async #persist(journal) {
    check(journal.envelopes.length <= (this.#options.maxOperations ?? 1e5), "OPERATION_COUNT_LIMIT");
    const bytes = encodeRecord(journal);
    check(bytes.length <= (this.#options.maxHistoryBytes ?? 32 * 1024 * 1024), "OPERATION_HISTORY_LIMIT");
    try {
      await this.#options.store.put(this.#key, bytes);
      this.#journal = journal;
      await this.#indexEnvelopes();
    } catch (error) {
      const retained = await this.#options.store.get(this.#key);
      if (retained !== null) {
        this.#journal = decodeRecord(retained);
        await this.#indexEnvelopes();
        this.#scheduleReplay();
        this.#factsChanged();
        this.#notify();
      }
      throw error;
    }
  }
  async #commitPrepared(intent) {
    const { request, envelope } = intent;
    await this.#persist({ ...this.#journal, envelopes: [...this.#journal.envelopes, envelope], requests: [...this.#journal.requests, request] });
    this.#prepared.delete(request.operationId);
    this.#pending.set(request.proposalId, "materializer");
    this.#notify();
    this.#factsChanged();
    this.#scheduleReplay();
    return new ApplicationOperation(request.proposalId, request.operationId, this);
  }
  /** Completion is local durable signed storage, not network dispatch or engine warm-up. */
  submit(input) {
    const program = structuredClone(input.program), operationId = input.operationId ?? crypto.randomUUID(), suppliedTimestamp = input.authorTimestampMs ?? null;
    return this.#serial(async () => {
      const requestDigest = await recordDigest({ program: bytesToHex(encodeChangeProgram(program)) });
      const prior = this.#journal.requests.find((request) => request.operationId === operationId);
      if (prior !== void 0) {
        check(prior.requestDigest === requestDigest && (suppliedTimestamp === null || suppliedTimestamp === prior.authorTimestampMs), "OPERATION_ID_REUSED");
        this.#prepared.delete(operationId);
        this.#scheduleReplay();
        this.#factsChanged();
        return new ApplicationOperation(prior.proposalId, operationId, this);
      }
      const prepared = this.#prepared.get(operationId);
      if (prepared !== void 0) {
        check(prepared.request.requestDigest === requestDigest && (suppliedTimestamp === null || suppliedTimestamp === prepared.envelope.payload.authorTimestampMs), "OPERATION_ID_REUSED");
        return this.#commitPrepared(prepared);
      }
      check(this.#prepared.size < 32, "AUTHORING_PREPARATION_LIMIT");
      const grant = this.authority.grant(this.device.identity.publicKey);
      check(grant?.writer, "OPERATION_WRITER_FORBIDDEN");
      const highestDefault = this.#journal.requests.filter((request) => request.suppliedTimestamp === null).reduce((highest, request) => request.authorTimestampMs > highest ? request.authorTimestampMs : highest, -1n);
      const now = BigInt(Date.now());
      const authorTimestampMs = suppliedTimestamp ?? (now > highestDefault ? now : highestDefault + 1n);
      const memberships = this.authority.bundle().memberships;
      const historical = [...memberships].reverse().find((item) => authorTimestampMs > item.payload.authorTimeAfterMs);
      check(historical !== void 0 && historical.payload.members.some((member) => member.publicKey === this.device.identity.publicKey && member.writer), "OPERATION_MEMBERSHIP_TIME_INVALID");
      const membership = historical.payload, membershipId = await recordDigest(historical);
      const epochKey = this.authority.epochKey(membership.epoch);
      check(epochKey !== null, "OPERATION_EPOCH_KEY_MISSING");
      const core = { operationId, groupId: hexToBytes(this.applicationId), membershipRevision: hexToBytes(membershipId), validationPolicy: hexToBytes(this.#revision.policyDigest), authorId: hexToBytes(this.device.identity.publicKey), authorTimestampMs, nonce: crypto.getRandomValues(new Uint8Array(16)), executionManifestDigest: hexToBytes(this.authority.descriptor.executionManifestDigest), program };
      const body = await signOperation(core, this.device.identity), envelope = await wrapOperation(body, this.device.identity, membership.epoch, epochKey);
      const intent = { envelope, request: { operationId, requestDigest, suppliedTimestamp, authorTimestampMs, proposalId: body.payload.proposalId } };
      this.#prepared.set(operationId, intent);
      return this.#commitPrepared(intent);
    }).catch((error) => {
      if (error instanceof Error) Object.assign(error, { operationId, applicationId: this.applicationId, durability: this.#journal.requests.some((request) => request.operationId === operationId) ? "stored" : "unconfirmed" });
      throw error;
    });
  }
  command(name, input, options = {}) {
    const command = this.definition.commands[name];
    check(command !== void 0, "APPLICATION_COMMAND_UNKNOWN");
    return this.submit({ ...options, program: command.prepare(input) });
  }
  #operation(id) {
    const request = this.#journal.requests.find((item) => item.operationId === id || item.proposalId === id);
    const resolved = this.#resolved.get(id);
    const envelope = this.#subjectEnvelope(id);
    return request === void 0 ? resolved === void 0 ? envelope === void 0 ? null : new ApplicationOperation(id, "", this) : new ApplicationOperation(id, resolved.core.operationId, this) : new ApplicationOperation(request.proposalId, request.operationId, this);
  }
  get operations() {
    const session = this;
    return { get: (id) => session.#operation(id), async retry(id) {
      const operation = session.#operation(id);
      check(operation !== null && operation.inspect().author === session.device.identity.publicKey, "OPERATION_RETRY_FORBIDDEN");
      session.#scheduleReplay();
      session.#factsChanged();
      return operation;
    }, async *subscribe(options) {
      const signal = options.signal === void 0 ? session.signal : AbortSignal.any([session.signal, options.signal]);
      let dirty = true, wake;
      const listener = () => {
        dirty = true;
        wake?.();
      };
      session.#listeners.add(listener);
      signal.addEventListener("abort", listener);
      try {
        while (!signal.aborted) {
          if (!dirty) await new Promise((resolve) => {
            wake = resolve;
          });
          if (signal.aborted) break;
          dirty = false;
          const operation = session.#operation(options.operationId);
          if (operation !== null) yield operation.inspect();
          else if (session.#pending.has(options.operationId)) yield session.inspectOperation(options.operationId);
        }
      } finally {
        session.#listeners.delete(listener);
        signal.removeEventListener("abort", listener);
      }
    } };
  }
  inspectOperation(id) {
    const envelope = this.#subjectEnvelope(id), resolved = this.#resolved.get(id);
    const materialized = this.#outcomes.get(id) ?? null, cutoff = this.#finality.closedThroughMs;
    const finalized = this.authority.descriptor.finalityPolicy.kind !== "none" && cutoff !== null && this.#finality.included.has(id) && !this.#finality.excludedProposalIds.has(id) && resolved !== void 0 && resolved.core.authorTimestampMs <= cutoff && materialized !== null && this.#pending.size === 0 && this.#error === null;
    return { applicationId: this.applicationId, author: resolved === void 0 ? envelope?.payload.author ?? "" : bytesToHex(resolved.core.authorId), authorTimestampMs: (resolved?.core.authorTimestampMs ?? envelope?.payload.authorTimestampMs)?.toString() ?? null, proposalId: id, operationId: resolved?.core.operationId ?? this.#journal.requests.find((item) => item.proposalId === id)?.operationId ?? "", stored: envelope !== void 0, pending: this.#pending.get(id) ?? null, materialized, retained: structuredClone(this.#retained(id)), finalized, excluded: this.#invalid.has(id) || this.#finality.excludedProposalIds.has(id) };
  }
  waitOperation(id, fact, options = {}) {
    if (fact === "finalized" && this.authority.descriptor.finalityPolicy.kind === "none") return Promise.reject(Object.assign(new Error("FINALITY_UNSUPPORTED"), { code: "FINALITY_UNSUPPORTED" }));
    const timeoutMs = options.timeoutMs ?? 3e4;
    check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 12e4, "OPERATION_WAIT_LIMIT");
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        this.#listeners.delete(checkFact);
        options.signal?.removeEventListener("abort", abort);
        if (error !== void 0) reject(error);
        else resolve(value);
      };
      const abort = () => finish(options.signal?.reason ?? new Error("ABORTED"));
      const checkFact = () => {
        const value = this.inspectOperation(id);
        if (this.#closed) finish(new Error("SESSION_CLOSED"));
        else if (value.excluded) finish(Object.assign(new Error("OPERATION_EXCLUDED"), { inspection: value }));
        else if (fact === "materialized" ? value.materialized !== null : fact === "retained" ? value.retained.length > 0 : value.finalized) finish(void 0, value);
      };
      const timer = setTimeout(() => finish(new Error("OPERATION_WAIT_TIMEOUT")), timeoutMs);
      this.#listeners.add(checkFact);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      else checkFact();
    });
  }
  exportFacts() {
    return structuredClone({ authority: this.authority.bundle(), envelopes: this.#journal.envelopes, retentions: this.#journal.retentions, finality: this.#journal.finality });
  }
  async #verifyRetention(evidence) {
    check(evidence.payload.applicationId === this.applicationId && evidence.payload.peer === evidence.signer && typeof evidence.payload.storageId === "string" && evidence.payload.storageId.length > 0 && evidence.payload.storageId.length <= 128 && /^[0-9a-f]{64}$/u.test(evidence.payload.proposalId) && /^[0-9a-f]{64}$/u.test(evidence.payload.author) && /^[0-9a-f]{64}$/u.test(evidence.payload.envelopeDigest) && this.authority.bundle().memberships.some((membership) => membership.payload.members.some((member) => member.publicKey === evidence.signer)), "RETENTION_SCOPE_INVALID");
    await verifyRecord("retention", evidence, evidence.payload.peer);
  }
  async mergeFacts(input) {
    const facts = structuredClone(input);
    if (facts.authority !== void 0) await this.mergeAuthority(facts.authority);
    return this.#serial(async () => {
      const envelopes = [...this.#journal.envelopes], retentions = [...this.#journal.retentions];
      const known = new Set(await Promise.all(envelopes.map((item) => recordDigest(item))));
      for (const envelope of facts.envelopes) {
        await verifyEnvelope(envelope, this.authority);
        const id = await recordDigest(envelope);
        if (!known.has(id)) {
          check(envelopes.filter((item) => item.payload.proposalId === envelope.payload.proposalId && item.payload.author === envelope.payload.author).length < 8, "OPERATION_ENVELOPE_LIMIT");
          known.add(id);
          envelopes.push(envelope);
        }
      }
      const receipts = new Set(await Promise.all(retentions.map((item) => recordDigest(item))));
      for (const receipt of facts.retentions) {
        await this.#verifyRetention(receipt);
        const id = await recordDigest(receipt);
        if (!receipts.has(id)) {
          receipts.add(id);
          retentions.push(receipt);
        }
      }
      const proofs = await mergeFinalityProofs(this.#journal.finality, facts.finality);
      const verified = await verifyFinalityProofs(this.authority.descriptor, proofs, this.authority);
      const journal = { ...this.#journal, envelopes, retentions, finality: proofs };
      if (await recordDigest(journal) === await recordDigest(this.#journal)) return;
      await this.#persist(journal);
      this.#finality = verified;
      this.#notify();
      this.#factsChanged();
      this.#scheduleReplay();
    });
  }
  async retain(proposalId, subject) {
    const envelope = subject === void 0 ? this.#subjectEnvelope(proposalId) : this.#envelopesByDigest.get(subject.envelopeDigest);
    check(envelope !== void 0 && envelope.payload.proposalId === proposalId && (subject === void 0 || envelope.payload.author === subject.author), "RETENTION_SUBJECT_MISSING");
    const author = envelope.payload.author, envelopeDigest = this.#envelopeDigests.get(envelope);
    check(!this.#invalidEnvelopes.has(envelopeDigest), "RETENTION_SUBJECT_INVALID");
    const existing = this.#journal.retentions.find((item) => item.payload.proposalId === proposalId && item.payload.author === author && item.payload.envelopeDigest === envelopeDigest && item.signer === this.device.identity.publicKey && item.payload.storageId === this.device.storageId);
    if (existing !== void 0) return structuredClone(existing);
    const evidence = await signRecord("retention", { applicationId: this.applicationId, proposalId, author, envelopeDigest, peer: this.device.identity.publicKey, storageId: this.device.storageId }, this.device.identity);
    await this.mergeFacts({ envelopes: [], retentions: [evidence], finality: [] });
    return evidence;
  }
  async mergeAuthority(bundle) {
    const current = this.authority.currentMembership.revision, sealed = this.#finality.closedThroughMs;
    if (sealed !== null) for (const membership of bundle.memberships.slice(current + 1)) check(membership.payload.authorTimeAfterMs >= sealed, "FINALITY_MEMBERSHIP_BEHIND_SEAL");
    await this.authority.merge(bundle);
  }
  get finality() {
    const session = this;
    const prepare = (options) => session.#serial(async () => {
      const policy = session.authority.descriptor.finalityPolicy;
      check(policy.kind !== "none", "FINALITY_UNSUPPORTED");
      check(session.authority.grant(session.device.identity.publicKey)?.finalizer === true, "FINALITY_FINALIZER_REQUIRED");
      check(policy.kind === "signed-frontier" ? policy.signer === session.device.identity.publicKey : policy.validators.includes(session.device.identity.publicKey), "FINALITY_SIGNER_FORBIDDEN");
      check(typeof options.throughMs === "bigint" && options.throughMs >= 0n && options.throughMs <= (1n << 63n) - 1n, "FINALITY_TIME_INVALID");
      const entriesById = /* @__PURE__ */ new Map();
      for (const envelope of session.#journal.envelopes) {
        try {
          const resolved = await unwrapOperation(envelope, session.authority);
          if (typeof resolved !== "string" && resolved.admission === "excluded") continue;
          const entry = { id: envelope.payload.proposalId, timestamp: envelope.payload.authorTimestampMs, membershipId: envelope.payload.membershipId, author: envelope.payload.author, available: typeof resolved !== "string" }, prior = entriesById.get(entry.id);
          if (prior === void 0 || !prior.available && (entry.available || entry.timestamp < prior.timestamp)) entriesById.set(entry.id, entry);
        } catch {
        }
      }
      const entries = [...entriesById.values()], certified = await verifyFinalityProofs(session.authority.descriptor, session.#journal.finality, session.authority);
      const votes = [];
      for (const scope of await finalityAdmissionScopes(session.authority)) {
        const history = (certified.certifiedProofs ?? []).filter((proof) => proof.statement.scope === scope.id), head = history.at(-1)?.statement;
        const firstIncluded = new Set(history.flatMap((proof) => proof.statement.inclusions.map((inclusion) => inclusion.proposalId)));
        const matching = entries.filter((entry) => entry.timestamp > scope.authorTimeAfterMs && (!session.authority.hasMembership(scope.id) || entry.membershipId === scope.id));
        const blockers = matching.filter((entry) => !entry.available && entry.timestamp <= options.throughMs).map((entry) => ({ proposalId: entry.id, authorTimestampMs: entry.timestamp, membershipId: entry.membershipId, author: entry.author }));
        let closedThroughMs = options.throughMs > scope.authorTimeAfterMs ? options.throughMs : scope.authorTimeAfterMs;
        for (const blocker of blockers) if (closedThroughMs >= blocker.authorTimestampMs) closedThroughMs = blocker.authorTimestampMs - 1n;
        check(closedThroughMs >= (head?.closedThroughMs ?? scope.authorTimeAfterMs), "FINALITY_DEPENDENCY_BEHIND_SEAL");
        const statement = { applicationId: session.applicationId, policyDigest: session.#revision.policyDigest, authorityHead: session.authority.currentMembershipId, scope: scope.id, sequence: (head?.sequence ?? -1) + 1, previous: head === void 0 ? null : await recordDigest(head), inclusions: matching.filter((entry) => entry.available && !firstIncluded.has(entry.id)).map((entry) => ({ proposalId: entry.id, authorTimestampMs: entry.timestamp, membershipId: entry.membershipId, author: entry.author })).sort((a, b) => a.proposalId.localeCompare(b.proposalId)), closedThroughMs, blockers };
        votes.push(await signFinalityStatement(statement, session.device.identity));
      }
      return votes;
    });
    return { voteAuthorTime: prepare, async closeAuthorTime(options) {
      const policy = session.authority.descriptor.finalityPolicy;
      check(policy.kind !== "none", "FINALITY_UNSUPPORTED");
      check(session.authority.grant(session.device.identity.publicKey)?.finalizer === true, "FINALITY_FINALIZER_REQUIRED");
      check(policy.kind === "signed-frontier" || policy.threshold === 1, "FINALITY_QUORUM_REQUIRED");
      const votes = await prepare(options), proofs = votes.map((vote) => ({ statement: vote.payload, signatures: [vote] }));
      await session.mergeFacts({ envelopes: [], retentions: [], finality: proofs });
      await session.retryMaterialization();
      return { closedThroughMs: session.#finality.closedThroughMs, proofs };
    }, async submitProofs(proofs) {
      await session.mergeFacts({ envelopes: [], retentions: [], finality: proofs });
    } };
  }
  onFacts(listener) {
    this.#factListeners.add(listener);
    return () => {
      this.#factListeners.delete(listener);
    };
  }
  #factsChanged() {
    for (const listener of this.#factListeners) {
      try {
        listener();
      } catch {
      }
    }
  }
  #notify() {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
      }
    }
    ;
    for (const listener of this.#statusListeners) {
      try {
        listener(this.status);
      } catch {
      }
    }
  }
  onStatus(listener) {
    this.#statusListeners.add(listener);
    try {
      listener(this.status);
    } catch {
    }
    ;
    return () => {
      this.#statusListeners.delete(listener);
    };
  }
  onChange(listener) {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }
  setConnectedPeers(count) {
    check(Number.isSafeInteger(count) && count >= 0 && count <= 8, "SESSION_PEER_LIMIT");
    if (count !== this.#connectedPeers) this.#connectionRevision++;
    this.#connectedPeers = count;
    this.#notify();
  }
  #scheduleReplay() {
    if (this.#closed) return;
    this.#replayTail = this.#replayTail.then(() => this.#replay()).catch((error) => {
      this.#error = error instanceof Error ? error : new Error("MATERIALIZATION_FAILED", { cause: error });
      this.#database = "failed";
      this.#notify();
    });
  }
  async #engine() {
    if (this.#runtime !== null) return this.#runtime;
    this.#database = "opening";
    this.#notify();
    if (this.#openingRuntime === null) {
      const opening = this.#options.createMaterializer === void 0 ? createEventMaterializationRuntime({ store: this.#options.store, namespace: this.applicationId }) : this.#options.createMaterializer({ signal: this.#lifetime.signal, rootPrincipal: hexToBytes(this.authority.descriptor.rootPrincipal), store: this.#options.store });
      this.#openingRuntime = Promise.resolve(opening);
    }
    try {
      const runtime = await this.#openingRuntime;
      check(bytesToHex(runtime.queries.executionManifestDigest) === this.authority.descriptor.executionManifestDigest, "EXECUTION_MANIFEST_UNAVAILABLE");
      this.#runtime = runtime;
      return runtime;
    } catch (error) {
      this.#openingRuntime = null;
      throw error;
    }
  }
  async #replay() {
    if (this.#closed) return;
    const journal = this.#journal, resolved = /* @__PURE__ */ new Map(), pending = /* @__PURE__ */ new Map(), invalid = /* @__PURE__ */ new Set(), invalidEnvelopes = /* @__PURE__ */ new Set();
    for (const envelope of journal.envelopes) {
      const id = envelope.payload.proposalId, digest2 = this.#envelopeDigests.get(envelope), knownAuthor = this.#canonicalAuthor(id);
      if (knownAuthor !== void 0 && knownAuthor !== envelope.payload.author) {
        invalidEnvelopes.add(digest2);
        continue;
      }
      let result2;
      try {
        result2 = await unwrapOperation(envelope, this.authority);
      } catch {
        invalidEnvelopes.add(digest2);
        continue;
      }
      if (typeof result2 === "string") {
        if (!resolved.has(id)) pending.set(id, result2);
        continue;
      }
      const txId = hexToBytes(id);
      pending.delete(id);
      if (result2.admission === "excluded") invalid.add(id);
      else invalid.delete(id);
      resolved.set(id, { envelope, core: result2.core, proposal: { txId, candidateDigest: txId, canonicalCandidate: result2.body.payload.canonicalCore, core: result2.core } });
    }
    this.#invalidEnvelopes = invalidEnvelopes;
    this.#resolved = resolved;
    const finality = await verifyFinalityProofs(this.authority.descriptor, journal.finality, this.authority, [...resolved].map(([proposalId, entry]) => ({ proposalId, authorTimestampMs: entry.core.authorTimestampMs, membershipId: bytesToHex(entry.core.membershipRevision), author: bytesToHex(entry.core.authorId) })));
    for (const [id, inclusion] of finality.included) {
      const entry = resolved.get(id);
      if (entry === void 0) pending.set(id, "body");
      else check(entry.core.authorTimestampMs === inclusion.authorTimestampMs, "FINALITY_BODY_TIME_MISMATCH");
    }
    const cutoffForAdmission = finality.closedThroughMs;
    for (const [id, entry] of resolved) if (cutoffForAdmission !== null && entry.core.authorTimestampMs <= cutoffForAdmission && !finality.included.has(id)) invalid.add(id);
    const eligible = [...resolved.values()].filter((entry) => !invalid.has(entry.envelope.payload.proposalId) && !finality.excludedProposalIds.has(entry.envelope.payload.proposalId)).sort((a, b) => compareTransactionOrder(transactionOrderKey(a.core, a.proposal.txId), transactionOrderKey(b.core, b.proposal.txId)));
    this.#pending = new Map(pending);
    for (const entry of eligible) this.#pending.set(entry.envelope.payload.proposalId, "materializer");
    this.#invalid = invalid;
    const runtime = await this.#engine();
    const result = await runtime.replay.materialize(eligible.map((entry) => entry.proposal));
    if (result !== null) await runtime.publications.publish(result.publication);
    const digest = await recordDigest(["materialized-operation-set", this.applicationId, this.#revision.executionManifestDigest, this.#revision.policyDigest, "local", eligible.map((entry) => entry.envelope.payload.proposalId)]);
    const revision = { ...this.#revision, digest };
    const outcomes = /* @__PURE__ */ new Map();
    for (const entry of eligible) {
      const id = entry.envelope.payload.proposalId, outcome = runtime.queries.outcome(entry.proposal.txId);
      check(outcome !== null, "MATERIALIZATION_OUTCOME_MISSING");
      outcomes.set(id, { proposalId: id, revision, outcome: outcome.outcome, rejectionCode: outcome.rejectionCode, failingStatementIndex: outcome.failingStatementIndex });
    }
    let finalLength = 0;
    const cutoff = finality.closedThroughMs;
    if (cutoff !== null && pending.size === 0) {
      for (const entry of eligible) {
        if (entry.core.authorTimestampMs > cutoff || !finality.included.has(entry.envelope.payload.proposalId)) break;
        finalLength++;
      }
      await runtime.replay.publishFinal?.(finalLength);
    }
    const revisedProposalIds = [.../* @__PURE__ */ new Set([...this.#outcomes.keys(), ...outcomes.keys()])].filter((id) => {
      const prior = this.#outcomes.get(id), current = outcomes.get(id);
      return prior?.outcome !== current?.outcome || prior?.rejectionCode !== current?.rejectionCode;
    });
    const changed = this.#revision.digest !== digest;
    this.#resolved = resolved;
    this.#pending = pending;
    this.#outcomes = outcomes;
    this.#revision = revision;
    this.#finality = finality;
    this.#error = null;
    this.#database = "ready";
    this.#notify();
    if (changed || finalLength > 0) for (const listener of this.#changeListeners) {
      try {
        listener({ kind: changed ? "materialized" : "finalized", revision, revisedProposalIds });
      } catch {
      }
    }
  }
  async retryMaterialization() {
    this.#scheduleReplay();
    await this.#replayTail;
    if (this.#error !== null) throw this.#error;
  }
  async readView(options = {}) {
    await this.#replayTail;
    check(!this.#closed, "SESSION_CLOSED");
    check(this.authority.grant(this.device.identity.publicKey)?.reader, "APPLICATION_READER_REQUIRED");
    if (this.#error !== null) throw this.#error;
    check(this.#runtime !== null, "MATERIALIZATION_UNAVAILABLE");
    const view = options.view ?? "local";
    if (view === "final") {
      check(this.authority.descriptor.finalityPolicy.kind !== "none", "FINALITY_UNSUPPORTED");
      check(this.#finality.closedThroughMs !== null && this.#pending.size === 0, "FINAL_READ_UNAVAILABLE");
    }
    const readHandle = this.#runtime.queries.captureRead?.({ view }), snapshot = readHandle ?? this.#runtime.queries.captureApplication({ view });
    const ids = [], events = [];
    for (let i = 0; i < snapshot.orderLength; i++) {
      const transaction = snapshot.transactionAt(i);
      check(transaction !== null, "READ_SNAPSHOT_INCOMPLETE");
      const id = bytesToHex(transaction.txId);
      ids.push(id);
      if (transaction.outcome !== "accepted") continue;
      const core = decodeTransactionCore(transaction.canonicalCandidate);
      let ordinal = 0;
      for (const step of core.program.steps) if (isEmitStep(step)) events.push({ id: `${id}:${ordinal++}`, proposalId: id, operationId: core.operationId, author: bytesToHex(core.authorId), authorTimestampMs: core.authorTimestampMs.toString(), topic: step.topic, payload: structuredClone(step.payload) });
    }
    const revision = { ...this.#revision, view, digest: await recordDigest(["materialized-operation-set", this.applicationId, this.#revision.executionManifestDigest, this.#revision.policyDigest, view, ids]) };
    let released = false;
    return { applicationId: this.applicationId, revision, query(sql, parameters = []) {
      check(!released, "READ_VIEW_RELEASED");
      check(readHandle !== void 0, "SQL_UNAVAILABLE");
      const result = readHandle.query(sql, parameters.map(toSqlValue));
      return { columns: result.columns, rows: result.rows.map((row) => row.map(fromSqlValue)) };
    }, readEvents: (input = {}) => {
      check(!released, "READ_VIEW_RELEASED");
      return readEvents(events, revision, input);
    }, release() {
      if (released) return;
      released = true;
      readHandle?.release();
    } };
  }
  async query(name, input, options = {}) {
    const query = this.definition.queries[name];
    check(query !== void 0, "APPLICATION_QUERY_UNKNOWN");
    const signal = options.signal === void 0 ? this.signal : AbortSignal.any([this.signal, options.signal]), opening = this.readView();
    let view;
    try {
      view = await awaitOwnedTask(signal, () => opening);
    } catch (error) {
      void opening.then((late) => late.release()).catch(() => void 0);
      throw error;
    }
    try {
      return { applicationId: this.applicationId, revision: view.revision, value: await awaitOwnedTask(signal, () => query.read(view, input)) };
    } finally {
      view.release();
    }
  }
  async readEvents(options = {}) {
    const view = await this.readView();
    try {
      return view.readEvents(options);
    } finally {
      view.release();
    }
  }
  async *changes(options = {}) {
    const queue = [];
    let wake;
    const stop = this.onChange((value) => {
      queue.splice(0, queue.length, value);
      wake?.();
    }), close = () => {
      wake?.();
    };
    const signal = options.signal === void 0 ? this.#lifetime.signal : AbortSignal.any([this.#lifetime.signal, options.signal]);
    signal.addEventListener("abort", close);
    try {
      while (!signal.aborted) {
        if (queue.length === 0) await new Promise((resolve) => {
          wake = resolve;
        });
        while (queue.length > 0 && !signal.aborted) yield queue.shift();
      }
    } finally {
      stop();
      signal.removeEventListener("abort", close);
    }
  }
  close() {
    return this.#closing ??= (async () => {
      this.#closed = true;
      this.#stopAuthority();
      this.#lifetime.abort(new Error("SESSION_CLOSED"));
      this.#notify();
      await this.#tail;
      await this.#replayTail;
      this.#database = "closed";
      await this.#runtime?.close();
      this.signals.close();
      await this.content.close();
      await this.#options.release();
      this.#notify();
      this.#listeners.clear();
      this.#factListeners.clear();
      this.#statusListeners.clear();
      this.#changeListeners.clear();
    })();
  }
};
function toSqlValue(value) {
  if (value === null) return { kind: "null" };
  if (typeof value === "bigint") return { kind: "integer", value: value.toString() };
  if (typeof value === "number") return Number.isSafeInteger(value) ? { kind: "integer", value: String(value) } : { kind: "real", value };
  if (typeof value === "string") return { kind: "text", value };
  return { kind: "blob", value: value.slice() };
}
function fromSqlValue(value) {
  switch (value.kind) {
    case "null":
      return null;
    case "integer":
      {
        const bigint = BigInt(value.value);
        return bigint >= BigInt(Number.MIN_SAFE_INTEGER) && bigint <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bigint) : bigint;
      }
      ;
    case "real":
    case "text":
      return value.value;
    case "blob":
      return value.value.slice();
  }
}
function readEvents(events, revision, options) {
  const topics = options.topics === void 0 ? null : [...new Set(options.topics)].sort(), limit = options.limit ?? 100;
  check(Number.isSafeInteger(limit) && limit > 0 && limit <= 1e3 && (topics === null || topics.length <= 128 && topics.every((topic) => typeof topic === "string" && topic.length <= 128)), "EVENT_READ_LIMIT");
  const scope = JSON.stringify(topics);
  let offset = 0;
  if (options.cursor !== void 0) {
    check(options.cursor.length <= 128 * 1024, "EVENT_CURSOR_LIMIT");
    const cursor = JSON.parse(options.cursor);
    check(cursor.revision === revision.digest, "EVENT_CURSOR_STALE");
    check(cursor.scope === scope && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= events.length, "EVENT_CURSOR_INVALID");
    offset = cursor.offset;
  }
  const selected = [];
  let index = offset;
  while (index < events.length && selected.length < limit) {
    const event = events[index++];
    if (topics === null || topics.includes(event.topic)) selected.push(structuredClone(event));
  }
  return { revision, events: selected, cursor: JSON.stringify({ revision: revision.digest, scope, offset: index }), hasMore: index < events.length };
}

// packages/peer-session/src/runtime.ts
async function createApplicationSession(options) {
  const release = claimApplicationDevice(options.device);
  try {
    const authority = options.authority !== void 0 && "grant" in options.authority ? options.authority : await createAuthorityProvider({ store: options.device.store, ...options.authority === void 0 ? {} : { bundle: options.authority }, ...options.applicationId === void 0 ? {} : { applicationId: options.applicationId }, ...options.epochKeys === void 0 ? {} : { epochKeys: options.epochKeys } });
    if (options.epochKeys !== void 0) for (const [epoch, key] of options.epochKeys) await authority.installEpochKey(epoch, key);
    const storage = await options.device.openStorage();
    return await ApplicationSession.open({ ...options, authority, store: storage.store, async release() {
      release();
      await options.device.close();
    } });
  } catch (error) {
    release();
    await options.device.close();
    throw error;
  }
}
export {
  createApplicationSession
};
