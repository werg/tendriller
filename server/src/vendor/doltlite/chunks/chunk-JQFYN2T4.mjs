import {
  eventExecutionManifest
} from "./chunk-GEKQN4CD.mjs";
import {
  writeBytesMany
} from "./chunk-MCU2YKH4.mjs";
import {
  assertCanonicalCbor,
  assertValidChangeProgram,
  compareTransactionOrder,
  decodeTransactionCore,
  encodeTransactionCore,
  executionManifestArtifacts,
  isEmitStep,
  transactionDigest,
  transactionOrderKey
} from "./chunk-MAGRVNAE.mjs";
import {
  bytesToHex,
  encodeCanonicalCbor,
  equalBytes,
  hexToBytes,
  sha256
} from "./chunk-HYFY2E3E.mjs";

// packages/materializer/src/runtime.ts
function publicationRequestForRevision(revision) {
  return {
    publicationKey: `revision:${revision.revision}:${revision.contentHash}`,
    expectedRevision: revision.previousRevision,
    targetRevision: revision.revision,
    targetOrderLength: revision.orderLength,
    candidateIdentity: revision.contentHash
  };
}

// packages/materializer/src/event-store.ts
var EventHistoryStore = class {
  constructor(store, key, digest, quota) {
    this.store = store;
    this.key = key;
    this.digest = digest;
    this.quota = quota;
  }
  store;
  key;
  digest;
  quota;
  #anchors = [];
  #prefixBytes = [];
  async load() {
    const bytes = await this.store.get(this.key);
    if (bytes === null) return null;
    if (bytes.length > 1024 || bytes.length > this.quota) throw new Error("EVENT_EXECUTION_STORE_INVALID");
    const value = assertCanonicalCbor(bytes, { maxBytes: 1024, maxItems: 32 });
    if (!Array.isArray(value) || value.length !== 8 || value[0] !== "chronolog/event-head/v2" || !(value[1] instanceof Uint8Array) || !equalBytes(value[1], this.digest) || typeof value[2] !== "bigint" || typeof value[3] !== "bigint" || typeof value[4] !== "bigint" || typeof value[5] !== "bigint" || value[2] < 0n || value[3] < 0n || value[3] > value[5] || value[4] < 0n || value[5] < 0n || value[5] > 100000n || typeof value[7] !== "bigint" || value[7] < 0n || value[7] + BigInt(bytes.length) > BigInt(this.quota) || value[5] > value[7] / 64n || value[6] !== null && (!(value[6] instanceof Uint8Array) || value[6].length !== 32)) throw new Error("EVENT_EXECUTION_STORE_INVALID");
    const count = Number(value[5]), order = new Array(count), sizes = new Array(count);
    const anchors = new Array(count);
    let tail = value[6], used = bytes.length;
    for (let index = count - 1; index >= 0; index--) {
      if (!(tail instanceof Uint8Array)) throw new Error("EVENT_EXECUTION_STORE_INVALID");
      const hash = bytesToHex(tail), node = await this.store.get(`${this.key}/node/${hash}`);
      if (node === null || node.length > this.quota - used || !equalBytes(await sha256(node), tail)) throw new Error("EVENT_EXECUTION_HISTORY_INCOMPLETE");
      used += node.length;
      if (used > this.quota) throw new Error("EVENT_EXECUTION_QUOTA_EXCEEDED");
      const row = assertCanonicalCbor(node, { maxBytes: this.quota, maxByteStringBytes: this.quota, maxItems: 32 });
      if (!Array.isArray(row) || row.length !== 6 || row[0] !== "chronolog/event-record/v1" || row[1] !== BigInt(index) || row[2] !== null && (!(row[2] instanceof Uint8Array) || row[2].length !== 32) || !(row[3] instanceof Uint8Array) || !(row[4] instanceof Uint8Array) || !(row[5] instanceof Uint8Array)) throw new Error("EVENT_EXECUTION_STORE_INVALID");
      order[index] = { txId: row[3], candidateDigest: row[4], canonicalCandidate: row[5], core: decodeTransactionCore(row[5]) };
      anchors[index] = hash;
      sizes[index] = node.length;
      tail = row[2];
    }
    if (tail !== null || sizes.reduce((sum, size) => sum + size, 0) !== Number(value[7])) throw new Error("EVENT_EXECUTION_STORE_INVALID");
    this.#anchors = anchors;
    let total = 0;
    this.#prefixBytes = sizes.map((size) => total += size);
    return { order, revision: value[2], finalLength: Number(value[3]), finalRevision: value[4] };
  }
  async commit(state, difference) {
    if (!Number.isSafeInteger(difference) || difference < 0 || difference > this.#anchors.length || difference > state.order.length || state.order.length > 1e5) throw new Error("EVENT_EXECUTION_STORE_INVALID");
    const anchors = this.#anchors.slice(0, difference), sizes = this.#prefixBytes.slice(0, difference);
    let tail = anchors.at(-1) ?? null, used = sizes.at(-1) ?? 0;
    const pendingWrites = [];
    for (let index = difference; index < state.order.length; index++) {
      const entry = state.order[index];
      const node = encodeCanonicalCbor([
        "chronolog/event-record/v1",
        BigInt(index),
        tail === null ? null : hexToBytes(tail),
        entry.txId,
        entry.candidateDigest,
        entry.canonicalCandidate
      ]);
      used += node.length;
      if (used > this.quota) throw new Error("EVENT_EXECUTION_QUOTA_EXCEEDED");
      const hash = bytesToHex(await sha256(node)), key = `${this.key}/node/${hash}`;
      const existing = await this.store.get(key);
      if (existing === null) pendingWrites.push({ key, value: node });
      else if (!equalBytes(existing, node)) throw new Error("EVENT_EXECUTION_RECORD_CORRUPT");
      anchors.push(hash);
      sizes.push(used);
      tail = hash;
    }
    const head = encodeCanonicalCbor([
      "chronolog/event-head/v2",
      this.digest,
      state.revision,
      BigInt(state.finalLength),
      state.finalRevision,
      BigInt(state.order.length),
      tail === null ? null : hexToBytes(tail),
      BigInt(used)
    ]);
    if (used + head.length > this.quota) throw new Error("EVENT_EXECUTION_QUOTA_EXCEEDED");
    pendingWrites.push({ key: this.key, value: head });
    for (let offset = 0; offset < pendingWrites.length; offset += 128) {
      await writeBytesMany(this.store, pendingWrites.slice(offset, offset + 128));
    }
    const superseded = this.#anchors.slice(difference);
    this.#anchors = anchors;
    this.#prefixBytes = sizes;
    if (superseded.length > 0 && this.store.delete !== void 0) {
      const active = new Set(anchors);
      for (const oldHash of superseded) {
        if (!active.has(oldHash)) {
          try {
            await this.store.delete(`${this.key}/node/${oldHash}`);
          } catch {
          }
        }
      }
    }
    return bytesToHex(await sha256(head));
  }
};

// packages/materializer/src/events.ts
async function createEventMaterializationRuntime(options) {
  if (options.namespace.length === 0) throw new Error("EVENT_EXECUTION_NAMESPACE_REQUIRED");
  const manifest = await eventExecutionManifest();
  const artifacts = await executionManifestArtifacts(manifest);
  const digest = artifacts.executionManifestDigest;
  const key = `event-execution/${options.namespace}`;
  const quota = options.maxHistoryBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(quota) || quota < 1024) throw new Error("EVENT_EXECUTION_QUOTA_INVALID");
  let revision = 0n, finalRevision = 0n, finalLength = 0;
  let order = [];
  let outcomes = [];
  let closed = false;
  let tail = Promise.resolve();
  const subscribers = /* @__PURE__ */ new Set();
  const snapshot = () => ({ revision, orderLength: order.length, executionManifestDigest: digest.slice() });
  const serial = async (task) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (closed) throw new Error("EVENT_EXECUTION_CLOSED");
      return await task();
    } finally {
      release();
    }
  };
  const storage = new EventHistoryStore(options.store, key, digest, quota);
  const verifiedInputs = /* @__PURE__ */ new WeakMap();
  let knownOperations = /* @__PURE__ */ new Set(), knownTransactions = /* @__PURE__ */ new Set(), knownProposals = /* @__PURE__ */ new Set();
  const rebuildIndices = (entries) => {
    knownOperations = /* @__PURE__ */ new Set();
    knownTransactions = /* @__PURE__ */ new Set();
    knownProposals = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      knownTransactions.add(bytesToHex(entry.txId));
      knownProposals.add(bytesToHex(entry.candidateDigest));
      knownOperations.add(`${bytesToHex(entry.core.authorId)}/${entry.core.operationId}`);
    }
  };
  const evaluateRange = async (next, start, operations, transactions, proposals) => {
    const result = [];
    for (let index = start; index < next.length; index++) {
      const entry = next[index];
      const core = entry.core;
      if (index > 0 && compareTransactionOrder(transactionOrderKey(next[index - 1].core, next[index - 1].txId), transactionOrderKey(core, entry.txId)) >= 0) throw new Error("EVENT_EXECUTION_ORDER_INVALID");
      if (!equalBytes(entry.txId, entry.candidateDigest)) {
        throw new Error("EVENT_EXECUTION_INPUT_INVALID");
      }
      if (!equalBytes(core.executionManifestDigest, digest)) throw new Error("EVENT_EXECUTION_PROFILE_UNAVAILABLE");
      if (!equalBytes(encodeTransactionCore(core), entry.canonicalCandidate) || !equalBytes(await transactionDigest(entry.canonicalCandidate), entry.candidateDigest)) throw new Error("EVENT_EXECUTION_INPUT_INVALID");
      assertValidChangeProgram(core.program);
      const transactionId = bytesToHex(entry.txId), proposalId = bytesToHex(entry.candidateDigest);
      if (transactions.has(transactionId)) throw new Error("EVENT_EXECUTION_DUPLICATE_TRANSACTION");
      if (proposals.has(proposalId)) throw new Error("EVENT_EXECUTION_DUPLICATE_PROPOSAL");
      transactions.add(transactionId);
      proposals.add(proposalId);
      const orderKey = transactionOrderKey(core, entry.txId);
      const operation = `${bytesToHex(core.authorId)}/${core.operationId}`;
      const failing = core.program.steps.findIndex((step) => !isEmitStep(step));
      const code = operations.has(operation) ? "operation_conflict" : failing >= 0 ? "profile:sql-disabled" : null;
      operations.add(operation);
      result.push({
        txId: entry.txId.slice(),
        orderKey,
        orderIndex: index,
        outcome: code === null ? "accepted" : "rejected",
        rejectionCode: code,
        failingStatementIndex: code === "profile:sql-disabled" ? failing : null
      });
    }
    return result;
  };
  const persisted = await storage.load();
  if (persisted !== null) {
    revision = persisted.revision;
    finalLength = persisted.finalLength;
    finalRevision = persisted.finalRevision;
    order = [...persisted.order];
    outcomes = await evaluateRange(order, 0, knownOperations, knownTransactions, knownProposals);
  }
  let outcomeIndex = new Map(outcomes.map((outcome) => [bytesToHex(outcome.txId), outcome]));
  const persist = async (state, difference) => {
    try {
      return await storage.commit(state, difference);
    } catch (error) {
      closed = true;
      subscribers.clear();
      throw error;
    }
  };
  const captureApplication = (input = {}) => {
    if (closed) throw new Error("EVENT_EXECUTION_CLOSED");
    const view = input.view ?? "local";
    const length = view === "final" ? finalLength : order.length;
    const selected = order, selectedOutcomes = outcomes;
    return {
      view,
      revision: view === "final" ? finalRevision : revision,
      orderLength: length,
      finalRevision,
      finalOrderLength: finalLength,
      transactionAt(index) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= length) return null;
        const entry = selected[index];
        return { txId: entry.txId.slice(), canonicalCandidate: entry.canonicalCandidate.slice(), outcome: selectedOutcomes[index].outcome };
      }
    };
  };
  return {
    replay: {
      materialize: async (input) => {
        const snapshotInput = input.map((entry) => verifiedInputs.has(entry) ? entry : structuredClone(entry));
        return serial(async () => {
          for (let index = 0; index < snapshotInput.length; index++) {
            const current = snapshotInput[index];
            if (!equalBytes(current.txId, current.candidateDigest)) throw new Error("EVENT_EXECUTION_INPUT_INVALID");
            const previous = snapshotInput[index - 1];
            if (previous !== void 0 && compareTransactionOrder(transactionOrderKey(previous.core, previous.txId), transactionOrderKey(current.core, current.txId)) >= 0) throw new Error("EVENT_EXECUTION_ORDER_INVALID");
          }
          let difference = 0;
          while (difference < order.length && difference < snapshotInput.length) {
            const incoming = snapshotInput[difference], retained = order[difference];
            if (verifiedInputs.get(incoming) === retained) {
              difference++;
              continue;
            }
            if (!sameIdentity(retained, incoming)) break;
            if (!equalBytes(encodeTransactionCore(incoming.core), incoming.canonicalCandidate)) {
              throw new Error("EVENT_EXECUTION_INPUT_INVALID");
            }
            difference++;
          }
          if (difference < finalLength) throw new Error("EVENT_EXECUTION_FINAL_PREFIX_CHANGED");
          const suffix = snapshotInput.slice(difference);
          const next = difference === order.length && suffix.length === 0 ? order : [...order.slice(0, difference), ...suffix];
          const pureAppend = difference === order.length;
          const operations = pureAppend ? new Set(knownOperations) : /* @__PURE__ */ new Set();
          const transactions = pureAppend ? new Set(knownTransactions) : /* @__PURE__ */ new Set();
          const proposals = pureAppend ? new Set(knownProposals) : /* @__PURE__ */ new Set();
          if (!pureAppend) {
            for (let i = 0; i < difference; i++) {
              const entry = order[i];
              transactions.add(bytesToHex(entry.txId));
              proposals.add(bytesToHex(entry.candidateDigest));
              operations.add(`${bytesToHex(entry.core.authorId)}/${entry.core.operationId}`);
            }
          }
          const suffixOutcomes = await evaluateRange(next, difference, operations, transactions, proposals);
          if (pureAppend && suffix.length === 0) return null;
          if (!pureAppend) {
            const previousById = new Map(order.map((entry) => [bytesToHex(entry.txId), entry]));
            for (const entry of suffix) {
              const previous = previousById.get(bytesToHex(entry.txId));
              if (previous !== void 0 && !sameIdentity(previous, entry)) throw new Error("EVENT_EXECUTION_IDENTITY_CONFLICT");
            }
          }
          const nextOutcomes = [...outcomes.slice(0, difference), ...suffixOutcomes];
          const previousRevision = revision;
          const nextRevision = revision + 1n;
          const changes = [];
          if (pureAppend) {
            for (const current of suffixOutcomes) {
              changes.push({
                txId: current.txId.slice(),
                previous: null,
                current: current.outcome,
                previousRejectionCode: null,
                currentRejectionCode: current.rejectionCode
              });
            }
          } else {
            for (const current of suffixOutcomes) {
              const before = outcomeIndex.get(bytesToHex(current.txId));
              if (before?.outcome !== current.outcome || before.rejectionCode !== current.rejectionCode) {
                changes.push({
                  txId: current.txId.slice(),
                  previous: before?.outcome ?? null,
                  current: current.outcome,
                  previousRejectionCode: before?.rejectionCode ?? null,
                  currentRejectionCode: current.rejectionCode
                });
              }
            }
            const selected = new Set(next.map((entry) => bytesToHex(entry.txId)));
            for (let i = difference; i < outcomes.length; i++) {
              const removed = outcomes[i];
              if (!selected.has(bytesToHex(removed.txId))) changes.push({
                txId: removed.txId.slice(),
                previous: removed.outcome,
                current: null,
                previousRejectionCode: removed.rejectionCode,
                currentRejectionCode: null
              });
            }
          }
          const contentHash = await persist({ order: next, revision: nextRevision, finalLength, finalRevision }, difference);
          for (let i = 0; i < suffix.length; i++) verifiedInputs.set(snapshotInput[difference + i], suffix[i]);
          order = next;
          outcomes = nextOutcomes;
          revision = nextRevision;
          knownOperations = operations;
          knownTransactions = transactions;
          knownProposals = proposals;
          if (pureAppend) {
            for (const outcome of suffixOutcomes) outcomeIndex.set(bytesToHex(outcome.txId), outcome);
          } else {
            outcomeIndex = new Map(outcomes.map((outcome) => [bytesToHex(outcome.txId), outcome]));
            rebuildIndices(order);
          }
          const result = {
            revision,
            previousRevision,
            orderLength: order.length,
            replayFromIndex: difference,
            replayedTransactions: order.length - difference,
            checkpointPrefix: difference,
            contentHash,
            manifestDigest: digest.slice(),
            earliestChangedOrderIndex: difference,
            outcomeChanges: changes
          };
          for (const subscriber of [...subscribers]) {
            try {
              subscriber(snapshot());
            } catch {
            }
          }
          return { revision: result, publication: publicationRequestForRevision(result) };
        });
      },
      publishFinal: (length) => serial(async () => {
        if (!Number.isSafeInteger(length) || length < finalLength || length > order.length) throw new Error("EVENT_EXECUTION_FINAL_PREFIX_INVALID");
        if (length === finalLength) return;
        await persist({ order, revision, finalLength: length, finalRevision: finalRevision + 1n }, order.length);
        finalLength = length;
        finalRevision++;
      })
    },
    queries: {
      capabilities: Object.freeze({ sql: false }),
      get revision() {
        return revision;
      },
      get orderLength() {
        return order.length;
      },
      get finalRevision() {
        return finalRevision;
      },
      get finalOrderLength() {
        return finalLength;
      },
      get executionManifestDigest() {
        return digest.slice();
      },
      proposalIdAt(index) {
        return order[index]?.txId.slice() ?? null;
      },
      localSql() {
        throw new Error("SQL_DISABLED_FOR_EVENT_PROFILE");
      },
      outcome(id) {
        return structuredClone(outcomeIndex.get(bytesToHex(id)) ?? null);
      },
      subscribe(subscriber) {
        subscribers.add(subscriber);
        return () => {
          subscribers.delete(subscriber);
        };
      },
      captureApplication,
      captureRead(input = {}) {
        const application = captureApplication(input);
        let released = false;
        return {
          ...application,
          query() {
            if (released) throw new Error("VIEW_RELEASED");
            throw new Error("SQL_DISABLED_FOR_EVENT_PROFILE");
          },
          release() {
            released = true;
          }
        };
      }
    },
    publications: {
      async publish(request) {
        if (closed) throw new Error("EVENT_EXECUTION_CLOSED");
        if (request.targetRevision !== revision || request.targetOrderLength !== order.length) throw new Error("EVENT_EXECUTION_PUBLICATION_MISMATCH");
        return { status: "already_current", publicationKey: request.publicationKey, ...snapshot() };
      },
      async reconcile(expected) {
        if (closed) throw new Error("EVENT_EXECUTION_CLOSED");
        if (expected.targetOrderLength !== order.length || expected.targetRevision !== void 0 && expected.targetRevision !== revision) throw new Error("EVENT_EXECUTION_RECONCILIATION_MISMATCH");
        return { status: "reconciled", publicationKey: null, ...snapshot() };
      }
    },
    close() {
      closed = true;
      subscribers.clear();
    }
  };
}
function sameIdentity(left, right) {
  return equalBytes(left.txId, right.txId) && equalBytes(left.candidateDigest, right.candidateDigest) && equalBytes(left.canonicalCandidate, right.canonicalCandidate);
}

export {
  publicationRequestForRevision,
  createEventMaterializationRuntime
};
