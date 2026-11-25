import {
  publicationRequestForRevision
} from "./chunk-JQFYN2T4.mjs";
import {
  DOMAINS,
  GROUP_COLLECTIVE_ID,
  bytesToBase64Url,
  canonicalJson,
  compareTransactionOrder,
  createExecutionManifest,
  decodeRowKey,
  decodeTransactionCore,
  encodeSealedEnvelope,
  encodeTransactionCore,
  executionManifestArtifacts,
  hashDomain,
  isEmitStep,
  isPlatformOp,
  isSealedPlatformOp,
  platformObjectIdHashInput,
  transactionDigest,
  utf8 as utf82
} from "./chunk-MAGRVNAE.mjs";
import {
  bytesToHex,
  createSha256,
  encodeCanonicalCbor,
  equalBytes,
  sha256Sync,
  utf8
} from "./chunk-HYFY2E3E.mjs";

// packages/materializer-doltlite/src/checkpoints.ts
var HEAD_BRANCH = "chronolog_head";
var FINAL_BRANCH = "chronolog_final";
var FINAL_PREFIX = "chronolog_final_rev_";
var FINAL_PATTERN = /^chronolog_final_rev_r([0-9]+)_p([0-9]+)_([0-9a-f]{16})$/u;
var CHECKPOINT_PREFIX = "chronolog_cp_";
var REVISION_PREFIX = "chronolog_rev_";
var REPLAY_PREFIX = "chronolog_replay_";
var CHECKPOINT_PATTERN = /^chronolog_cp_p([0-9]+)_r([0-9]+)_([0-9a-f]{16})$/u;
var REVISION_PATTERN = /^chronolog_rev_r([0-9]+)_p([0-9]+)_([0-9a-f]{16})$/u;
function discoverFinalRef(database) {
  const branches = database.doltBranches();
  const head = branches.find((branch) => branch.name === FINAL_BRANCH);
  if (head === void 0) return null;
  const matches = branches.filter((branch) => branch.hash === head.hash && FINAL_PATTERN.test(branch.name));
  if (matches.length !== 1) throw new Error("MATERIALIZER_FINAL_REVISION_REF_INVALID");
  const marker = matches[0];
  const match = FINAL_PATTERN.exec(marker.name);
  return {
    revision: BigInt(match[1]),
    prefixLength: safeInteger(match[2], "MATERIALIZER_FINAL_PREFIX_INVALID"),
    branchRef: marker.name,
    doltCommitHash: marker.hash,
    contentHash: database.doltHashOf(FINAL_BRANCH),
    orderDigest: match[3]
  };
}
function publishFinalRef(database, revision, log, commitHash) {
  const digest = orderDigest(log);
  const branchRef = `${FINAL_PREFIX}r${revision}_p${log.length}_${digest}`;
  if (!database.doltBranches().some((branch) => branch.name === branchRef)) database.doltBranch(branchRef, commitHash);
  const result = {
    revision,
    prefixLength: log.length,
    branchRef,
    doltCommitHash: commitHash,
    contentHash: database.doltHashOf(commitHash),
    orderDigest: digest
  };
  database.doltForceBranch(FINAL_BRANCH, commitHash);
  return result;
}
function discoverPublishedRef(database) {
  const branches = database.doltBranches();
  const head = branches.find((branch) => branch.name === HEAD_BRANCH);
  if (head === void 0) return null;
  const matching = branches.map((branch) => ({ branch, parsed: parseRevisionBranch(branch) })).filter(
    (entry) => entry.parsed !== null && entry.branch.hash === head.hash
  );
  if (matching.length !== 1) throw new Error("MATERIALIZER_PUBLISHED_REVISION_REF_INVALID");
  const marker = matching[0];
  return {
    ...marker.parsed,
    doltCommitHash: head.hash,
    contentHash: database.doltHashOf(HEAD_BRANCH)
  };
}
function discoverCheckpoints(database) {
  return database.doltBranches().map((branch) => {
    const match = CHECKPOINT_PATTERN.exec(branch.name);
    if (match === null) return null;
    const prefixLength = safeInteger(match[1], "MATERIALIZER_CHECKPOINT_PREFIX_INVALID");
    const createdAtRevision = BigInt(match[2]);
    return {
      prefixLength,
      branchRef: branch.name,
      doltCommitHash: branch.hash,
      contentHash: database.doltHashOf(branch.name),
      createdAtRevision
    };
  }).filter((value) => value !== null).sort((left, right) => left.prefixLength - right.prefixLength);
}
function checkpointOrderDigest(branchRef) {
  const match = CHECKPOINT_PATTERN.exec(branchRef);
  if (match === null) throw new Error("MATERIALIZER_CHECKPOINT_REF_INVALID");
  return match[3];
}
function createCheckpointRef(database, prefixLength, revision, commitHash, log) {
  const digest = orderDigest(log);
  const branchRef = checkpointBranch(prefixLength, revision, digest);
  database.doltBranch(branchRef, commitHash);
  return {
    prefixLength,
    branchRef,
    doltCommitHash: commitHash,
    contentHash: database.doltHashOf(branchRef),
    createdAtRevision: revision
  };
}
function createRevisionRef(database, revision, prefixLength, commitHash, log) {
  const digest = orderDigest(log);
  const branchRef = revisionBranch(revision, prefixLength, digest);
  database.doltBranch(branchRef, commitHash);
  return {
    revision,
    prefixLength,
    branchRef,
    doltCommitHash: commitHash,
    contentHash: database.doltHashOf(branchRef),
    orderDigest: digest
  };
}
function createReplayBranch(database, revision, fromRef) {
  const nonce = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(6)));
  const branch = `${REPLAY_PREFIX}r${revision}_${nonce}`;
  database.doltBranch(branch, fromRef);
  return branch;
}
function publishRef(database, published) {
  database.doltForceBranch(HEAD_BRANCH, published.doltCommitHash);
}
function removeBranchIfPresent(database, branchRef) {
  if (database.doltBranches().some((branch) => branch.name === branchRef)) {
    database.doltDeleteBranch(branchRef);
  }
}
function cleanupOrphanBranches(database, published, retainedCheckpoints, retainedReaders = []) {
  const retained = /* @__PURE__ */ new Set([
    HEAD_BRANCH,
    published.branchRef,
    ...retainedReaders,
    ...retainedCheckpoints.map((checkpoint) => checkpoint.branchRef)
  ]);
  const active = database.doltActiveBranch();
  for (const branch of database.doltBranches()) {
    if (branch.name !== active && !retained.has(branch.name) && (branch.name.startsWith(REPLAY_PREFIX) || branch.name.startsWith(REVISION_PREFIX) || branch.name.startsWith("chronolog_read_"))) {
      database.doltDeleteBranch(branch.name);
    }
  }
}
function orderDigest(log) {
  const hash = createSha256();
  for (const row of log) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, row.txId.length, false);
    hash.update(length);
    hash.update(row.txId);
  }
  return bytesToHex(hash.digest()).slice(0, 16);
}
function verifyPublishedLog(published, log) {
  if (log.length !== published.prefixLength || orderDigest(log) !== published.orderDigest) {
    throw new Error("MATERIALIZER_PUBLISHED_LOG_MISMATCH");
  }
}
function checkpointBranch(prefix, revision, digest) {
  return `${CHECKPOINT_PREFIX}p${prefix}_r${revision}_${digest}`;
}
function revisionBranch(revision, prefix, digest) {
  return `${REVISION_PREFIX}r${revision}_p${prefix}_${digest}`;
}
function parseRevisionBranch(branch) {
  const match = REVISION_PATTERN.exec(branch.name);
  if (match === null) return null;
  return {
    revision: BigInt(match[1]),
    prefixLength: safeInteger(match[2], "MATERIALIZER_REVISION_PREFIX_INVALID"),
    branchRef: branch.name,
    orderDigest: match[3]
  };
}
function safeInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

// packages/materializer-doltlite/src/sql-profile.ts
var SQLITE_OK = 0;
var SQLITE_DENY = 1;
var SQLITE_AUTH = 23;
var SQLITE_INTERRUPT = 9;
var OPERATIONAL_SQLITE_CODES = /* @__PURE__ */ new Set([
  2,
  // SQLITE_INTERNAL
  3,
  // SQLITE_PERM
  4,
  // SQLITE_ABORT
  5,
  // SQLITE_BUSY
  6,
  // SQLITE_LOCKED
  7,
  // SQLITE_NOMEM
  8,
  // SQLITE_READONLY
  9,
  // SQLITE_INTERRUPT (deterministic budget interrupts are wrapped earlier)
  10,
  // SQLITE_IOERR
  11,
  // SQLITE_CORRUPT
  12,
  // SQLITE_NOTFOUND
  13,
  // SQLITE_FULL
  14,
  // SQLITE_CANTOPEN
  15,
  // SQLITE_PROTOCOL
  17,
  // SQLITE_SCHEMA after automatic reprepare failed
  21,
  // SQLITE_MISUSE
  24,
  // SQLITE_FORMAT
  26
  // SQLITE_NOTADB
]);
var ACTION = {
  CREATE_INDEX: 1,
  CREATE_TABLE: 2,
  CREATE_TEMP_INDEX: 3,
  CREATE_TEMP_TABLE: 4,
  CREATE_TEMP_TRIGGER: 5,
  CREATE_TEMP_VIEW: 6,
  CREATE_TRIGGER: 7,
  CREATE_VIEW: 8,
  DELETE: 9,
  DROP_INDEX: 10,
  DROP_TABLE: 11,
  DROP_TEMP_INDEX: 12,
  DROP_TEMP_TABLE: 13,
  DROP_TEMP_TRIGGER: 14,
  DROP_TEMP_VIEW: 15,
  DROP_TRIGGER: 16,
  DROP_VIEW: 17,
  INSERT: 18,
  PRAGMA: 19,
  READ: 20,
  SELECT: 21,
  TRANSACTION: 22,
  UPDATE: 23,
  ATTACH: 24,
  DETACH: 25,
  ALTER_TABLE: 26,
  REINDEX: 27,
  ANALYZE: 28,
  CREATE_VTABLE: 29,
  DROP_VTABLE: 30,
  FUNCTION: 31,
  SAVEPOINT: 32,
  RECURSIVE: 33
};
var SQLITE_LIMIT_CATEGORY = {
  LENGTH: 0,
  SQL_LENGTH: 1,
  COLUMN: 2,
  EXPR_DEPTH: 3,
  COMPOUND_SELECT: 4,
  VDBE_OP: 5,
  FUNCTION_ARG: 6,
  ATTACHED: 7,
  LIKE_PATTERN_LENGTH: 8,
  VARIABLE_NUMBER: 9,
  TRIGGER_DEPTH: 10,
  WORKER_THREADS: 11
};
var DEFAULT_SQL_RUNTIME_LIMITS = {
  maxSqlBytes: 1e6,
  maxVmSteps: 1e6,
  progressGranularity: 1e3,
  maxValueBytes: 16 * 1024 * 1024,
  maxResultRows: 1e4
};
var SQL_PROFILE_VERSION = "chronolog-portable-sql-policy-v3";
var READ_ONLY_PRAGMAS = /* @__PURE__ */ new Set([
  "foreign_key_list",
  "index_info",
  "index_list",
  "index_xinfo",
  "table_info",
  "table_list",
  "table_xinfo",
  // SQLite runs quick_check itself while executing ALTER TABLE ... ADD COLUMN.
  "quick_check"
]);
var LOCAL_DIAGNOSTIC_PRAGMAS = /* @__PURE__ */ new Set([
  "collation_list",
  "compile_options",
  "function_list",
  "module_list",
  "pragma_list"
]);
var REPLICATED_DENIED_FUNCTIONS = /* @__PURE__ */ new Set([
  "load_extension",
  "total_changes",
  "sqlite_offset",
  "active_branch",
  "sqlite_compileoption_get",
  "sqlite_compileoption_used",
  "sqlite_source_id"
]);
var REPLICATED_DENIED_MODULES = /* @__PURE__ */ new Set(["dbstat", "sqlite_dbpage", "sqlite_stmt"]);
var FORBIDDEN_LOCAL_READ_FUNCTIONS = /* @__PURE__ */ new Set([
  "active_branch",
  "load_extension"
]);
var MODULE_INTERNAL_PRAGMAS = /* @__PURE__ */ new Set(["data_version", "page_size"]);
var POLICY_VIOLATION_FUNCTION = "chronolog_policy_violation";
var OWNER_COLUMN = "chronolog_owner";
function isReservedSchemaObjectName(value) {
  const key = asciiLower(value);
  return key.startsWith("_cf_") || key.startsWith("chronolog_") || key.startsWith("sqlite_") || key.startsWith("dolt_") || key.startsWith("doltlite_") || key.startsWith("pragma_") || REPLICATED_DENIED_MODULES.has(key);
}
var SqlProfileError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "SqlProfileError";
  }
  code;
};
var NativeSqlRejection = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "NativeSqlRejection";
  }
  code;
};
function normalizeSqlRuntimeLimits(input = {}) {
  const limits = { ...DEFAULT_SQL_RUNTIME_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new SqlProfileError(`SQL_INVALID_LIMIT_${name.toUpperCase()}`);
    }
  }
  if (limits.progressGranularity > limits.maxVmSteps) {
    throw new SqlProfileError("SQL_INVALID_LIMIT_PROGRESS_GRANULARITY");
  }
  return limits;
}
function configureSqliteLimits(database, input = {}) {
  const limits = normalizeSqlRuntimeLimits(input);
  const requested = /* @__PURE__ */ new Map([
    [SQLITE_LIMIT_CATEGORY.LENGTH, limits.maxValueBytes],
    [SQLITE_LIMIT_CATEGORY.SQL_LENGTH, limits.maxSqlBytes],
    [SQLITE_LIMIT_CATEGORY.COLUMN, 256],
    [SQLITE_LIMIT_CATEGORY.EXPR_DEPTH, 100],
    [SQLITE_LIMIT_CATEGORY.COMPOUND_SELECT, 32],
    [SQLITE_LIMIT_CATEGORY.VDBE_OP, limits.maxVmSteps],
    [SQLITE_LIMIT_CATEGORY.FUNCTION_ARG, 64],
    [SQLITE_LIMIT_CATEGORY.ATTACHED, 0],
    [SQLITE_LIMIT_CATEGORY.LIKE_PATTERN_LENGTH, 1e4],
    [SQLITE_LIMIT_CATEGORY.VARIABLE_NUMBER, 1e3],
    [SQLITE_LIMIT_CATEGORY.TRIGGER_DEPTH, 16],
    [SQLITE_LIMIT_CATEGORY.WORKER_THREADS, 0]
  ]);
  const applied = /* @__PURE__ */ new Map();
  for (const [category, requestedValue] of requested) {
    database.setLimit(category, requestedValue);
    const actual = database.setLimit(category, -1);
    if (actual !== requestedValue) throw new SqlProfileError("SQL_NATIVE_LIMIT_MISMATCH");
    applied.set(category, actual);
  }
  return applied;
}
function assertNativeSecurityConfiguration(config) {
  if (!config.defensive || !config.trustedSchema || !config.loadExtension || !config.dqsDml || !config.dqsDdl || !config.qpsg || !config.ftsTokenizer || !config.writableSchema || !config.extendedResultCodes || !config.attachCreate || !config.attachWrite || !config.reverseScanOrder || !config.fpDigits) {
    throw new SqlProfileError("SQL_NATIVE_SECURITY_CONFIGURATION_FAILED");
  }
}
function withProfiledStatement(database, sql, mode, operation, inputLimits = {}, authorization = {}) {
  const limits = normalizeSqlRuntimeLimits(inputLimits);
  validateSqlSource(sql, limits);
  if (mode === "replicated" || mode === "local_read") assertProfilePragma(sql, mode);
  if (database.nativeProfile !== void 0) {
    if (mode !== "platform" && mode !== "local_read") throw new Error("MATERIALIZER_NATIVE_PROFILE_API_REQUIRED");
    const statement = database.nativeProfile.prepare(sql, mode, limits);
    try {
      return operation(statement);
    } finally {
      statement.finalize?.();
    }
  }
  const phase = { stepping: false };
  return withProfileControls(database, mode, limits, authorization, () => {
    let statement;
    try {
      statement = database.prepare(sql);
    } catch (error) {
      if (isSqlAuthorizationError(error) || isDeniedFeatureError(error, mode)) throw new SqlProfileError("SQL_PROFILE_VIOLATION");
      if (isOperationalSqliteError(error)) throw error;
      throw new SqlProfileError("SQL_PREPARE_FAILED");
    }
    try {
      validateSingleStatement(sql, statement);
      phase.stepping = true;
      return operation(statement);
    } finally {
      statement.finalize?.();
    }
  }, phase);
}
function withAuthorizer(database, mode, operation, authorization = {}) {
  if (database.nativeProfile !== void 0 && mode === "internal_bootstrap") return operation();
  database.setAuthorizer(createAuthorizer(mode, authorization));
  try {
    return operation();
  } catch (error) {
    if (isSqlAuthorizationError(error)) throw new SqlProfileError("SQL_PROFILE_VIOLATION");
    throw error;
  } finally {
    database.setAuthorizer(null);
  }
}
function withExecutionBudget(database, operation, inputLimits = {}) {
  const limits = normalizeSqlRuntimeLimits(inputLimits);
  let callbacks = 0;
  const maximumCallbacks = Math.max(1, Math.ceil(limits.maxVmSteps / limits.progressGranularity));
  let budgetExceeded = false;
  database.setProgressHandler(limits.progressGranularity, () => {
    callbacks += 1;
    budgetExceeded = callbacks >= maximumCallbacks;
    return budgetExceeded;
  });
  try {
    return operation();
  } catch (error) {
    if (budgetExceeded && sqlitePrimaryCode(error) === SQLITE_INTERRUPT) {
      throw new SqlProfileError("SQL_STEP_LIMIT");
    }
    throw error;
  } finally {
    database.setProgressHandler(0, null);
  }
}
function withProfileControls(database, mode, limits, authorization, operation, phase = { stepping: false }) {
  database.setAuthorizer(createAuthorizer(mode, authorization, phase));
  try {
    return withExecutionBudget(database, operation, limits);
  } catch (error) {
    if (isSqlAuthorizationError(error)) throw new SqlProfileError("SQL_PROFILE_VIOLATION");
    throw error;
  } finally {
    database.setAuthorizer(null);
  }
}
var DDL_ACTIONS = /* @__PURE__ */ new Set([
  ACTION.CREATE_INDEX,
  ACTION.CREATE_TABLE,
  ACTION.CREATE_TRIGGER,
  ACTION.CREATE_VIEW,
  ACTION.DROP_INDEX,
  ACTION.DROP_TABLE,
  ACTION.DROP_TRIGGER,
  ACTION.DROP_VIEW,
  ACTION.CREATE_VTABLE,
  ACTION.DROP_VTABLE,
  ACTION.ALTER_TABLE
]);
function createAuthorizer(mode, options = {}, phase = { stepping: false }) {
  const droppedTables = /* @__PURE__ */ new Set();
  const createdTables = /* @__PURE__ */ new Set();
  const virtualLifecycle = /* @__PURE__ */ new Set();
  const virtualInternal = (name) => phase.stepping && [...virtualLifecycle].some((parent) => name.startsWith(`${parent}_`));
  const includes = (operation, name) => options.ddlPermissions?.[operation].some((entry) => asciiLower(entry) === name) === true;
  const permitted = (action, object, target) => {
    if (action === ACTION.CREATE_TABLE || action === ACTION.CREATE_VIEW || action === ACTION.CREATE_VTABLE) return options.ddlPermissions?.create === true || virtualInternal(object);
    if (action === ACTION.ALTER_TABLE) return includes("alter", target) || virtualInternal(target);
    if (action === ACTION.CREATE_INDEX || action === ACTION.DROP_INDEX) return includes("index", target) || virtualInternal(target) || droppedTables.has(target) || action === ACTION.CREATE_INDEX && object.startsWith("sqlite_autoindex_") && (createdTables.has(target) || includes("alter", target));
    if (action === ACTION.CREATE_TRIGGER || action === ACTION.DROP_TRIGGER) return includes("trigger", target) || droppedTables.has(target);
    return includes("drop", object) || virtualInternal(object);
  };
  return (action, arg1, arg2, databaseName, triggerOrView) => {
    const objectName = asciiLower(arg1);
    const secondaryName = asciiLower(arg2);
    const database = asciiLower(databaseName);
    const caller = asciiLower(triggerOrView);
    if (mode === "internal_bootstrap") {
      return action === ACTION.ATTACH || action === ACTION.DETACH ? SQLITE_DENY : SQLITE_OK;
    }
    const platform = mode === "platform" && (caller === "" || caller.startsWith("chronolog_"));
    if (platform) {
      return action === ACTION.ATTACH || action === ACTION.DETACH || action === ACTION.TRANSACTION ? SQLITE_DENY : SQLITE_OK;
    }
    if (action === ACTION.SELECT || action === ACTION.RECURSIVE) return SQLITE_OK;
    if (action === ACTION.FUNCTION) {
      const functionName = secondaryName || objectName;
      if (isDoltName(functionName)) return SQLITE_DENY;
      if (functionName === POLICY_VIOLATION_FUNCTION) return caller.startsWith("chronolog_") ? SQLITE_OK : SQLITE_DENY;
      if (mode === "local_read") return FORBIDDEN_LOCAL_READ_FUNCTIONS.has(functionName) ? SQLITE_DENY : SQLITE_OK;
      if (functionName.startsWith("pragma_")) {
        return READ_ONLY_PRAGMAS.has(functionName.slice("pragma_".length)) ? SQLITE_OK : SQLITE_DENY;
      }
      return REPLICATED_DENIED_FUNCTIONS.has(functionName) ? SQLITE_DENY : SQLITE_OK;
    }
    if (action === ACTION.PRAGMA) {
      if (isReadOnlyPragma(objectName, mode)) return SQLITE_OK;
      const moduleInternal = caller === "" && secondaryName === "" && MODULE_INTERNAL_PRAGMAS.has(objectName);
      return moduleInternal ? SQLITE_OK : SQLITE_DENY;
    }
    if (action === ACTION.READ) {
      if (database !== "" && database !== "main" && database !== "temp") return SQLITE_DENY;
      if (mode !== "local_read" && (isDoltName(objectName) || REPLICATED_DENIED_MODULES.has(objectName))) return SQLITE_DENY;
      if (mode !== "local_read" && objectName.startsWith("pragma_") && !READ_ONLY_PRAGMAS.has(objectName.slice("pragma_".length))) return SQLITE_DENY;
      return SQLITE_OK;
    }
    if (mode === "local_read") {
      const moduleShadowWrite = (action === ACTION.INSERT || action === ACTION.UPDATE || action === ACTION.DELETE) && caller === "" && database === "main" && options.shadowTables?.has(objectName) === true;
      return moduleShadowWrite ? SQLITE_OK : SQLITE_DENY;
    }
    if (action === ACTION.UPDATE && database === "main" && options.lifecycleTriggers?.has(caller) === true) {
      if (objectName === "chronolog_grants" && secondaryName === "revoked_tx" || objectName === "chronolog_transfers" && (secondaryName === "state" || secondaryName === "closed_tx") || objectName === "chronolog_reader_policies" && (secondaryName === "closed_tx" || secondaryName === "row_key")) return SQLITE_OK;
    }
    if (action === ACTION.INSERT || action === ACTION.UPDATE || action === ACTION.DELETE) {
      if (objectName.startsWith("sqlite_")) return database === "main" || database === "temp" ? SQLITE_OK : SQLITE_DENY;
      if (database !== "main") return SQLITE_DENY;
      if (options.writeProtectedTables?.has(objectName) === true && !droppedTables.has(objectName) && !phase.stepping && (caller === "" || caller.startsWith("chronolog_"))) {
        return SQLITE_DENY;
      }
      return isReservedSchemaObjectName(objectName) ? SQLITE_DENY : SQLITE_OK;
    }
    if (action === ACTION.CREATE_TABLE && (objectName === "sqlite_stat1" || objectName === "sqlite_stat4" || objectName === "sqlite_sequence")) {
      return database === "main" ? SQLITE_OK : SQLITE_DENY;
    }
    if (DDL_ACTIONS.has(action) && !permitted(action, objectName, secondaryName)) return SQLITE_DENY;
    if (action === ACTION.CREATE_TABLE || action === ACTION.CREATE_INDEX || action === ACTION.CREATE_VIEW || action === ACTION.CREATE_TRIGGER || action === ACTION.DROP_TABLE || action === ACTION.DROP_INDEX || action === ACTION.DROP_VIEW || action === ACTION.DROP_TRIGGER) {
      if (database !== "main") return SQLITE_DENY;
      if (action === ACTION.CREATE_INDEX && objectName.startsWith("sqlite_autoindex_")) {
        return isReservedSchemaObjectName(secondaryName) ? SQLITE_DENY : SQLITE_OK;
      }
      if (action === ACTION.DROP_TRIGGER && objectName.startsWith("chronolog_") && droppedTables.has(secondaryName)) return SQLITE_OK;
      if (isReservedSchemaObjectName(objectName)) return SQLITE_DENY;
      if (action === ACTION.DROP_TABLE || action === ACTION.DROP_VIEW) droppedTables.add(objectName);
      if (action === ACTION.CREATE_TABLE) createdTables.add(objectName);
      const onTable = action === ACTION.CREATE_INDEX || action === ACTION.CREATE_TRIGGER || action === ACTION.DROP_INDEX || action === ACTION.DROP_TRIGGER;
      return onTable && secondaryName !== "" && isReservedSchemaObjectName(secondaryName) ? SQLITE_DENY : SQLITE_OK;
    }
    if (action === ACTION.CREATE_VTABLE || action === ACTION.DROP_VTABLE) {
      if (database !== "main" || isReservedSchemaObjectName(objectName) || REPLICATED_DENIED_MODULES.has(secondaryName)) return SQLITE_DENY;
      virtualLifecycle.add(objectName);
      if (action === ACTION.DROP_VTABLE) droppedTables.add(objectName);
      return SQLITE_OK;
    }
    if (action === ACTION.ALTER_TABLE) {
      if (database === OWNER_COLUMN) return SQLITE_DENY;
      if (objectName !== "main" || isReservedSchemaObjectName(secondaryName)) return SQLITE_DENY;
      if (options.writeProtectedTables?.has(secondaryName) === true) virtualLifecycle.add(secondaryName);
      return SQLITE_OK;
    }
    if (action === ACTION.REINDEX || action === ACTION.ANALYZE) return SQLITE_OK;
    return SQLITE_DENY;
  };
}
function isDoltName(value) {
  return value.startsWith("dolt_") || value.startsWith("doltlite_");
}
function asciiLower(value) {
  if (value === null) return "";
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
  }
  return result;
}
function assertProfilePragma(sql, mode) {
  let rest = sql;
  for (; ; ) {
    const skipped = rest.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/u, "");
    if (skipped === rest) break;
    rest = skipped;
  }
  const unquoted = asciiLower(sql).replace(/["`[\]]/gu, "");
  for (const pragma of MODULE_INTERNAL_PRAGMAS) {
    if (unquoted.includes(`pragma_${pragma}`)) throw new SqlProfileError("SQL_PROFILE_VIOLATION");
  }
  rest = rest.replace(/^EXPLAIN(?:\s+QUERY\s+PLAN)?\s+/iu, "");
  if (!/^PRAGMA\b/iu.test(rest)) return;
  const match = /^PRAGMA\s+(?:main\s*\.\s*)?([A-Za-z_]+)\s*(?:\(\s*[^()]*\)\s*)?;?\s*$/iu.exec(rest);
  if (match === null || !isReadOnlyPragma(match[1].toLowerCase(), mode)) throw new SqlProfileError("SQL_PROFILE_VIOLATION");
}
function isReadOnlyPragma(name, mode) {
  return READ_ONLY_PRAGMAS.has(name) || mode === "local_read" && LOCAL_DIAGNOSTIC_PRAGMAS.has(name);
}
function isDeniedFeatureError(error, mode) {
  if (mode === "internal_bootstrap" || !(error instanceof Error)) return false;
  const arity = /\bwrong number of arguments to function ([A-Za-z_][A-Za-z_0-9]*)\(\)/iu.exec(error.message);
  if (arity !== null) return isDeniedFunction(asciiLower(arity[1]), mode);
  const match = /\bno such (function|table):\s*(?:(?:main|temp)\.)?([A-Za-z_][A-Za-z_0-9]*)\b/iu.exec(error.message);
  if (match === null) return false;
  const name = asciiLower(match[2]);
  if (match[1].toLowerCase() === "function") return isDeniedFunction(name, mode);
  return mode !== "local_read" && (isDoltName(name) || REPLICATED_DENIED_MODULES.has(name) || name.startsWith("pragma_") && !READ_ONLY_PRAGMAS.has(name.slice("pragma_".length)));
}
function isDeniedFunction(name, mode) {
  if (isDoltName(name)) return true;
  return mode === "local_read" ? FORBIDDEN_LOCAL_READ_FUNCTIONS.has(name) : REPLICATED_DENIED_FUNCTIONS.has(name);
}
function validateSqlSource(sql, limits) {
  if (sql.includes("\0")) throw new SqlProfileError("SQL_INVALID_SOURCE");
  let bytes2;
  try {
    bytes2 = utf82(sql);
  } catch {
    throw new SqlProfileError("SQL_INVALID_SOURCE");
  }
  if (bytes2.length > limits.maxSqlBytes) throw new SqlProfileError("SQL_STATEMENT_TOO_LARGE");
}
function validateSingleStatement(sql, statement) {
  if (!Number.isSafeInteger(statement.tailOffset) || statement.tailOffset < 0) {
    throw new SqlProfileError("SQL_STATEMENT_TAIL_UNAVAILABLE");
  }
  if (utf82(statement.sourceSQL).length !== statement.tailOffset) {
    throw new SqlProfileError("SQL_STATEMENT_TAIL_INVALID");
  }
  const tail = sql.slice(statement.sourceSQL.length);
  if (!isTriviaOnly(tail)) throw new SqlProfileError("SQL_MULTIPLE_STATEMENTS");
}
function isTriviaOnly(text) {
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (/\s/u.test(character) || character === ";") {
      index += 1;
      continue;
    }
    if (character === "-" && text[index + 1] === "-") {
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) return false;
      index = end + 2;
      continue;
    }
    return false;
  }
  return true;
}
function isSqlAuthorizationError(error) {
  const primary = sqlitePrimaryCode(error);
  if (primary === SQLITE_AUTH) return true;
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && /authoriz|not authorized/u.test(error.message);
}
function sqlitePrimaryCode(error) {
  if (typeof error !== "object" || error === null) return null;
  for (const property of ["sqliteCode", "errcode", "sqliteExtendedCode"]) {
    const value = error[property];
    if (typeof value === "number" && Number.isInteger(value)) return value & 255;
  }
  return null;
}
function isOperationalSqliteError(error) {
  const primary = sqlitePrimaryCode(error);
  return primary !== null && OPERATIONAL_SQLITE_CODES.has(primary);
}

// packages/materializer-doltlite/src/platform/tables.ts
var OWNER_COLUMN_TYPE = "INTEGER";
var OWNER_COLUMN_DEFAULT = "chronolog_actor_id()";
var OWNER_COLUMN_SQL = `${OWNER_COLUMN} ${OWNER_COLUMN_TYPE} NOT NULL DEFAULT (${OWNER_COLUMN_DEFAULT})`;
function quoteIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}
function quoteText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
function rows(database, sql, ...parameters) {
  return database.prepare(sql).all(...parameters).map((row) => {
    if (Array.isArray(row)) throw new Error("MATERIALIZER_EXPECTED_OBJECT_ROW");
    return row;
  });
}
function resolveTable(database, name) {
  const row = rows(database, `SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name = ? COLLATE NOCASE`, name)[0];
  return row === void 0 ? null : String(row.name);
}
function tableShape(database, name) {
  const columns = rows(database, `SELECT name, type, "notnull" AS not_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid`, name).map((row) => ({
    name: String(row.name),
    type: String(row.type),
    notNull: Number(row.not_null) === 1,
    defaultValue: typeof row.dflt_value === "string" ? row.dflt_value : null,
    primaryKey: Number(row.pk),
    hidden: Number(row.hidden)
  }));
  const primaryKey = columns.filter((column) => column.primaryKey > 0).sort((left, right) => left.primaryKey - right.primaryKey).map((column) => column.name);
  const grouped = /* @__PURE__ */ new Map();
  for (const row of rows(database, `SELECT id, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq`, name)) {
    const id = Number(row.id);
    const entry = grouped.get(id) ?? { table: String(row.table), from: [], to: [], onUpdate: String(row.on_update), onDelete: String(row.on_delete) };
    entry.from.push(String(row.from));
    entry.to.push(typeof row.to === "string" ? row.to : null);
    grouped.set(id, entry);
  }
  const singleIntegerKey = primaryKey.length === 1 && columns.find((column) => column.name === primaryKey[0])?.type.toUpperCase() === "INTEGER";
  const rowidPrimaryKey = singleIntegerKey && !rows(database, "SELECT origin FROM pragma_index_list(?)", name).some((row) => row.origin === "pk") ? primaryKey[0] : void 0;
  return { name, columns, primaryKey, foreignKeys: [...grouped.values()], ...rowidPrimaryKey === void 0 ? {} : { rowidPrimaryKey } };
}
function ownerColumn(shape) {
  return shape.columns.find((column) => column.name.toLowerCase() === OWNER_COLUMN);
}
function hasValidOwnerColumn(shape) {
  const column = ownerColumn(shape);
  return column !== void 0 && column.name === OWNER_COLUMN && column.hidden === 0 && column.type.toUpperCase() === OWNER_COLUMN_TYPE && column.notNull && column.defaultValue !== null && normalizeDefault(column.defaultValue) === OWNER_COLUMN_DEFAULT;
}
function normalizeDefault(value) {
  let text = value.trim();
  while (text.startsWith("(") && text.endsWith(")")) text = text.slice(1, -1).trim();
  return text.replace(/\s+/gu, "").toLowerCase();
}
function isOwnerComposite(foreignKey) {
  return foreignKey.from.some((column, index) => column.toLowerCase() === OWNER_COLUMN && foreignKey.to[index]?.toLowerCase() === OWNER_COLUMN);
}
var PASSIVE_ACTIONS = /* @__PURE__ */ new Set(["NO ACTION", "RESTRICT"]);
function foreignKeyViolation(shape) {
  for (const foreignKey of shape.foreignKeys) {
    const onUpdate = foreignKey.onUpdate.toUpperCase();
    const onDelete = foreignKey.onDelete.toUpperCase();
    const valid = isOwnerComposite(foreignKey) ? onUpdate === "CASCADE" && (onDelete === "CASCADE" || PASSIVE_ACTIONS.has(onDelete)) : PASSIVE_ACTIONS.has(onUpdate) && PASSIVE_ACTIONS.has(onDelete);
    if (!valid) return foreignKey.table;
  }
  return null;
}
function hasNonNullPrimaryKey(shape) {
  return shape.primaryKey.length > 0 && shape.primaryKey.length <= 64 && shape.primaryKey.every((name) => shape.rowidPrimaryKey === name || shape.columns.find((column) => column.name === name)?.notNull === true);
}
function rowKeyExpression(alias, primaryKey) {
  return `chronolog_row_key(${primaryKey.map((column) => column.toLowerCase() === OWNER_COLUMN ? `(SELECT key FROM chronolog_principals WHERE id = ${alias}.${quoteIdentifier(column)})` : `${alias}.${quoteIdentifier(column)}`).join(", ")})`;
}
function parseRowKey(key) {
  try {
    return decodeRowKey(key);
  } catch {
    throw new Error("MATERIALIZER_ROW_KEY_INVALID");
  }
}
function rowKeyFilter(alias, primaryKey) {
  const columns = primaryKey.map((column) => {
    const value = "CASE WHEN ? THEN CAST(? AS TEXT) ELSE ? END";
    return `${alias}.${quoteIdentifier(column)} IS ${column.toLowerCase() === OWNER_COLUMN ? `(SELECT id FROM chronolog_principals WHERE key = (${value}))` : `(${value})`}`;
  });
  return `${columns.join(" AND ")} AND ${rowKeyExpression(alias, primaryKey)} = ?`;
}
function rowKeyBindings(key, primaryKey) {
  const values = parseRowKey(key);
  if (values.length !== primaryKey.length) throw new Error("MATERIALIZER_ROW_KEY_INVALID");
  return [...values.flatMap((part) => {
    const value = part.kind === "null" ? null : part.kind === "real" ? Float64Array.of(part.value) : part.kind === "text" || part.kind === "blob" ? Uint8Array.from(part.value) : part.value;
    return [part.kind === "text" ? 1 : 0, value, value];
  }), key];
}
var PLATFORM_TRIGGER_EVENTS = ["ins", "upd", "del", "life_ins"];
function platformTriggerName(table, event) {
  return event.startsWith("life_") ? `chronolog_l_${table}_${event.slice(5)}` : `chronolog_k_${table}_${event}`;
}
function platformTriggers(shape) {
  const table = shape.name;
  const tableText = quoteText(table);
  const owner = quoteIdentifier(OWNER_COLUMN);
  const oldKey = rowKeyExpression("OLD", shape.primaryKey);
  const newKey = rowKeyExpression("NEW", shape.primaryKey);
  const violation = (command) => `SELECT ${POLICY_VIOLATION_FUNCTION}(${tableText}, '${command}')`;
  const header = (event, timing) => `CREATE TRIGGER ${quoteIdentifier(platformTriggerName(table, event))} BEFORE ${timing} ON ${quoteIdentifier(table)} FOR EACH ROW BEGIN`;
  const capColumns = shape.columns.filter((column) => column.hidden === 0 && column.name.toLowerCase() !== OWNER_COLUMN);
  const changed = capColumns.length === 0 ? "0" : `EXISTS (SELECT 1 FROM (VALUES ${capColumns.map((column) => `(${quoteText(column.name)}, NOT chronolog_value_equal(OLD.${quoteIdentifier(column.name)}, NEW.${quoteIdentifier(column.name)}))`).join(", ")}) WHERE column2 AND column1 NOT IN (SELECT value FROM json_each(g.columns)))`;
  const ownedBy = (ownerSql, operation) => `EXISTS (SELECT 1 FROM ${ownerIdsView(operation)} WHERE id = ${ownerSql})`;
  const transferring = (key) => `EXISTS (SELECT 1 FROM chronolog_exemptions AS e WHERE e.kind = 'transfer' AND e.tbl = ${tableText}
    AND (e.row_key = ${key} OR e.to_row_key = ${key}))`;
  const rekeyed = shape.primaryKey.filter((column) => column.toLowerCase() !== OWNER_COLUMN).map((column) => `NOT chronolog_value_equal(OLD.${quoteIdentifier(column)}, NEW.${quoteIdentifier(column)})`).join(" OR ") || "0";
  const insert = `${header("ins", "INSERT")}
  ${violation("insert")} WHERE CASE
    WHEN NEW.${owner} = chronolog_actor_id() THEN 0
    WHEN ${ownedBy(`NEW.${owner}`, "insert")} THEN 0
    WHEN EXISTS (SELECT 1 FROM ${grantsToMeView("insert")} AS g WHERE g.tbl = ${tableText} AND g.grantor = NEW.${owner} AND g.row_key IS NULL) THEN 0
    WHEN EXISTS (SELECT 1 FROM chronolog_exemptions AS e WHERE e.kind = 'seed' AND e.tbl = ${tableText}) THEN 0
    ELSE 1 END;
  ${violation("insert")} WHERE ${transferring(newKey)};
END`;
  const update = `${header("upd", "UPDATE")}
  ${violation("update")} WHERE CASE
    WHEN NEW.${owner} IS OLD.${owner} AND OLD.${owner} = chronolog_actor_id() THEN 0
    WHEN NEW.${owner} IS OLD.${owner} AND ${ownedBy(`OLD.${owner}`, "update")} THEN 0
    WHEN NEW.${owner} IS OLD.${owner} AND EXISTS (SELECT 1 FROM ${grantsToMeView("update")} AS g WHERE g.tbl = ${tableText} AND g.grantor = OLD.${owner}
      AND (g.row_key IS NULL OR g.row_key = ${oldKey})
      AND (g.columns IS NULL OR NOT ${changed})) THEN 0
    WHEN EXISTS (SELECT 1 FROM chronolog_exemptions AS e WHERE e.kind = 'transfer' AND e.tbl = ${tableText}
      AND e.from_owner = OLD.${owner} AND e.to_owner = NEW.${owner} AND e.row_key = ${oldKey}) THEN 0
    ELSE 1 END;
  ${violation("update")} WHERE (${rekeyed}) AND (${transferring(oldKey)} OR ${transferring(newKey)});
END`;
  const remove = `${header("del", "DELETE")}
  ${violation("delete")} WHERE CASE
    WHEN OLD.${owner} = chronolog_actor_id() THEN 0
    WHEN ${ownedBy(`OLD.${owner}`, "delete")} THEN 0
    WHEN EXISTS (SELECT 1 FROM ${grantsToMeView("delete")} AS g WHERE g.tbl = ${tableText} AND g.grantor = OLD.${owner}
      AND (g.row_key IS NULL OR g.row_key = ${oldKey})) THEN 0
    ELSE 1 END;
  ${violation("delete")} WHERE ${transferring(oldKey)};
END`;
  const ownerKey = (alias) => `(SELECT key FROM chronolog_principals WHERE id = ${alias}.${owner})`;
  const revoke = `UPDATE chronolog_grants SET revoked_tx = chronolog_transaction_id()
    WHERE tbl = ${tableText} AND row_key = ${oldKey} AND revoked_tx IS NULL;`;
  const cancel = (existing, next, condition = "1") => `UPDATE chronolog_transfers
    SET state = 'cancelled', closed_tx = chronolog_transaction_id() WHERE state = 'open' AND (
      ${existing ? `offer_id IN (SELECT offer_id FROM chronolog_transfer_scope WHERE tbl = ${tableText} AND row_key = ${oldKey}) OR` : ""}
      (tbl IS NULL AND from_owner IN (${[...existing ? [ownerKey("OLD")] : [], ...next ? [ownerKey("NEW")] : []].join(", ")}))) AND (${condition});`;
  const anyChange = `EXISTS (SELECT 1 FROM (VALUES ${shape.columns.filter((column) => column.hidden === 0).map((column) => `(NOT chronolog_value_equal(OLD.${quoteIdentifier(column.name)}, NEW.${quoteIdentifier(column.name)}))`).join(", ")}) WHERE column1)`;
  const ownershipOnly = `OLD.${owner} IS NOT NEW.${owner}${shape.primaryKey.filter((column) => column.toLowerCase() !== OWNER_COLUMN).map((column) => ` AND chronolog_value_equal(OLD.${quoteIdentifier(column)}, NEW.${quoteIdentifier(column)})`).join("")}`;
  const movePolicy = `UPDATE chronolog_reader_policies SET row_key = ${newKey}
    WHERE tbl = ${tableText} AND row_key = ${oldKey} AND closed_tx IS NULL AND (${oldKey} <> ${newKey}) AND (${ownershipOnly});`;
  const updatePolicy = `${closeReaderPolicySql(table, oldKey, `${oldKey} <> ${newKey} AND NOT (${ownershipOnly})`)}
    ${movePolicy}`;
  const lifecycle = (event, timing, when, body) => ({
    name: platformTriggerName(table, event),
    sql: `CREATE TRIGGER ${quoteIdentifier(platformTriggerName(table, event))} AFTER ${timing} ON ${quoteIdentifier(table)} FOR EACH ROW WHEN ${when} BEGIN
    ${body}
END`
  });
  return [
    { name: platformTriggerName(table, "ins"), sql: insert },
    { name: platformTriggerName(table, "upd"), sql: update.replace("\nEND", `
    ${sealedWriteGuard(shape, oldKey)}
    ${updatePolicy}
    ${revoke.replace(" AND revoked_tx IS NULL;", ` AND revoked_tx IS NULL AND (${oldKey} <> ${newKey} OR OLD.${owner} IS NOT NEW.${owner});`)}
    ${cancel(true, true, anyChange)}
END`) },
    { name: platformTriggerName(table, "del"), sql: remove.replace("\nEND", `
    ${closeReaderPolicySql(table, oldKey)}
    ${revoke}
    ${cancel(true, false)}
END`) },
    lifecycle("life_ins", "INSERT", `NOT EXISTS (SELECT 1 FROM chronolog_exemptions WHERE kind = 'seed' AND tbl = ${tableText})`, cancel(false, true))
  ];
}

// packages/materializer-doltlite/src/platform/sealed.ts
var SEALED_TABLES_SQL = [
  `CREATE TABLE chronolog_reader_keys (
    reader_key BLOB PRIMARY KEY NOT NULL CHECK (length(reader_key) = 32),
    hpke_public_key BLOB NOT NULL CHECK (length(hpke_public_key) = 32),
    updated_tx BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE chronolog_reader_policies (
    policy_id BLOB PRIMARY KEY NOT NULL CHECK (length(policy_id) = 32),
    tbl TEXT NOT NULL,
    row_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    created_tx BLOB NOT NULL,
    updated_tx BLOB NOT NULL,
    closed_tx BLOB
  ) STRICT`,
  `CREATE UNIQUE INDEX chronolog_reader_policy_active_row
     ON chronolog_reader_policies (tbl, row_key) WHERE closed_tx IS NULL`,
  `CREATE TABLE chronolog_policy_readers (
    policy_id BLOB NOT NULL REFERENCES chronolog_reader_policies (policy_id),
    reader_key BLOB NOT NULL CHECK (length(reader_key) = 32),
    hpke_public_key BLOB NOT NULL CHECK (length(hpke_public_key) = 32),
    PRIMARY KEY (policy_id, reader_key)
  ) STRICT`,
  `CREATE TABLE chronolog_sealed_values (
    policy_id BLOB NOT NULL REFERENCES chronolog_reader_policies (policy_id),
    slot TEXT NOT NULL,
    data_version INTEGER NOT NULL CHECK (data_version > 0),
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    envelope BLOB NOT NULL,
    updated_tx BLOB NOT NULL,
    PRIMARY KEY (policy_id, slot)
  ) STRICT`,
  // Exact, ephemeral authorization for an encrypted app-column update. Never seeded.
  `CREATE TABLE chronolog_sealed_write_exemptions (
    tbl TEXT NOT NULL,
    row_key TEXT NOT NULL,
    col TEXT NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (tbl, row_key, col)
  ) STRICT`
];
var SEEDABLE_SEALED_TABLES = [
  "chronolog_reader_keys",
  "chronolog_reader_policies",
  "chronolog_policy_readers",
  "chronolog_sealed_values"
];
function closeReaderPolicySql(table, oldKey, condition = "1") {
  return `UPDATE chronolog_reader_policies SET closed_tx = chronolog_transaction_id()
    WHERE tbl = ${quoteText(table)} AND row_key = ${oldKey} AND closed_tx IS NULL AND (${condition});`;
}
function sealedWriteGuard(shape, oldKey) {
  const columns = shape.columns.filter((column) => column.hidden === 0 && column.name.toLowerCase() !== OWNER_COLUMN && column.primaryKey === 0);
  if (columns.length === 0) return "";
  const tests = columns.map((column) => {
    const name = quoteIdentifier(column.name);
    return `(NOT chronolog_value_equal(OLD.${name}, NEW.${name})
      AND EXISTS (SELECT 1 FROM chronolog_reader_policies AS p
        JOIN chronolog_sealed_values AS v ON v.policy_id = p.policy_id
        WHERE p.tbl = ${quoteText(shape.name)} AND p.row_key = ${oldKey} AND p.closed_tx IS NULL AND v.slot = ${quoteText(column.name)})
      AND NOT EXISTS (SELECT 1 FROM chronolog_sealed_write_exemptions AS e
        WHERE e.tbl = ${quoteText(shape.name)} AND e.row_key = ${oldKey} AND e.col = ${quoteText(column.name)}
          AND chronolog_value_equal(e.value, NEW.${name})))`;
  });
  return `SELECT chronolog_policy_violation(${quoteText(shape.name)}, 'update') WHERE ${tests.join(" OR ")};`;
}
var SealedRejection = class extends Error {
  constructor(reason) {
    super(`platform:${reason}`);
    this.name = "SealedRejection";
  }
};
var reject = (reason) => {
  throw new SealedRejection(reason);
};
var SealedSession = class {
  constructor(database, host) {
    this.database = database;
    this.host = host;
  }
  database;
  host;
  execute(op, stepIndex) {
    switch (op.op) {
      case "register_reader_key":
        return this.registerKey(op.publicKey);
      case "reader_policy":
        return this.setPolicy(op, stepIndex);
      case "sealed_put":
        return this.put(op);
    }
  }
  registerKey(publicKey) {
    this.run(
      `INSERT INTO chronolog_reader_keys (reader_key, hpke_public_key, updated_tx) VALUES (?, ?, ?)
      ON CONFLICT (reader_key) DO UPDATE SET hpke_public_key = excluded.hpke_public_key, updated_tx = excluded.updated_tx`,
      this.host.actor,
      publicKey,
      this.host.txId
    );
  }
  setPolicy(op, stepIndex) {
    const shape = this.host.registered(op.table);
    const row = this.host.findRow(shape, op.rowKey) ?? reject("no_such_row");
    if (!this.host.administers(row.owner)) reject("not_owner");
    const existing = this.get(`SELECT policy_id, version FROM chronolog_reader_policies
      WHERE tbl = ? AND row_key = ? AND closed_tx IS NULL`, shape.name, row.key);
    let id;
    let version;
    if (existing === void 0) {
      if (op.expectedPolicyId !== void 0 || op.expectedVersion !== 0n) reject("reader_policy_stale");
      id = this.host.objectId(stepIndex);
      version = 1n;
      this.run(`INSERT INTO chronolog_reader_policies (policy_id, tbl, row_key, version, created_tx, updated_tx, closed_tx)
        VALUES (?, ?, ?, ?, ?, ?, NULL)`, id, shape.name, row.key, version, this.host.txId, this.host.txId);
    } else {
      id = bytes(existing.policy_id);
      version = integer(existing.version);
      if (op.expectedPolicyId === void 0 || !equalBytes(id, op.expectedPolicyId) || op.expectedVersion !== version) reject("reader_policy_stale");
      if (version === MAX_VERSION) reject("reader_policy_version_exhausted");
      version += 1n;
      this.run("UPDATE chronolog_reader_policies SET version = ?, updated_tx = ? WHERE policy_id = ?", version, this.host.txId, id);
      this.run("DELETE FROM chronolog_policy_readers WHERE policy_id = ?", id);
    }
    for (const reader of op.readers) {
      const key = this.get("SELECT hpke_public_key FROM chronolog_reader_keys WHERE reader_key = ?", reader);
      if (key === void 0) reject("reader_key_missing");
      this.run(
        "INSERT INTO chronolog_policy_readers (policy_id, reader_key, hpke_public_key) VALUES (?, ?, ?)",
        id,
        reader,
        bytes(key.hpke_public_key)
      );
    }
  }
  policy(id) {
    const row = this.get("SELECT tbl, row_key, version, closed_tx FROM chronolog_reader_policies WHERE policy_id = ?", id);
    if (row === void 0) reject("no_such_reader_policy");
    if (row.closed_tx !== null) reject("reader_policy_closed");
    const table = String(row.tbl);
    const rowKey = String(row.row_key);
    const shape = this.host.registered(table);
    const owner = this.host.ownerOf(shape, rowKey) ?? reject("reader_policy_stale");
    return { id, table, rowKey, version: integer(row.version), shape, owner };
  }
  put(op) {
    const policy = this.policy(op.policyId);
    if (policy.version !== op.expectedPolicyVersion) reject("reader_policy_stale");
    const column = policy.shape.columns.find((entry) => entry.name === op.slot);
    if (column === void 0 || column.hidden !== 0 || column.primaryKey !== 0 || column.name === OWNER_COLUMN || column.type.toUpperCase() !== "BLOB") {
      reject("sealed_column_invalid");
    }
    const current = this.get("SELECT data_version FROM chronolog_sealed_values WHERE policy_id = ? AND slot = ?", policy.id, op.slot);
    const version = current === void 0 ? 0n : integer(current.data_version);
    if (version !== op.expectedDataVersion) reject("sealed_value_stale");
    if (version === MAX_VERSION) reject("sealed_value_version_exhausted");
    const context = op.envelope.context;
    if (!equalBytes(context.groupId, this.host.groupId) || !equalBytes(context.policyId, policy.id) || context.policyVersion !== policy.version || context.slot !== op.slot || context.dataVersion !== version + 1n) reject("sealed_context_mismatch");
    const readers = this.all(`SELECT reader_key, hpke_public_key FROM chronolog_policy_readers WHERE policy_id = ? ORDER BY reader_key`, policy.id);
    if (readers.length === 0) reject("sealed_no_readers");
    if (readers.length !== op.envelope.wraps.length || readers.some((reader, index) => {
      const wrap = op.envelope.wraps[index];
      return !equalBytes(bytes(reader.reader_key), wrap.readerId) || !equalBytes(bytes(reader.hpke_public_key), wrap.publicKey);
    })) reject("sealed_readers_mismatch");
    const encoded = encodeSealedEnvelope(op.envelope);
    this.run("INSERT INTO chronolog_sealed_write_exemptions (tbl, row_key, col, value) VALUES (?, ?, ?, ?)", policy.table, policy.rowKey, op.slot, encoded);
    try {
      const changed = this.run(
        `UPDATE ${quoteIdentifier(policy.table)} SET ${quoteIdentifier(op.slot)} = ?
        WHERE ${rowKeyFilter(quoteIdentifier(policy.table), policy.shape.primaryKey)}`,
        encoded,
        ...rowKeyBindings(policy.rowKey, policy.shape.primaryKey)
      );
      if (Number(changed.changes) !== 1) reject("reader_policy_stale");
      const stillActive = this.get("SELECT version, closed_tx FROM chronolog_reader_policies WHERE policy_id = ?", policy.id);
      const actual = this.get(`SELECT ${quoteIdentifier(op.slot)} AS value FROM ${quoteIdentifier(policy.table)}
        WHERE ${rowKeyFilter(quoteIdentifier(policy.table), policy.shape.primaryKey)}`, ...rowKeyBindings(policy.rowKey, policy.shape.primaryKey));
      if (stillActive === void 0 || stillActive.closed_tx !== null || integer(stillActive.version) !== policy.version || !(actual?.value instanceof Uint8Array) || !equalBytes(actual.value, encoded)) reject("sealed_write_changed");
      this.run(
        `INSERT INTO chronolog_sealed_values (policy_id, slot, data_version, policy_version, envelope, updated_tx)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (policy_id, slot) DO UPDATE SET data_version = excluded.data_version,
        policy_version = excluded.policy_version, envelope = excluded.envelope, updated_tx = excluded.updated_tx`,
        policy.id,
        op.slot,
        version + 1n,
        policy.version,
        encoded,
        this.host.txId
      );
    } finally {
      this.run("DELETE FROM chronolog_sealed_write_exemptions");
    }
  }
  run(sql, ...parameters) {
    return withProfiledStatement(this.database, sql, "platform", (statement) => statement.run(...parameters), this.host.limits);
  }
  get(sql, ...parameters) {
    return withProfiledStatement(this.database, sql, "platform", (statement) => {
      statement.setReadBigInts?.(true);
      const row = statement.get(...parameters);
      if (Array.isArray(row)) throw new Error("MATERIALIZER_EXPECTED_OBJECT_ROW");
      return row;
    }, this.host.limits);
  }
  all(sql, ...parameters) {
    return withProfiledStatement(this.database, sql, "platform", (statement) => {
      statement.setReadBigInts?.(true);
      return statement.all(...parameters).map((row) => {
        if (Array.isArray(row)) throw new Error("MATERIALIZER_EXPECTED_OBJECT_ROW");
        return row;
      });
    }, this.host.limits);
  }
};
var MAX_VERSION = 0x7fffffffffffffffn;
function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new Error("MATERIALIZER_SEALED_BYTES_INVALID");
  return value;
}
function integer(value) {
  if (typeof value !== "number" && typeof value !== "bigint" || typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("MATERIALIZER_SEALED_INTEGER_INVALID");
  return BigInt(value);
}

// packages/materializer-doltlite/src/platform/schema.ts
var PLATFORM_TABLES_SQL = [
  `CREATE TABLE chronolog_ddl_namespaces (
    name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
    owner BLOB NOT NULL CHECK (length(owner) = 32)
  ) STRICT`,
  `CREATE TABLE chronolog_ddl_objects (
    name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('table', 'view', 'virtual')),
    owner BLOB NOT NULL CHECK (length(owner) = 32),
    created_tx BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE chronolog_ddl_grants (
    grant_id BLOB PRIMARY KEY NOT NULL CHECK (length(grant_id) = 32),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('namespace', 'object')),
    scope_name TEXT NOT NULL COLLATE NOCASE,
    grantor BLOB NOT NULL CHECK (length(grantor) = 32),
    grantee BLOB NOT NULL CHECK (length(grantee) = 32),
    operations TEXT NOT NULL,
    created_tx BLOB NOT NULL,
    revoked_tx BLOB
  ) STRICT`,
  `CREATE TABLE chronolog_platform (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    root_admin BLOB NOT NULL CHECK (length(root_admin) = 32),
    seeding_open INTEGER NOT NULL CHECK (seeding_open IN (0, 1))
  ) STRICT`,
  // Every owner as a small integer: row owner columns hold these ids, not
  // 32-byte keys. A key gets its id on first use (signing a transaction,
  // creating a collective, being seeded as an owner); ids never change.
  `CREATE TABLE chronolog_principals (
    id INTEGER PRIMARY KEY NOT NULL,
    key BLOB NOT NULL UNIQUE CHECK (length(key) = 32)
  ) STRICT`,
  `CREATE TABLE chronolog_tables (
    name TEXT PRIMARY KEY NOT NULL,
    registered_at_tx BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE chronolog_collectives (
    collective_id BLOB PRIMARY KEY NOT NULL CHECK (length(collective_id) = 32),
    kind TEXT NOT NULL CHECK (kind IN ('group', 'team')),
    insert_role TEXT NOT NULL CHECK (insert_role IN ('member', 'admin')),
    update_role TEXT NOT NULL CHECK (update_role IN ('member', 'admin')),
    delete_role TEXT NOT NULL CHECK (delete_role IN ('member', 'admin')),
    created_tx BLOB
  ) STRICT`,
  `CREATE TABLE chronolog_collective_members (
    collective_id BLOB NOT NULL REFERENCES chronolog_collectives (collective_id),
    member_key BLOB NOT NULL CHECK (length(member_key) = 32),
    role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
    state TEXT NOT NULL CHECK (state IN ('invited', 'active', 'left')),
    joined_tx BLOB,
    left_tx BLOB,
    PRIMARY KEY (collective_id, member_key)
  ) STRICT`,
  `CREATE INDEX chronolog_collective_members_by_key ON chronolog_collective_members (member_key, state)`,
  `CREATE TABLE chronolog_grants (
    grant_id BLOB PRIMARY KEY NOT NULL CHECK (length(grant_id) = 32),
    tbl TEXT NOT NULL,
    grantor BLOB NOT NULL CHECK (length(grantor) = 32),
    grantee_key BLOB NOT NULL CHECK (length(grantee_key) = 32),
    row_key TEXT,
    op_insert INTEGER NOT NULL CHECK (op_insert IN (0, 1)),
    op_update INTEGER NOT NULL CHECK (op_update IN (0, 1)),
    op_delete INTEGER NOT NULL CHECK (op_delete IN (0, 1)),
    columns TEXT CHECK (columns IS NULL OR json_valid(columns)),
    created_tx BLOB NOT NULL,
    revoked_tx BLOB,
    CHECK (row_key IS NULL OR op_insert = 0)
  ) STRICT`,
  `CREATE INDEX chronolog_grants_by_grantee ON chronolog_grants (grantee_key, tbl)`,
  `CREATE INDEX chronolog_live_grants_by_row ON chronolog_grants (tbl, row_key)
    WHERE revoked_tx IS NULL AND row_key IS NOT NULL`,
  `CREATE TABLE chronolog_transfers (
    offer_id BLOB PRIMARY KEY NOT NULL CHECK (length(offer_id) = 32),
    tbl TEXT,
    row_key TEXT,
    from_owner BLOB NOT NULL CHECK (length(from_owner) = 32),
    to_owner BLOB NOT NULL CHECK (length(to_owner) = 32),
    carry INTEGER NOT NULL CHECK (carry IN (0, 1)),
    scope_digest BLOB NOT NULL CHECK (length(scope_digest) = 32),
    state TEXT NOT NULL CHECK (state IN ('open', 'accepted', 'cancelled')),
    created_tx BLOB NOT NULL,
    closed_tx BLOB,
    CHECK ((tbl IS NULL) = (row_key IS NULL))
  ) STRICT`,
  `CREATE INDEX chronolog_open_transfers_by_owner ON chronolog_transfers (tbl, from_owner)
    WHERE state = 'open'`,
  `CREATE TABLE chronolog_transfer_scope (
    offer_id BLOB NOT NULL REFERENCES chronolog_transfers (offer_id),
    tbl TEXT NOT NULL,
    row_key TEXT NOT NULL,
    PRIMARY KEY (offer_id, tbl, row_key)
  ) STRICT`,
  `CREATE INDEX chronolog_transfer_scope_by_row ON chronolog_transfer_scope (tbl, row_key)`,
  // Written and emptied inside one platform operation; always empty between steps.
  `CREATE TABLE chronolog_exemptions (
    kind TEXT NOT NULL CHECK (kind IN ('transfer', 'seed')),
    tbl TEXT NOT NULL,
    row_key TEXT,
    to_row_key TEXT,
    from_owner INTEGER,
    to_owner INTEGER,
    CHECK (kind = 'seed' OR (row_key IS NOT NULL AND to_row_key IS NOT NULL
      AND from_owner IS NOT NULL AND to_owner IS NOT NULL))
  ) STRICT`,
  ...SEALED_TABLES_SQL
];
var OWNER_OPERATIONS = ["insert", "update", "delete"];
var ownerIdsView = (operation) => `chronolog_my_owner_ids_${operation}`;
var grantsToMeView = (operation) => `chronolog_grants_to_me_${operation}`;
var PLATFORM_VIEWS_SQL = OWNER_OPERATIONS.flatMap((operation) => [
  `CREATE VIEW ${ownerIdsView(operation)} (id) AS
    SELECT chronolog_actor_id() WHERE chronolog_actor_id() IS NOT NULL
    UNION ALL
    SELECT p.id
      FROM chronolog_collectives AS c
      JOIN chronolog_collective_members AS m ON m.collective_id = c.collective_id
      JOIN chronolog_principals AS p ON p.key = c.collective_id
     WHERE m.member_key = chronolog_actor() AND m.state = 'active'
       AND (c.${operation}_role = 'member' OR m.role = 'admin')`,
  `CREATE VIEW ${grantsToMeView(operation)} (grant_id, tbl, grantor, grantor_key, row_key, columns) AS
    SELECT g.grant_id, g.tbl, p.id, g.grantor, g.row_key, g.columns
      FROM chronolog_grants AS g
      JOIN chronolog_principals AS p ON p.key = g.grantor
     WHERE g.grantee_key = chronolog_actor() AND g.revoked_tx IS NULL AND g.op_${operation} = 1`
]);
var PLATFORM_VIEW_NAMES = new Set(
  OWNER_OPERATIONS.flatMap((operation) => [ownerIdsView(operation), grantsToMeView(operation)])
);
function initializePlatform(database, rootPrincipal, forkSeeding) {
  if (rootPrincipal.length !== 32) throw new Error("MATERIALIZER_ROOT_PRINCIPAL_INVALID");
  for (const sql of [...PLATFORM_TABLES_SQL, ...PLATFORM_VIEWS_SQL]) database.exec(sql);
  database.prepare("INSERT INTO chronolog_platform (singleton, root_admin, seeding_open) VALUES (1, ?, ?)").run(rootPrincipal, forkSeeding ? 1 : 0);
  database.prepare(`
    INSERT INTO chronolog_collectives (collective_id, kind, insert_role, update_role, delete_role, created_tx)
    VALUES (?, 'group', 'admin', 'admin', 'admin', NULL)
  `).run(GROUP_COLLECTIVE_ID);
  database.prepare(`
    INSERT INTO chronolog_collective_members (collective_id, member_key, role, state, joined_tx, left_tx)
    VALUES (?, ?, 'admin', 'active', NULL, NULL)
  `).run(GROUP_COLLECTIVE_ID, rootPrincipal);
  database.prepare("INSERT INTO chronolog_ddl_namespaces (name, owner) VALUES ('main', ?)").run(rootPrincipal);
  database.prepare("INSERT INTO chronolog_principals (id, key) VALUES (1, ?), (2, ?)").run(GROUP_COLLECTIVE_ID, rootPrincipal);
}
function readRootPrincipal(database) {
  const row = database.prepare("SELECT root_admin FROM chronolog_platform WHERE singleton = 1").get();
  if (row === void 0 || Array.isArray(row) || !(row.root_admin instanceof Uint8Array)) throw new Error("MATERIALIZER_PLATFORM_STATE_MISSING");
  return Uint8Array.from(row.root_admin);
}

// packages/materializer-doltlite/src/platform/session.ts
var PlatformRejection = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "PlatformRejection";
  }
  code;
};
var reject2 = (reason) => {
  throw new PlatformRejection(`platform:${reason}`);
};
var SEEDABLE_PLATFORM_TABLES = [
  "chronolog_collectives",
  "chronolog_collective_members",
  "chronolog_grants",
  "chronolog_transfers",
  "chronolog_transfer_scope",
  ...SEEDABLE_SEALED_TABLES
];
var PlatformSession = class {
  #database;
  #context;
  constructor(database, context) {
    this.#database = database;
    this.#context = context;
  }
  /** Snapshot only protected catalog names, before authored SQL runs. */
  reservedObjectNames() {
    return new Set(this.#all("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view', 'index', 'trigger')").map((row) => String(row.name)).filter((name) => isReservedSchemaObjectName(name) && !name.toLowerCase().startsWith("sqlite_")));
  }
  /** ALTER callbacks name only the old object; do not let a rename claim protected names. */
  assertReservedObjectsUnchanged(before) {
    for (const name of this.reservedObjectNames()) if (!before.has(name)) throw new PlatformRejection("denied");
  }
  /** Derive from the current transaction state, never from enrollment roles or cached cookies. */
  ddlPermissions() {
    const permissions = { create: false, alter: [], drop: [], index: [], trigger: [] };
    const namespace = this.#get("SELECT owner FROM chronolog_ddl_namespaces WHERE name = 'main'");
    permissions.create = namespace !== void 0 && sameBytes(asBytes(namespace.owner), this.#context.actor);
    for (const row of this.#all("SELECT name, owner FROM chronolog_ddl_objects ORDER BY name")) {
      if (!sameBytes(asBytes(row.owner), this.#context.actor)) continue;
      for (const operation of ["alter", "drop", "index", "trigger"]) permissions[operation].push(String(row.name));
    }
    for (const row of this.#all(`SELECT scope_kind, scope_name, operations FROM chronolog_ddl_grants
      WHERE revoked_tx IS NULL AND grantee = ? ORDER BY grant_id`, this.#context.actor)) {
      const operations = JSON.parse(String(row.operations));
      for (const operation of operations) {
        if (operation === "create") permissions.create = true;
        else if (!permissions[operation].includes(String(row.scope_name))) permissions[operation].push(String(row.scope_name));
      }
    }
    return permissions;
  }
  #grantDdl(op, stepIndex) {
    const catalog = op.scope.kind === "namespace" ? "chronolog_ddl_namespaces" : "chronolog_ddl_objects";
    const scope = this.#get(`SELECT name, owner FROM ${catalog} WHERE name = ?`, op.scope.name) ?? reject2("no_such_ddl_scope");
    if (!sameBytes(asBytes(scope.owner), this.#context.actor)) reject2("not_ddl_owner");
    this.#run(
      `INSERT INTO chronolog_ddl_grants
      (grant_id, scope_kind, scope_name, grantor, grantee, operations, created_tx, revoked_tx) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      this.#objectId(stepIndex),
      op.scope.kind,
      scope.name,
      this.#context.actor,
      op.grantee,
      JSON.stringify(op.operations),
      this.#context.txId
    );
  }
  #revokeDdl(grantId) {
    const grant = this.#get("SELECT grantor, grantee, revoked_tx FROM chronolog_ddl_grants WHERE grant_id = ?", grantId) ?? reject2("no_such_ddl_grant");
    if (grant.revoked_tx !== null) reject2("grant_revoked");
    if (!sameBytes(asBytes(grant.grantor), this.#context.actor) && !sameBytes(asBytes(grant.grantee), this.#context.actor)) reject2("not_ddl_owner");
    this.#run("UPDATE chronolog_ddl_grants SET revoked_tx = ? WHERE grant_id = ?", this.#context.txId, grantId);
  }
  /**
   * Start a transaction: close fork seeding unless the signer is the genesis
   * root (seeding ends at the plan's EndSeeding step, or at the first
   * transaction by anyone else if that comes first),
   * give a first-time signer its principal id, and read the schema cookie. One cached read, since it runs for
   * every transaction.
   */
  begin() {
    const row = cachedInternalStatement(this.#database, BEGIN_SQL).get(GROUP_COLLECTIVE_ID, this.#context.actor);
    if (row === void 0 || Array.isArray(row)) throw new Error("MATERIALIZER_PLATFORM_STATE_MISSING");
    if (Number(row.seeding_open) === 1 && !sameBytes(asBytes(row.root_admin), this.#context.actor)) {
      this.#run("UPDATE chronolog_platform SET seeding_open = 0 WHERE singleton = 1");
    }
    const actorId = row.actor_id === null ? this.#principal(this.#context.actor) : BigInt(row.actor_id);
    return { actorId, schemaVersion: Number(row.schema_version) };
  }
  execute(op, stepIndex) {
    if (isSealedPlatformOp(op)) {
      try {
        return new SealedSession(this.#database, {
          ...this.#context,
          registered: (table) => this.#registered(table),
          findRow: (shape, values) => this.#findRow(shape, values),
          ownerOf: (shape, key) => this.#ownerOf(shape, key),
          administers: (owner) => this.#administers(owner),
          objectId: (index) => this.#objectId(index)
        }).execute(op, stepIndex);
      } catch (error) {
        if (error instanceof SealedRejection) throw new PlatformRejection(error.message);
        throw error;
      }
    }
    switch (op.op) {
      case "grant_ddl":
        return this.#grantDdl(op, stepIndex);
      case "revoke_ddl":
        return this.#revokeDdl(op.grantId);
      case "grant":
        return this.#grant(op, stepIndex);
      case "revoke_grant":
        return this.#revokeGrant(op.grantId);
      case "create_collective":
        return this.#createCollective(op, stepIndex);
      case "accept_membership":
        return this.#acceptMembership(op.collectiveId);
      case "leave":
        return this.#leave(op.collectiveId);
      case "set_members":
        return this.#setMembers(op);
      case "transfer_offer":
        return this.#transferOffer(op, stepIndex);
      case "transfer_accept":
        return this.#transferAccept(op.offerId);
      case "transfer_cancel":
        return this.#transferCancel(op.offerId);
      case "seed_rows":
        return this.#seedRows(op);
      case "end_seeding":
        return this.#endSeeding();
    }
  }
  // ── tables ────────────────────────────────────────────────────────────────
  /**
   * Put a new application table under owner checks: add the owner column
   * (to an empty table), lint its foreign keys, and generate its triggers.
   * Run by reconciliation right after the statement that created the table;
   * creation requires the main namespace capability.
   */
  #registerTable(name) {
    let shape = tableShape(this.#database, name);
    if (shape.primaryKey.length === 0) reject2("no_primary_key");
    if (!hasNonNullPrimaryKey(shape)) reject2("nullable_primary_key");
    if (ownerColumn(shape) === void 0) {
      if (this.#get(`SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(name)}) AS present`)?.present === 1) reject2("table_not_empty");
      this.#run(`ALTER TABLE ${quoteIdentifier(name)} ADD COLUMN ${OWNER_COLUMN_SQL}`);
      shape = tableShape(this.#database, name);
    }
    if (!hasValidOwnerColumn(shape)) reject2("owner_column_invalid");
    if (foreignKeyViolation(shape) !== null) reject2("fk_action");
    const foreign = this.#get(`
      SELECT 1 AS present FROM ${quoteIdentifier(name)}
       WHERE NOT coalesce(${quoteIdentifier(OWNER_COLUMN)} IN (SELECT id FROM ${ownerIdsView("insert")}), 0) LIMIT 1
    `);
    if (foreign !== void 0) reject2("foreign_owner");
    for (const trigger of platformTriggers(shape)) this.#run(trigger.sql);
    this.#run("INSERT INTO chronolog_tables (name, registered_at_tx) VALUES (?, ?)", name, this.#context.txId);
  }
  #isRegistered(name) {
    return this.#get("SELECT 1 AS present FROM chronolog_tables WHERE name = ?", name) !== void 0;
  }
  #registered(requested) {
    const name = resolveTable(this.#database, requested);
    if (name === null || !this.#isRegistered(name)) reject2("unregistered_table");
    return tableShape(this.#database, name);
  }
  #registeredTables() {
    return this.#all("SELECT name FROM chronolog_tables ORDER BY name").map((row) => String(row.name));
  }
  // ── rows ──────────────────────────────────────────────────────────────────
  #findRow(shape, values) {
    if (values.length !== shape.primaryKey.length) reject2("row_key_arity");
    const row = this.#get(`
      SELECT ${rowKeyExpression("t", shape.primaryKey)} AS row_key, ${this.#ownerKeySql("t")} AS owner
        FROM ${quoteIdentifier(shape.name)} AS t
       WHERE ${shape.primaryKey.map((column) => `t.${quoteIdentifier(column)} = ?`).join(" AND ")}
    `, ...values.map(toDatabaseValue));
    return row === void 0 ? null : { key: String(row.row_key), owner: asBytes(row.owner) };
  }
  #ownerOf(shape, key) {
    const row = this.#get(`
      SELECT ${this.#ownerKeySql("t")} AS owner FROM ${quoteIdentifier(shape.name)} AS t
       WHERE ${rowKeyFilter("t", shape.primaryKey)}
    `, ...rowKeyBindings(key, shape.primaryKey));
    return row === void 0 ? null : asBytes(row.owner);
  }
  // ── principals ────────────────────────────────────────────────────────────
  /** The principal id of `key`, assigned now if it has none (the next integer). */
  #principal(key) {
    const existing = this.#principalIfAny(key);
    if (existing !== null) return existing;
    this.#run("INSERT INTO chronolog_principals (id, key) VALUES ((SELECT coalesce(max(id), 0) + 1 FROM chronolog_principals), ?)", key);
    return this.#principalIfAny(key) ?? reject2("state_missing");
  }
  #principalIfAny(key) {
    const row = this.#get("SELECT id FROM chronolog_principals WHERE key = ?", key);
    return row === void 0 ? null : BigInt(row.id);
  }
  /** The SQL that turns a row's owner id into its key. */
  #ownerKeySql(alias) {
    return `(SELECT key FROM chronolog_principals WHERE id = ${alias}.${quoteIdentifier(OWNER_COLUMN)})`;
  }
  // ── collectives ───────────────────────────────────────────────────────────
  #collective(id) {
    const row = this.#get("SELECT kind, insert_role, update_role, delete_role FROM chronolog_collectives WHERE collective_id = ?", id);
    if (row === void 0) return null;
    return {
      kind: row.kind,
      roles: { insert: row.insert_role, update: row.update_role, delete: row.delete_role }
    };
  }
  #membership(collectiveId, member) {
    const row = this.#get("SELECT role, state FROM chronolog_collective_members WHERE collective_id = ? AND member_key = ?", collectiveId, member);
    return row === void 0 ? null : { role: row.role, state: row.state };
  }
  #isCollectiveAdmin(collectiveId, member) {
    const membership = this.#membership(collectiveId, member);
    return membership !== null && membership.state === "active" && membership.role === "admin";
  }
  /** The signer may act as `owner`: its own key, or a collective it administers. */
  #administers(owner) {
    return sameBytes(owner, this.#context.actor) || this.#isCollectiveAdmin(owner, this.#context.actor);
  }
  #activeAdmins(collectiveId) {
    return Number(this.#get(`SELECT count(*) AS admins FROM chronolog_collective_members
      WHERE collective_id = ? AND role = 'admin' AND state = 'active'`, collectiveId)?.admins ?? 0);
  }
  #createCollective(op, stepIndex) {
    const id = this.#objectId(stepIndex);
    if (op.invitees.some((key) => sameBytes(key, this.#context.actor))) reject2("invalid_member");
    this.#run(`INSERT INTO chronolog_collectives (collective_id, kind, insert_role, update_role, delete_role, created_tx)
      VALUES (?, 'team', ?, ?, ?, ?)`, id, op.governance.insert, op.governance.update, op.governance.delete, this.#context.txId);
    this.#principal(id);
    this.#run(`INSERT INTO chronolog_collective_members (collective_id, member_key, role, state, joined_tx, left_tx)
      VALUES (?, ?, 'admin', 'active', ?, NULL)`, id, this.#context.actor, this.#context.txId);
    for (const invitee of op.invitees) {
      this.#run(`INSERT INTO chronolog_collective_members (collective_id, member_key, role, state, joined_tx, left_tx)
        VALUES (?, ?, 'member', 'invited', NULL, NULL)`, id, invitee);
    }
  }
  #acceptMembership(collectiveId) {
    if (this.#membership(collectiveId, this.#context.actor)?.state !== "invited") reject2("not_invited");
    this.#run(`UPDATE chronolog_collective_members SET state = 'active', joined_tx = ?, left_tx = NULL
      WHERE collective_id = ? AND member_key = ?`, this.#context.txId, collectiveId, this.#context.actor);
  }
  #leave(collectiveId) {
    const membership = this.#membership(collectiveId, this.#context.actor);
    if (membership === null || membership.state === "left") reject2("not_member");
    this.#run(`UPDATE chronolog_collective_members SET state = 'left', left_tx = ?
      WHERE collective_id = ? AND member_key = ?`, this.#context.txId, collectiveId, this.#context.actor);
    if (this.#activeAdmins(collectiveId) === 0) reject2("last_admin");
  }
  #setMembers(op) {
    if (this.#collective(op.collectiveId) === null) reject2("no_such_collective");
    if (!this.#isCollectiveAdmin(op.collectiveId, this.#context.actor)) reject2("not_collective_admin");
    for (const change of op.changes) {
      const membership = this.#membership(op.collectiveId, change.member);
      if (change.role === "remove") {
        if (membership === null || membership.state === "left") reject2("not_member");
        this.#run(`UPDATE chronolog_collective_members SET state = 'left', left_tx = ?
          WHERE collective_id = ? AND member_key = ?`, this.#context.txId, op.collectiveId, change.member);
      } else if (membership !== null && membership.state !== "left") {
        this.#run(
          "UPDATE chronolog_collective_members SET role = ? WHERE collective_id = ? AND member_key = ?",
          change.role,
          op.collectiveId,
          change.member
        );
      } else {
        this.#run(
          `INSERT INTO chronolog_collective_members (collective_id, member_key, role, state, joined_tx, left_tx)
          VALUES (?, ?, ?, 'invited', NULL, NULL)
          ON CONFLICT (collective_id, member_key) DO UPDATE SET role = excluded.role, state = 'invited', joined_tx = NULL, left_tx = NULL`,
          op.collectiveId,
          change.member,
          change.role
        );
      }
    }
    if (this.#activeAdmins(op.collectiveId) === 0) reject2("last_admin");
  }
  // ── grants ────────────────────────────────────────────────────────────────
  #grant(op, stepIndex) {
    const shape = this.#registered(op.table);
    let columns = null;
    if (op.columns !== void 0) {
      if (!op.operations.includes("update")) reject2("invalid_grant");
      columns = op.columns.map((requested) => {
        const column = shape.columns.find((entry) => entry.hidden === 0 && entry.name.toLowerCase() === requested.toLowerCase());
        if (column === void 0 || column.name.toLowerCase() === OWNER_COLUMN) reject2("unknown_column");
        return column.name;
      });
    }
    let grantor;
    let rowKey = null;
    if (op.rowKey !== void 0) {
      if (op.operations.includes("insert")) reject2("invalid_grant");
      const row = this.#findRow(shape, op.rowKey) ?? reject2("no_such_row");
      grantor = row.owner;
      rowKey = row.key;
      if (op.grantor !== void 0 && !sameBytes(op.grantor, grantor)) reject2("not_owner");
    } else {
      grantor = op.grantor ?? this.#context.actor;
    }
    if (!this.#administers(grantor)) reject2("not_owner");
    this.#run(
      `INSERT INTO chronolog_grants
      (grant_id, tbl, grantor, grantee_key, row_key, op_insert, op_update, op_delete, columns, created_tx, revoked_tx)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      this.#objectId(stepIndex),
      shape.name,
      grantor,
      op.grantee,
      rowKey,
      flag(op.operations.includes("insert")),
      flag(op.operations.includes("update")),
      flag(op.operations.includes("delete")),
      columns === null ? null : JSON.stringify(columns),
      this.#context.txId
    );
  }
  #revokeGrant(grantId) {
    const row = this.#get("SELECT grantor, grantee_key, revoked_tx FROM chronolog_grants WHERE grant_id = ?", grantId) ?? reject2("no_such_grant");
    if (row.revoked_tx !== null) reject2("grant_revoked");
    if (!this.#administers(asBytes(row.grantor)) && !sameBytes(asBytes(row.grantee_key), this.#context.actor)) reject2("not_owner");
    this.#run("UPDATE chronolog_grants SET revoked_tx = ? WHERE grant_id = ?", this.#context.txId, grantId);
  }
  // ── transfers ─────────────────────────────────────────────────────────────
  #transferOffer(op, stepIndex) {
    let from;
    let table = null;
    let rowKey = null;
    if (op.scope.kind === "row") {
      const shape = this.#registered(op.scope.table);
      const row = this.#findRow(shape, op.scope.rowKey) ?? reject2("no_such_row");
      from = row.owner;
      table = shape.name;
      rowKey = row.key;
      if (op.fromOwner !== void 0 && !sameBytes(op.fromOwner, from)) reject2("not_owner");
    } else {
      from = op.fromOwner ?? this.#context.actor;
    }
    if (!this.#administers(from)) reject2("not_owner");
    if (sameBytes(from, op.toOwner)) reject2("invalid_transfer");
    const scope = this.#transferScope(table, rowKey, from, op.carry);
    const digest = this.#transferScopeDigest(scope, from);
    const offerId = this.#objectId(stepIndex);
    this.#run(
      `INSERT INTO chronolog_transfers (offer_id, tbl, row_key, from_owner, to_owner, carry, scope_digest, state, created_tx, closed_tx)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
      offerId,
      table,
      rowKey,
      from,
      op.toOwner,
      flag(op.carry),
      digest,
      this.#context.txId
    );
    for (const row of scope) this.#run("INSERT INTO chronolog_transfer_scope (offer_id, tbl, row_key) VALUES (?, ?, ?)", offerId, row.table, row.key);
  }
  #transferCancel(offerId) {
    const offer = this.#get("SELECT from_owner, to_owner, state FROM chronolog_transfers WHERE offer_id = ?", offerId) ?? reject2("no_such_offer");
    if (offer.state !== "open") reject2("offer_closed");
    if (!this.#administers(asBytes(offer.from_owner)) && !this.#administers(asBytes(offer.to_owner))) reject2("not_owner");
    this.#run("UPDATE chronolog_transfers SET state = 'cancelled', closed_tx = ? WHERE offer_id = ?", this.#context.txId, offerId);
  }
  #transferAccept(offerId) {
    const offer = this.#get("SELECT tbl, row_key, from_owner, to_owner, carry, scope_digest, state FROM chronolog_transfers WHERE offer_id = ?", offerId) ?? reject2("no_such_offer");
    if (offer.state !== "open") reject2("offer_closed");
    const from = asBytes(offer.from_owner);
    const to = asBytes(offer.to_owner);
    if (!this.#administers(to)) reject2("not_recipient");
    const scope = this.#transferScope(offer.tbl === null ? null : asText(offer.tbl), offer.row_key === null ? null : asText(offer.row_key), from, Number(offer.carry) === 1);
    if (!sameBytes(this.#transferScopeDigest(scope, from), asBytes(offer.scope_digest))) reject2("offer_stale");
    if (offer.tbl === null) this.#transferAll(from, to, scope);
    else this.#transferRow(asText(offer.tbl), asText(offer.row_key), from, to, Number(offer.carry) === 1);
    this.#run(`UPDATE chronolog_transfers SET state = 'accepted', closed_tx = ? WHERE offer_id = ?`, this.#context.txId, offerId);
  }
  /** Current concrete rows addressed by an offer, in canonical order. */
  #transferScope(table, key, from, carry) {
    const owner = this.#principalIfAny(from);
    if (owner === null) return [];
    let rows2;
    if (table === null) {
      rows2 = this.#registeredTables().flatMap((name) => {
        const shape = tableShape(this.#database, name);
        return this.#all(`SELECT ${rowKeyExpression("t", shape.primaryKey)} AS row_key FROM ${quoteIdentifier(name)} AS t
          WHERE t.${quoteIdentifier(OWNER_COLUMN)} = ? ORDER BY row_key`, owner).map((row) => ({ table: name, key: String(row.row_key) }));
      });
    } else {
      if (!this.#isRegistered(table) || key === null) reject2("offer_stale");
      const shape = tableShape(this.#database, table);
      const currentOwner = this.#ownerOf(shape, key);
      if (currentOwner === null || !sameBytes(currentOwner, from)) reject2("offer_stale");
      rows2 = [{ table, key }, ...carry ? this.#dependents({ table, key }, owner) : []];
    }
    return rows2.sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }
  /** Bind an offer to exact data, columns and dependent set, not future rows. */
  #transferScopeDigest(scope, from) {
    const hash = createSha256().update("chronolog-transfer-scope-v1\0").update(from);
    const part = (value) => {
      hash.update(`${utf8(value).byteLength}:`).update(value);
    };
    for (const ref of scope) {
      const shape = tableShape(this.#database, ref.table);
      const columns = shape.columns.filter((column) => column.hidden === 0 && column.name !== OWNER_COLUMN);
      part(ref.table);
      part(ref.key);
      part(JSON.stringify(columns.map((column) => [column.name, column.type, column.primaryKey])));
      const content = this.#get(`SELECT ${columns.length === 0 ? "''" : columns.map((column) => `chronolog_row_key(t.${quoteIdentifier(column.name)})`).join(" || ")} AS data
        FROM ${quoteIdentifier(ref.table)} AS t WHERE ${rowKeyFilter("t", shape.primaryKey)}`, ...rowKeyBindings(ref.key, shape.primaryKey));
      if (content === void 0) reject2("offer_stale");
      part(asText(content.data));
      for (const policy of this.#all(`SELECT hex(policy_id) AS id, CAST(version AS TEXT) AS version
        FROM chronolog_reader_policies WHERE tbl = ? AND row_key = ? AND closed_tx IS NULL ORDER BY policy_id`, ref.table, ref.key)) {
        part(String(policy.id));
        part(String(policy.version));
      }
    }
    return Uint8Array.from(hash.digest());
  }
  #transferRow(table, key, from, to, carry) {
    if (!this.#isRegistered(table)) reject2("offer_stale");
    const shape = tableShape(this.#database, table);
    const owner = this.#ownerOf(shape, key);
    if (owner === null || !sameBytes(owner, from)) reject2("offer_stale");
    const fromId = this.#principal(from);
    const toId = this.#principal(to);
    const dependents = this.#dependents({ table, key }, fromId);
    if (!carry && dependents.length > 0) reject2("has_dependents");
    const moved = [{ table, key }, ...dependents];
    for (const row of moved) this.#transferExemption(row, fromId, toId, to);
    try {
      const result = this.#run(`UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(OWNER_COLUMN)} = ?
        WHERE ${rowKeyFilter(quoteIdentifier(table), shape.primaryKey)}`, toId, ...rowKeyBindings(key, shape.primaryKey));
      if (Number(result.changes) !== 1) reject2("offer_stale");
      this.#assertTransferComplete(to);
    } finally {
      this.#run("DELETE FROM chronolog_exemptions");
    }
    for (const row of moved) {
      this.#run("UPDATE chronolog_grants SET revoked_tx = ? WHERE revoked_tx IS NULL AND tbl = ? AND row_key = ?", this.#context.txId, row.table, row.key);
    }
  }
  /** Guard both identities of one row while permitting its owner transition. */
  #transferExemption(row, fromId, toId, to) {
    const shape = tableShape(this.#database, row.table);
    let toKey = row.key;
    if (shape.primaryKey.some((column) => column.toLowerCase() === OWNER_COLUMN)) {
      const values = shape.primaryKey.map((column) => column.toLowerCase() === OWNER_COLUMN ? "?" : `t.${quoteIdentifier(column)}`);
      const target = this.#get(
        `SELECT chronolog_row_key(${values.join(", ")}) AS row_key
        FROM ${quoteIdentifier(row.table)} AS t WHERE ${rowKeyFilter("t", shape.primaryKey)}`,
        to,
        ...rowKeyBindings(row.key, shape.primaryKey)
      ) ?? reject2("offer_stale");
      toKey = asText(target.row_key);
    }
    this.#run(`INSERT INTO chronolog_exemptions (kind, tbl, row_key, to_row_key, from_owner, to_owner)
      VALUES ('transfer', ?, ?, ?, ?, ?)`, row.table, row.key, toKey, fromId, toId);
  }
  /** A schema-level ON CONFLICT IGNORE must not silently skip an owner change. */
  #assertTransferComplete(to) {
    for (const row of this.#all("SELECT tbl, row_key, to_row_key FROM chronolog_exemptions WHERE kind = 'transfer' ORDER BY tbl, row_key")) {
      const shape = tableShape(this.#database, asText(row.tbl));
      const fromKey = asText(row.row_key);
      const toKey = asText(row.to_row_key);
      const owner = this.#ownerOf(shape, toKey);
      if (owner === null || !sameBytes(owner, to) || fromKey !== toKey && this.#ownerOf(shape, fromKey) !== null) reject2("offer_stale");
    }
  }
  /** Same-owner rows reachable through owner-composite foreign keys (all ON UPDATE CASCADE). */
  #dependents(root, owner) {
    const registered = this.#registeredTables().map((name) => tableShape(this.#database, name));
    const found = [];
    const seen = /* @__PURE__ */ new Set([`${root.table}\0${root.key}`]);
    const pending = [root];
    while (pending.length > 0) {
      const parent = pending.shift();
      const parentShape = tableShape(this.#database, parent.table);
      for (const child of registered) {
        for (const foreignKey of child.foreignKeys) {
          if (!isOwnerComposite(foreignKey) || foreignKey.table.toLowerCase() !== parent.table.toLowerCase()) continue;
          const referenced = foreignKey.to.map((column, index) => column ?? parentShape.primaryKey[index]);
          const children = this.#all(`
            SELECT ${rowKeyExpression("c", child.primaryKey)} AS row_key
              FROM ${quoteIdentifier(child.name)} AS c
              JOIN ${quoteIdentifier(parent.table)} AS p ON
                ${referenced.map((column, index) => `p.${quoteIdentifier(column)} = +c.${quoteIdentifier(foreignKey.from[index])}`).join(" AND ")}
             WHERE ${rowKeyFilter("p", parentShape.primaryKey)}
               AND c.${quoteIdentifier(OWNER_COLUMN)} = ?
             ORDER BY row_key
          `, ...rowKeyBindings(parent.key, parentShape.primaryKey), owner);
          for (const row of children) {
            const ref = { table: child.name, key: String(row.row_key) };
            const id = `${ref.table}\0${ref.key}`;
            if (seen.has(id)) continue;
            seen.add(id);
            found.push(ref);
            pending.push(ref);
          }
        }
      }
    }
    return found;
  }
  /** The key-change path: every row `from` owns, in parent-before-child order. */
  #transferAll(from, to, scope) {
    const tables = this.#parentFirst(this.#registeredTables().map((name) => tableShape(this.#database, name)));
    const fromId = this.#principal(from);
    const toId = this.#principal(to);
    for (const row of scope) this.#transferExemption(row, fromId, toId, to);
    try {
      for (const shape of tables) {
        for (const row of scope.filter((entry) => entry.table === shape.name)) {
          this.#run(
            `UPDATE ${quoteIdentifier(shape.name)} SET ${quoteIdentifier(OWNER_COLUMN)} = ?
            WHERE ${quoteIdentifier(OWNER_COLUMN)} = ? AND ${rowKeyFilter(quoteIdentifier(shape.name), shape.primaryKey)}`,
            toId,
            fromId,
            ...rowKeyBindings(row.key, shape.primaryKey)
          );
        }
      }
      this.#assertTransferComplete(to);
    } finally {
      this.#run("DELETE FROM chronolog_exemptions");
    }
    this.#run("UPDATE chronolog_grants SET grantor = ? WHERE grantor = ? AND revoked_tx IS NULL", to, from);
  }
  #parentFirst(shapes) {
    const byName = new Map(shapes.map((shape) => [shape.name.toLowerCase(), shape]));
    const ordered = [];
    const state = /* @__PURE__ */ new Map();
    const visit = (shape) => {
      const key = shape.name.toLowerCase();
      if (state.get(key) === "done") return;
      if (state.get(key) === "visiting") reject2("fk_cycle");
      state.set(key, "visiting");
      for (const foreignKey of shape.foreignKeys) {
        const parent = byName.get(foreignKey.table.toLowerCase());
        if (isOwnerComposite(foreignKey) && parent !== void 0 && parent !== shape) visit(parent);
      }
      state.set(key, "done");
      ordered.push(shape);
    };
    for (const shape of shapes) visit(shape);
    return ordered;
  }
  // ── fork seeding ──────────────────────────────────────────────────────────
  /** Only the genesis root may seed, and only while seeding is open. */
  #assertSeeding() {
    const platform = this.#get("SELECT root_admin, seeding_open FROM chronolog_platform WHERE singleton = 1") ?? reject2("state_missing");
    if (!sameBytes(asBytes(platform.root_admin), this.#context.actor)) reject2("not_root");
    if (Number(platform.seeding_open) !== 1) reject2("seed_closed");
  }
  /** The fork-seed plan's last step: no further SeedRows, even by the root. */
  #endSeeding() {
    this.#assertSeeding();
    this.#run("UPDATE chronolog_platform SET seeding_open = 0 WHERE singleton = 1");
  }
  #seedRows(op) {
    this.#assertSeeding();
    if (SEEDABLE_PLATFORM_TABLES.includes(op.table.toLowerCase())) return this.#seedPlatformRows(op);
    const shape = this.#registered(op.table);
    const columns = op.columns.map((requested) => {
      const column = shape.columns.find((entry) => entry.hidden === 0 && entry.name.toLowerCase() === requested.toLowerCase());
      return column?.name ?? reject2("unknown_column");
    });
    const ownerIndex = columns.indexOf(OWNER_COLUMN);
    if (ownerIndex < 0) reject2("invalid_seed");
    const rows2 = op.rows.map((row) => {
      const owner = row[ownerIndex];
      if (owner.kind !== "blob" || owner.value.length !== 32) reject2("invalid_seed");
      const values = row.map(toDatabaseValue);
      values[ownerIndex] = this.#principal(owner.value);
      return values;
    });
    this.#run(`INSERT INTO chronolog_exemptions (kind, tbl, row_key, from_owner, to_owner) VALUES ('seed', ?, NULL, NULL, NULL)`, shape.name);
    try {
      const sql = `INSERT INTO ${quoteIdentifier(shape.name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
      withProfiledStatement(this.#database, sql, "platform", (statement) => {
        for (const values of rows2) statement.run(...values);
      }, this.#context.limits);
    } finally {
      this.#run("DELETE FROM chronolog_exemptions");
    }
  }
  #seedPlatformRows(op) {
    const table = op.table.toLowerCase();
    const shape = tableShape(this.#database, table);
    const columns = op.columns.map((requested) => shape.columns.find((entry) => entry.name.toLowerCase() === requested.toLowerCase())?.name ?? reject2("unknown_column"));
    const collective = columns.indexOf("collective_id");
    for (const row of op.rows) {
      const value = collective < 0 ? void 0 : row[collective];
      if (value?.kind === "blob" && sameBytes(value.value, GROUP_COLLECTIVE_ID)) reject2("invalid_seed");
    }
    const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    withProfiledStatement(this.#database, sql, "platform", (statement) => {
      for (const row of op.rows) statement.run(...row.map(toDatabaseValue));
    }, this.#context.limits);
    if (table === "chronolog_collectives" && collective >= 0) {
      for (const row of op.rows) this.#principal(row[collective].value);
    }
  }
  // ── reconciliation ────────────────────────────────────────────────────────
  /**
   * Run after every transaction that changed the schema (§3): every
   * application table is registered and carries current platform triggers, no
   * foreign chronolog_* trigger or view exists, and no app trigger uses
   * RAISE(IGNORE). Throws PlatformRejection with the bare rejection code.
   */
  reconcile() {
    const objects = this.#all(`SELECT l.name, l.type, s.sql FROM pragma_table_list AS l
      LEFT JOIN sqlite_schema AS s ON s.type = 'table' AND s.name = l.name WHERE l.schema = 'main'`);
    const tables = /* @__PURE__ */ new Map();
    const vecTables = /* @__PURE__ */ new Map();
    for (const object of objects) {
      const name = String(object.name);
      if (this.#database.nativeProfile !== void 0 && name.toLowerCase().startsWith("_cf_")) continue;
      const sql = typeof object.sql === "string" ? object.sql : "";
      if (object.type === "table") tables.set(name.toLowerCase(), name);
      if (object.type === "virtual") {
        const vectorColumns = vec0VectorColumns(sql);
        if (vectorColumns !== null) vecTables.set(name.toLowerCase(), vectorColumns);
      }
    }
    const registered = this.#registeredTables();
    const registeredKeys = new Set(registered.map((name) => name.toLowerCase()));
    for (const name of registered) {
      if (tables.has(name.toLowerCase())) continue;
      const moved = this.#get(`SELECT tbl_name FROM sqlite_schema WHERE type = 'trigger' AND name = ?`, platformTriggerName(name, "ins"));
      const renamedTo = moved === void 0 ? void 0 : tables.get(String(moved.tbl_name).toLowerCase());
      if (renamedTo !== void 0 && !registeredKeys.has(renamedTo.toLowerCase())) {
        for (const event of PLATFORM_TRIGGER_EVENTS) this.#run(`DROP TRIGGER IF EXISTS ${quoteIdentifier(platformTriggerName(name, event))}`);
        for (const trigger of platformTriggers(tableShape(this.#database, renamedTo))) this.#run(trigger.sql);
        this.#run("UPDATE chronolog_tables SET name = ? WHERE name = ?", renamedTo, name);
        this.#run("UPDATE chronolog_ddl_objects SET name = ? WHERE name = ?", renamedTo, name);
        this.#run("UPDATE chronolog_ddl_grants SET scope_name = ? WHERE scope_kind = 'object' AND scope_name = ?", renamedTo, name);
        this.#run("UPDATE chronolog_grants SET tbl = ? WHERE tbl = ?", renamedTo, name);
        this.#run("UPDATE chronolog_transfers SET tbl = ? WHERE tbl = ?", renamedTo, name);
        this.#run("UPDATE chronolog_transfer_scope SET tbl = ? WHERE tbl = ?", renamedTo, name);
        this.#run("UPDATE chronolog_reader_policies SET tbl = ? WHERE tbl = ?", renamedTo, name);
        registeredKeys.delete(name.toLowerCase());
        registeredKeys.add(renamedTo.toLowerCase());
        continue;
      }
      this.#run("DELETE FROM chronolog_tables WHERE name = ?", name);
      this.#run("UPDATE chronolog_grants SET revoked_tx = ? WHERE tbl = ? AND revoked_tx IS NULL", this.#context.txId, name);
      this.#run("UPDATE chronolog_reader_policies SET closed_tx = ? WHERE tbl = ? AND closed_tx IS NULL", this.#context.txId, name);
      this.#run(`UPDATE chronolog_transfers SET state = 'cancelled', closed_tx = ? WHERE tbl = ? AND state = 'open'`, this.#context.txId, name);
      this.#run(`UPDATE chronolog_transfers SET state = 'cancelled', closed_tx = ? WHERE state = 'open' AND offer_id IN
        (SELECT offer_id FROM chronolog_transfer_scope WHERE tbl = ?)`, this.#context.txId, name);
      registeredKeys.delete(name.toLowerCase());
    }
    for (const [key, name] of tables) {
      if (registeredKeys.has(key) || isReservedSchemaObjectName(name) || isVecChunkTable(this.#database, name, vecTables)) continue;
      this.#registerTable(name);
      registeredKeys.add(key);
    }
    const ownedObjects = this.#all(`SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'view', 'virtual')`).filter((row) => !isReservedSchemaObjectName(String(row.name)) && !(this.#database.nativeProfile !== void 0 && String(row.name).toLowerCase().startsWith("_cf_")) && !isVecChunkTable(this.#database, String(row.name), vecTables));
    const present = new Set(ownedObjects.map((row) => String(row.name).toLowerCase()));
    const oldVirtual = this.#all("SELECT name FROM chronolog_ddl_objects WHERE kind = 'virtual' ORDER BY name").filter((row) => !present.has(String(row.name).toLowerCase()));
    const newVirtual = ownedObjects.filter((row) => row.type === "virtual" && this.#get("SELECT name FROM chronolog_ddl_objects WHERE name = ?", row.name) === void 0);
    if (oldVirtual.length === 1 && newVirtual.length === 1) {
      this.#run("UPDATE chronolog_ddl_objects SET name = ? WHERE name = ?", newVirtual[0].name, oldVirtual[0].name);
      this.#run("UPDATE chronolog_ddl_grants SET scope_name = ? WHERE scope_kind = 'object' AND scope_name = ?", newVirtual[0].name, oldVirtual[0].name);
    }
    for (const row of this.#all("SELECT name FROM chronolog_ddl_objects ORDER BY name")) {
      if (present.has(String(row.name).toLowerCase())) continue;
      this.#run("UPDATE chronolog_ddl_grants SET revoked_tx = ? WHERE scope_kind = 'object' AND scope_name = ? AND revoked_tx IS NULL", this.#context.txId, row.name);
      this.#run("DELETE FROM chronolog_ddl_objects WHERE name = ?", row.name);
    }
    for (const row of ownedObjects) this.#run(`INSERT INTO chronolog_ddl_objects (name, kind, owner, created_tx) VALUES (?, ?, ?, ?)
      ON CONFLICT (name) DO NOTHING`, row.name, row.type, this.#context.actor, this.#context.txId);
    const expected = new Set(PLATFORM_VIEW_NAMES);
    for (const key of registeredKeys) {
      const shape = tableShape(this.#database, tables.get(key));
      if (!hasValidOwnerColumn(shape) || !hasNonNullPrimaryKey(shape)) throw new PlatformRejection("schema_unregistered");
      if (foreignKeyViolation(shape) !== null) throw new PlatformRejection("platform:fk_action");
      const slots = shape.columns.filter((column) => column.hidden === 0 && column.primaryKey === 0 && column.name !== OWNER_COLUMN && column.type.toUpperCase() === "BLOB").map((column) => column.name);
      this.#run(`UPDATE chronolog_reader_policies SET closed_tx = ? WHERE tbl = ? AND closed_tx IS NULL
        AND EXISTS (SELECT 1 FROM chronolog_sealed_values AS v WHERE v.policy_id = chronolog_reader_policies.policy_id
          ${slots.length === 0 ? "" : `AND v.slot NOT IN (${slots.map(() => "?").join(", ")})`})`, this.#context.txId, shape.name, ...slots);
      for (const trigger of platformTriggers(shape)) {
        expected.add(trigger.name.toLowerCase());
        const current = this.#get(`SELECT sql, tbl_name FROM sqlite_schema WHERE type = 'trigger' AND name = ?`, trigger.name);
        if (current === void 0 || String(current.tbl_name).toLowerCase() !== key) throw new PlatformRejection("schema_unregistered");
        if (String(current.sql) !== trigger.sql) {
          this.#run(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
          this.#run(trigger.sql);
        }
      }
    }
    for (const object of this.#all(`SELECT type, name, sql FROM sqlite_schema WHERE type IN ('trigger', 'view')`)) {
      const name = String(object.name);
      if (name.toLowerCase().startsWith("chronolog_")) {
        if (!expected.has(name.toLowerCase())) throw new PlatformRejection("schema_unregistered");
      } else if (object.type === "trigger" && typeof object.sql === "string" && this.#database.triggerUsesIgnore(object.sql)) {
        throw new PlatformRejection("trigger_ignore");
      }
    }
  }
  // ── statement helpers ─────────────────────────────────────────────────────
  #objectId(stepIndex) {
    return Uint8Array.from(createSha256().update(platformObjectIdHashInput(this.#context.txId, stepIndex)).digest());
  }
  #run(sql, ...parameters) {
    return withProfiledStatement(this.#database, sql, "platform", (statement) => statement.run(...parameters), this.#context.limits);
  }
  #get(sql, ...parameters) {
    return withProfiledStatement(this.#database, sql, "platform", (statement) => {
      const row = statement.get(...parameters);
      if (Array.isArray(row)) throw new Error("MATERIALIZER_EXPECTED_OBJECT_ROW");
      return row;
    }, this.#context.limits);
  }
  #all(sql, ...parameters) {
    return withProfiledStatement(this.#database, sql, "platform", (statement) => statement.all(...parameters).map((row) => {
      if (Array.isArray(row)) throw new Error("MATERIALIZER_EXPECTED_OBJECT_ROW");
      return row;
    }), this.#context.limits);
  }
};
var BEGIN_SQL = `SELECT p.root_admin, p.seeding_open,
  (SELECT id FROM chronolog_principals WHERE key = ?2) AS actor_id,
  (SELECT schema_version FROM pragma_schema_version) AS schema_version
  FROM chronolog_platform AS p WHERE p.singleton = 1`;
var internalStatements = /* @__PURE__ */ new WeakMap();
function cachedInternalStatement(database, sql) {
  let statements = internalStatements.get(database);
  if (statements === void 0) {
    statements = /* @__PURE__ */ new Map();
    internalStatements.set(database, statements);
  }
  let statement = statements.get(sql);
  if (statement === void 0) {
    statement = database.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}
function lifecycleTriggerNames(database) {
  const tables = cachedInternalStatement(database, "SELECT name FROM chronolog_tables").all();
  return new Set(tables.flatMap((row) => ["life_ins", "upd", "del"].map((event) => platformTriggerName(String(row.name), event).replace(/[A-Z]/gu, (letter) => letter.toLowerCase()))));
}
function shadowTables(database) {
  const rows2 = cachedInternalStatement(database, `SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'`).all();
  return new Set(rows2.map((row) => String(row.name).toLowerCase()));
}
function writeProtectedTables(database) {
  const schema = cachedInternalStatement(database, `SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND sql IS NOT NULL`).all();
  const vecTables = /* @__PURE__ */ new Map();
  const tables = /* @__PURE__ */ new Set();
  for (const row of schema) {
    const sql = String(row.sql);
    if (!/^\s*CREATE\s+VIRTUAL\s+TABLE/iu.test(sql)) continue;
    tables.add(String(row.name).toLowerCase());
    const vectorColumns = vec0VectorColumns(sql);
    if (vectorColumns !== null) vecTables.set(String(row.name).toLowerCase(), vectorColumns);
  }
  for (const row of schema) {
    if (isVecChunkTable(database, String(row.name), vecTables)) tables.add(String(row.name).toLowerCase());
  }
  return tables;
}
function isVecChunkTable(database, name, vecTables) {
  const match = /^(.+)_vector_chunks(\d\d)$/u.exec(name);
  if (match === null) return false;
  const vectorColumns = vecTables.get(match[1].toLowerCase());
  if (vectorColumns === void 0 || Number(match[2]) >= vectorColumns) return false;
  const columns = cachedInternalStatement(
    database,
    `SELECT name, upper(type) AS type, "notnull" AS not_null, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid`
  ).all(name);
  return JSON.stringify(columns.map((column) => [column.name, column.type, Number(column.not_null), Number(column.pk), Number(column.hidden)])) === JSON.stringify([["rowid", "INTEGER", 0, 1, 0], ["vectors", "BLOB", 1, 0, 0]]);
}
function vec0VectorColumns(sql) {
  const match = /^\s*CREATE\s+VIRTUAL\s+TABLE\s+.*?\bUSING\s+vec0\s*\((.*)\)\s*$/isu.exec(sql);
  if (match === null) return null;
  return [...match[1].matchAll(/\b(?:float|f32|int8|i8|bit)\s*\[/giu)].length;
}
function toDatabaseValue(value) {
  switch (value.kind) {
    case "null":
      return null;
    case "integer":
      return value.value;
    // A one-element Float64Array binds as an exact REAL even when integral.
    case "real":
      return Float64Array.of(value.value);
    case "text":
      return value.value;
    case "blob":
      return value.value.slice();
  }
}
function flag(value) {
  return value ? 1 : 0;
}
function asText(value) {
  if (typeof value !== "string") throw new Error("MATERIALIZER_PLATFORM_CORRUPT_TEXT");
  return value;
}
function asBytes(value) {
  if (!(value instanceof Uint8Array)) throw new Error("MATERIALIZER_PLATFORM_CORRUPT_BYTES");
  return Uint8Array.from(value);
}
function sameBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// packages/materializer-doltlite/src/sql-executor.ts
var SqlRejection = class extends Error {
  /** `statementIndex` is the failing step, or null for whole-transaction checks. */
  constructor(code, statementIndex) {
    super(statementIndex === null ? code : `${code} (step ${statementIndex})`);
    this.code = code;
    this.statementIndex = statementIndex;
    this.name = "SqlRejection";
  }
  code;
  statementIndex;
};
var SQLITE_CONSTRAINT = 19;
var SQLITE_CONSTRAINT_FUNCTION = 19 | 4 << 8;
var SQLITE_TOOBIG = 18;
var SQLITE_MISMATCH = 20;
var SQLITE_RANGE = 25;
var ASSERT_PREFIX = "chronolog_assert:";
var POLICY_PREFIX = "chronolog_policy:";
function executeTransactionProgram(database, program, context, limits = {}) {
  if (context.authorTimestampMs < 0n || context.authorTimestampMs > 253402300799999n) {
    throw new SqlRejection("profile:timestamp-range", null);
  }
  const platform = new PlatformSession(database, { actor: context.actor, txId: context.txId, groupId: context.groupId, limits });
  const { actorId, schemaVersion: schemaBefore } = platform.begin();
  database.setDeterministicContext(context.authorTimestampMs, prngSeed(context.txId), context.actor, actorId, context.txId);
  try {
    resetChangeCounter(database);
    let reconciledVersion = schemaBefore;
    const reconcileIfChanged = (index) => {
      if (schemaVersion(database) === reconciledVersion) return;
      try {
        platform.reconcile();
      } catch (error) {
        throw rejectionFor(error, index);
      }
      reconciledVersion = schemaVersion(database);
    };
    for (const [index, step] of program.steps.entries()) {
      if (isEmitStep(step)) continue;
      if (isPlatformOp(step)) {
        try {
          platform.execute(step, index);
        } catch (error) {
          throw rejectionFor(error, index);
        }
      } else {
        const reservedBefore = platform.reservedObjectNames();
        executeStatement(database, step, index, limits, { ddlPermissions: platform.ddlPermissions(), writeProtectedTables: writeProtectedTables(database), lifecycleTriggers: lifecycleTriggerNames(database) });
        if (schemaVersion(database) !== reconciledVersion) {
          try {
            platform.assertReservedObjectsUnchanged(reservedBefore);
          } catch (error) {
            throw rejectionFor(error, index);
          }
        }
      }
      reconcileIfChanged(index);
    }
    reconcileIfChanged(null);
  } finally {
    database.clearDeterministicContext();
  }
}
function executeStatement(database, statement, index, limits, authorization) {
  try {
    if (database.nativeProfile !== void 0) {
      const rejection = database.nativeProfile.executeReplicated(statement, authorization.ddlPermissions ?? { create: false, alter: [], drop: [], index: [], trigger: [] });
      if (rejection !== null) throw new SqlRejection(rejection, index);
      return;
    }
    withProfiledStatement(database, statement.sql, "replicated", (prepared) => {
      prepared.run(bindingArray(prepared, statement, index));
    }, limits, authorization);
  } catch (error) {
    throw rejectionFor(error, index);
  }
}
function schemaVersion(database) {
  const row = cachedInternalStatement(database, "PRAGMA schema_version").get();
  if (row === void 0 || Array.isArray(row)) throw new Error("MATERIALIZER_SCHEMA_VERSION_UNAVAILABLE");
  return Number(row.schema_version);
}
function bindingArray(prepared, statement, index) {
  const count = prepared.parameterCount;
  const values = new Array(count);
  const bound = new Array(count).fill(false);
  for (const binding of statement.bindings) {
    const position = binding.parameter.kind === "index" ? binding.parameter.index : prepared.parameterIndex(binding.parameter.name);
    if (position < 1 || position > count || bound[position - 1] === true) throw new SqlRejection("binding", index);
    values[position - 1] = toDatabaseValue(binding.value);
    bound[position - 1] = true;
  }
  if (bound.some((value) => !value)) throw new SqlRejection("binding", index);
  return values;
}
function rejectionFor(error, index) {
  if (error instanceof SqlRejection) return error;
  if (error instanceof NativeSqlRejection) return new SqlRejection(error.code, index);
  if (error instanceof PlatformRejection) return new SqlRejection(error.code, index);
  if (error instanceof SqlProfileError) {
    switch (error.code) {
      case "SQL_STEP_LIMIT":
        return new SqlRejection("step_limit", index);
      case "SQL_PROFILE_VIOLATION":
        return new SqlRejection("denied", index);
      case "SQL_STATEMENT_TOO_LARGE":
        return new SqlRejection("too_large", index);
      default:
        return new SqlRejection("prepare", index);
    }
  }
  if (isOperationalSqliteError(error)) return error instanceof Error ? error : new Error(String(error));
  const extended = sqliteExtendedCode(error);
  const message = error instanceof Error ? error.message : "";
  const assertAt = message.indexOf(ASSERT_PREFIX);
  if (extended === SQLITE_CONSTRAINT_FUNCTION && assertAt >= 0) {
    return new SqlRejection(`assert:${message.slice(assertAt + ASSERT_PREFIX.length)}`, index);
  }
  const policyAt = message.indexOf(POLICY_PREFIX);
  if (extended === SQLITE_CONSTRAINT_FUNCTION && policyAt >= 0) {
    return new SqlRejection(`policy:${message.slice(policyAt + POLICY_PREFIX.length)}`, index);
  }
  switch (sqlitePrimaryCode(error)) {
    case SQLITE_CONSTRAINT:
      return new SqlRejection("constraint", index);
    case SQLITE_TOOBIG:
      return new SqlRejection("too_large", index);
    case SQLITE_MISMATCH:
      return new SqlRejection("mismatch", index);
    case SQLITE_RANGE:
      return new SqlRejection("binding", index);
    case null:
      return error instanceof Error ? error : new Error(String(error));
    default:
      return new SqlRejection("error", index);
  }
}
function sqliteExtendedCode(error) {
  if (typeof error !== "object" || error === null) return null;
  const value = error.sqliteExtendedCode ?? error.errcode;
  return typeof value === "number" ? value : null;
}
function prngSeed(txId) {
  let seed = 0;
  for (let index = 0; index < Math.min(4, txId.length); index += 1) seed = seed * 256 + txId[index] >>> 0;
  return seed === 0 ? 1 : seed;
}
function resetChangeCounter(database) {
  database.prepare("DELETE FROM chronolog_execution_manifest WHERE 0").run();
}

// packages/materializer-doltlite/src/sql-values.ts
function executeLocalSql(database, sql, parameters = [], inputLimits = {}) {
  const authorization = { shadowTables: shadowTables(database) };
  return withProfiledStatement(database, sql, "local_read", (statement) => {
    statement.setReturnArrays?.(true);
    statement.setReadBigInts?.(true);
    const rows2 = statement.all(...parameters.map(localValueToDatabaseValue));
    const maximumRows = inputLimits.maxResultRows ?? 1e4;
    const maximumBytes = 16 * 1024 * 1024;
    if (rows2.length > maximumRows) throw new SqlProfileError("SQL_RESULT_LIMIT");
    const columns = statement.columns().map((column, index) => ({
      name: column.name ?? `column_${index}`
    }));
    const resultRows = rows2.map((row) => {
      const values = Array.isArray(row) ? row : columns.map((column) => row[column.name]);
      return values.map(databaseValueToLocalValue);
    });
    if (approximateResultBytes(columns, resultRows) > maximumBytes) {
      throw new SqlProfileError("SQL_RESULT_LIMIT");
    }
    return { columns, rows: resultRows };
  }, inputLimits, authorization);
}
function localValueToDatabaseValue(value) {
  switch (value.kind) {
    case "null":
      return null;
    case "integer": {
      if (!/^-?(0|[1-9][0-9]*)$/u.test(value.value)) throw new SqlProfileError("SQL_INVALID_INTEGER_PARAMETER");
      const parsed = BigInt(value.value);
      if (parsed < -(1n << 63n) || parsed > (1n << 63n) - 1n) {
        throw new SqlProfileError("SQL_INVALID_INTEGER_PARAMETER");
      }
      return parsed;
    }
    case "real":
      if (!Number.isFinite(value.value)) throw new SqlProfileError("SQL_INVALID_REAL_PARAMETER");
      return Float64Array.of(value.value);
    case "text":
      return value.value;
    case "blob":
      return Uint8Array.from(value.value);
  }
}
function databaseValueToLocalValue(value) {
  if (value === null) return { kind: "null" };
  if (typeof value === "bigint") return { kind: "integer", value: value.toString(10) };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SQL_UNSUPPORTED_RESULT_TYPE");
    return { kind: "real", value };
  }
  if (typeof value === "string") return { kind: "text", value };
  if (value instanceof Uint8Array) {
    return { kind: "blob", value: Uint8Array.from(value) };
  }
  throw new Error("SQL_UNSUPPORTED_RESULT_TYPE");
}
function approximateResultBytes(columns, rows2) {
  let total = columns.reduce((sum, column) => sum + utf8(column.name).length, 0);
  for (const row of rows2) for (const value of row) {
    switch (value.kind) {
      case "null":
        total += 1;
        break;
      case "integer":
        total += utf8(value.value).length;
        break;
      case "real":
        total += 8;
        break;
      case "text":
        total += utf8(value.value).length;
        break;
      case "blob":
        total += value.value.length;
        break;
    }
    if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

// packages/materializer-doltlite/src/system-log.ts
var TRANSACTION_LOG_TABLE = "chronolog_transactions";
var EXECUTION_MANIFEST_TABLE = "chronolog_execution_manifest";
var SYSTEM_LOG_SQL = `
    CREATE TABLE ${EXECUTION_MANIFEST_TABLE} (
      singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
      manifest_digest BLOB NOT NULL CHECK (length(manifest_digest) = 32),
      canonical_manifest BLOB NOT NULL
    ) STRICT;
    CREATE TABLE ${TRANSACTION_LOG_TABLE} (
      tx_id BLOB PRIMARY KEY NOT NULL,
      order_index INTEGER NOT NULL UNIQUE,
      author_id BLOB NOT NULL,
      operation_id TEXT NOT NULL,
      author_timestamp_ms INTEGER NOT NULL,
      candidate_digest BLOB NOT NULL,
      canonical_candidate BLOB NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
      rejection_code TEXT,
      failing_statement_index INTEGER,
      CHECK (
        (outcome = 'accepted' AND rejection_code IS NULL AND failing_statement_index IS NULL)
        OR (outcome = 'rejected' AND rejection_code IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX chronolog_operation_identity ON ${TRANSACTION_LOG_TABLE}(author_id, operation_id)
  `;
function initializeSystemLog(database) {
  if (database.nativeProfile === void 0) database.exec(SYSTEM_LOG_SQL);
  else for (const statement of SYSTEM_LOG_SQL.split(";")) database.exec(statement);
}
function insertExecutionManifest(database, manifest) {
  database.prepare(`
    INSERT INTO ${EXECUTION_MANIFEST_TABLE} (singleton_key, manifest_digest, canonical_manifest) VALUES (1, ?, ?)
  `).run(manifest.manifestDigest, manifest.canonicalManifest);
}
function readExecutionManifest(database) {
  const raw = database.prepare(`
    SELECT manifest_digest, canonical_manifest FROM ${EXECUTION_MANIFEST_TABLE} WHERE singleton_key = 1
  `).get();
  if (raw === void 0 || Array.isArray(raw)) throw new Error("DATABASE_MANIFEST_MISSING");
  return { manifestDigest: asDigest(raw.manifest_digest), canonicalManifest: asBytes2(raw.canonical_manifest) };
}
function readSystemLog(database) {
  const select = `
    SELECT tx_id, order_index, author_id, operation_id, author_timestamp_ms,
           candidate_digest, canonical_candidate, outcome, rejection_code, failing_statement_index
      FROM ${TRANSACTION_LOG_TABLE}
  `;
  const decode = (raw) => {
    if (Array.isArray(raw)) throw new Error("MATERIALIZER_EXPECTED_OBJECT_ROW");
    const outcome = raw.outcome;
    if (outcome !== "accepted" && outcome !== "rejected") throw new Error("MATERIALIZER_CORRUPT_OUTCOME");
    const txId = asBytes2(raw.tx_id);
    const authorId = asBytes2(raw.author_id);
    const authorTimestampMs = asBigint(raw.author_timestamp_ms);
    return {
      txId,
      operationId: asString(raw.operation_id),
      orderIndex: Number(raw.order_index),
      authorId,
      authorTimestampMs,
      candidateDigest: asBytes2(raw.candidate_digest),
      canonicalCandidate: asBytes2(raw.canonical_candidate),
      orderKey: { authorTimestampMs, authorId, txId },
      outcome,
      rejectionCode: raw.rejection_code === null ? null : asString(raw.rejection_code),
      failingStatementIndex: raw.failing_statement_index === null ? null : Number(asBigint(raw.failing_statement_index))
    };
  };
  if (database.nativeProfile === void 0) {
    const statement = database.prepare(`${select} ORDER BY order_index`);
    statement.setReadBigInts?.(true);
    return statement.all().map(decode);
  }
  const rows2 = [];
  let after = null;
  for (; ; ) {
    const where = after === null ? "" : "WHERE order_index > ?";
    const statement = database.prepare(`${select} ${where} ORDER BY order_index LIMIT ?`);
    let limit = 32;
    let page;
    for (; ; ) {
      try {
        page = statement.all(...after === null ? [limit] : [after, limit]).map(decode);
        break;
      } catch (error) {
        if (limit === 1 || error?.code !== "SQL_RESULT_LIMIT") throw error;
        limit = Math.floor(limit / 2);
      }
    }
    rows2.push(...page);
    if (page.length < limit) return rows2;
    after = BigInt(page.at(-1).orderIndex);
  }
}
function insertSystemLogRow(database, row) {
  database.prepare(`
    INSERT INTO ${TRANSACTION_LOG_TABLE} (
      tx_id, order_index, author_id, operation_id, author_timestamp_ms,
      candidate_digest, canonical_candidate, outcome, rejection_code, failing_statement_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.txId,
    BigInt(row.orderIndex),
    row.authorId,
    row.operationId,
    row.authorTimestampMs,
    row.candidateDigest,
    row.canonicalCandidate,
    row.outcome,
    row.rejectionCode,
    row.failingStatementIndex === null ? null : BigInt(row.failingStatementIndex)
  );
}
function asBytes2(value) {
  if (!(value instanceof Uint8Array)) throw new Error("MATERIALIZER_CORRUPT_BYTES");
  return Uint8Array.from(value);
}
function asDigest(value) {
  const bytes2 = asBytes2(value);
  if (bytes2.length !== 32) throw new Error("MATERIALIZER_CORRUPT_DIGEST");
  return bytes2;
}
function asString(value) {
  if (typeof value !== "string") throw new Error("MATERIALIZER_CORRUPT_TEXT");
  return value;
}
function asBigint(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error("MATERIALIZER_CORRUPT_INTEGER");
}

// packages/materializer-doltlite/src/snapshot-evidence.ts
function materializedLogDigest(rows2) {
  const encoded = encodeCanonicalCbor(rows2.map((row) => /* @__PURE__ */ new Map([
    [0n, row.txId],
    [1n, BigInt(row.orderIndex)],
    [2n, row.authorId],
    [3n, row.authorTimestampMs],
    [4n, row.candidateDigest],
    [5n, row.canonicalCandidate],
    [6n, row.outcome],
    [7n, row.rejectionCode],
    [8n, row.failingStatementIndex === null ? null : BigInt(row.failingStatementIndex)]
  ])));
  return hashDomain(DOMAINS.materializedLog, encoded);
}

// packages/materializer-doltlite/src/platform/digest.ts
var PLATFORM_CODE_VERSION = "chronolog-platform-ops-v11-authored-replay-ddl-acl-v1";
var REFERENCE_TABLE = {
  name: 'Reference "table"',
  columns: [
    { name: "id", type: "INTEGER", notNull: true, defaultValue: null, primaryKey: 1, hidden: 0 },
    { name: "o'k", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 2, hidden: 0 },
    { name: "body", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 0, hidden: 0 },
    { name: "generated", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 0, hidden: 3 },
    { name: "chronolog_owner", type: "INTEGER", notNull: true, defaultValue: "chronolog_actor_id()", primaryKey: 0, hidden: 0 }
  ],
  primaryKey: ["id", "o'k"],
  foreignKeys: []
};
function computePlatformDigest() {
  const hash = createSha256();
  hash.update("chronolog-platform-digest-v2\n");
  hash.update(`${PLATFORM_CODE_VERSION}
`);
  hash.update(`${SQL_PROFILE_VERSION}
`);
  for (const sql of [SYSTEM_LOG_SQL, ...PLATFORM_TABLES_SQL, ...PLATFORM_VIEWS_SQL, ...platformTriggers(REFERENCE_TABLE).map((trigger) => trigger.sql)]) {
    hash.update(`${utf8(sql).length}
${sql}
`);
  }
  return Uint8Array.from(hash.digest());
}
var PLATFORM_DIGEST = computePlatformDigest();

// packages/materializer-doltlite/src/materializer.ts
var MaterializerInputError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "MaterializerInputError";
  }
  code;
};
var DeterministicMaterializer = class _DeterministicMaterializer {
  #readLeases = /* @__PURE__ */ new Set();
  #writer;
  #readers = /* @__PURE__ */ new Set();
  #reader;
  #finalReader;
  #writerClosed = false;
  #finalPublished;
  #finalLog;
  #sourceOptions;
  #options;
  #backend;
  #executionManifest;
  #artifacts;
  #rootPrincipal;
  #subscribers = /* @__PURE__ */ new Set();
  #published;
  #checkpoints;
  #order;
  #log;
  #closed = false;
  #materializing = false;
  #checkpointError = null;
  constructor(writer, reader, options, backend, executionManifest, artifacts, published, checkpoints, log, finalReader, finalPublished, finalLog) {
    this.#writer = writer;
    this.#reader = reader;
    this.#finalReader = finalReader;
    this.#readers.add(reader);
    this.#readers.add(finalReader);
    this.#finalPublished = finalPublished;
    this.#finalLog = finalLog;
    this.#sourceOptions = options;
    this.#backend = backend;
    this.#executionManifest = structuredClone(executionManifest);
    this.#artifacts = artifacts;
    this.#rootPrincipal = copyBytes(options.rootPrincipal);
    this.#published = published;
    this.#checkpoints = checkpoints;
    this.#log = log;
    this.#order = log.map((row) => copyBytes(row.txId));
    this.#options = {
      checkpointEvery: validatePositiveInteger(options.checkpointEvery ?? 100, "checkpointEvery"),
      retainCheckpoints: validatePositiveInteger(options.retainCheckpoints ?? 16, "retainCheckpoints")
    };
  }
  static async open(input) {
    if (!(input.rootPrincipal instanceof Uint8Array) || input.rootPrincipal.length !== 32) {
      throw new MaterializerInputError("MATERIALIZER_ROOT_PRINCIPAL_INVALID");
    }
    if (typeof input.engine?.openDatabase !== "function") throw new MaterializerInputError("MATERIALIZER_ENGINE_FACTORY_REQUIRED");
    const options = {
      ...input,
      rootPrincipal: input.rootPrincipal.slice(),
      engine: { executionManifest: structuredClone(input.engine.executionManifest), openDatabase: input.engine.openDatabase.bind(input.engine) }
    };
    if (!equalBytes(options.engine.executionManifest.platformDigest, PLATFORM_DIGEST)) {
      throw new MaterializerInputError("MATERIALIZER_PLATFORM_DIGEST_MISMATCH");
    }
    const artifacts = await executionManifestArtifacts(options.engine.executionManifest);
    const expected = { artifacts, rootPrincipal: options.rootPrincipal };
    const opened = openDatabase(options);
    let reader = null;
    let finalReader = null;
    try {
      if (!equalBytes(opened.backend.engineDigest, options.engine.executionManifest.engineDigest)) {
        throw new MaterializerInputError("MATERIALIZER_ENGINE_DIGEST_MISMATCH");
      }
      let published = discoverPublishedRef(opened.database);
      if (published === null) {
        published = initializeRepository(opened.database, expected, options.forkSeeding === true);
      } else {
        resetActiveWorkingSet(opened.database);
        opened.database.doltCheckout(HEAD_BRANCH);
        verifyDatabaseState(opened.database, expected);
      }
      const log = readSystemLog(opened.database);
      const retainedTransactions = log.map((row) => ({
        txId: row.txId,
        candidateDigest: row.candidateDigest,
        canonicalCandidate: row.canonicalCandidate,
        core: decodeTransactionCore(row.canonicalCandidate)
      }));
      await validateTransactionSet(retainedTransactions, []);
      verifyDesiredLog(log, retainedTransactions);
      if (retainedTransactions.some((transaction) => !equalBytes(transaction.core.executionManifestDigest, artifacts.executionManifestDigest))) {
        throw new MaterializerInputError("MATERIALIZER_EXECUTION_MANIFEST_UNAVAILABLE");
      }
      verifyPublishedLog(published, log);
      const checkpoints = validateCheckpointRefs(opened.database, published, log, artifacts);
      cleanupOrphanBranches(opened.database, published, checkpoints);
      reader = openPublishedReader(options, opened.database, published.doltCommitHash);
      verifyDatabaseState(reader.database, expected);
      const readerLog = readSystemLog(reader.database);
      verifyPublishedLog(published, readerLog);
      if (reader.database.doltHashOf(reader.branchRef) !== published.contentHash) {
        throw new Error("MATERIALIZER_READER_CONTENT_MISMATCH");
      }
      const finalPublished = discoverFinalRef(opened.database) ?? publishFinalRef(
        opened.database,
        0n,
        [],
        checkpoints.find((checkpoint) => checkpoint.prefixLength === 0).doltCommitHash
      );
      finalReader = openPublishedReader(options, opened.database, finalPublished.doltCommitHash);
      verifyDatabaseState(finalReader.database, expected);
      const finalLog = readSystemLog(finalReader.database);
      verifyPublishedLog(finalPublished, finalLog);
      verifyFinalPrefix(finalLog, readerLog);
      return new _DeterministicMaterializer(
        opened.database,
        reader,
        options,
        opened.backend,
        options.engine.executionManifest,
        artifacts,
        published,
        checkpoints,
        readerLog,
        finalReader,
        finalPublished,
        finalLog
      );
    } catch (error) {
      reader?.database.close();
      finalReader?.database.close();
      opened.database.close();
      throw error;
    }
  }
  get revision() {
    return this.#published.revision;
  }
  get orderLength() {
    return this.#order.length;
  }
  get finalRevision() {
    return this.#finalPublished.revision;
  }
  get finalOrderLength() {
    return this.#finalLog.length;
  }
  get executionManifestDigest() {
    return copyBytes(this.#artifacts.executionManifestDigest);
  }
  get executionManifest() {
    return structuredClone(this.#executionManifest);
  }
  get backend() {
    return structuredClone(this.#backend);
  }
  get checkpointError() {
    return this.#checkpointError;
  }
  get databaseContentHash() {
    return this.#published.contentHash;
  }
  proposalIdAt(index) {
    return this.#order[index]?.slice() ?? null;
  }
  transactionLogDigest() {
    return materializedLogDigest(this.#log);
  }
  checkpoints() {
    return this.#checkpoints.map((checkpoint) => structuredClone(checkpoint));
  }
  transactionLog() {
    return this.#log.map(cloneLogRow);
  }
  outcome(txId) {
    const row = this.#log.find((entry) => equalBytes(entry.txId, txId));
    if (row === void 0) return null;
    return {
      txId: copyBytes(row.txId),
      orderKey: structuredClone(row.orderKey),
      orderIndex: row.orderIndex,
      outcome: row.outcome,
      rejectionCode: row.rejectionCode,
      failingStatementIndex: row.failingStatementIndex
    };
  }
  localSql(sql, parameters = [], options = {}) {
    this.#assertOpen();
    const final = options.view === "final";
    const revision = final ? this.finalRevision : this.revision;
    if (options.atRevision !== void 0 && options.atRevision !== revision) {
      throw new MaterializerInputError("MATERIALIZER_REVISION_UNAVAILABLE");
    }
    const result = executeLocalSql((final ? this.#finalReader : this.#reader).database, sql, parameters);
    return { revision, orderLength: final ? this.finalOrderLength : this.orderLength, view: final ? "final" : "local", finalOrderLength: this.finalOrderLength, ...result };
  }
  localQuery(sql, parameters = [], options = {}) {
    return this.localSql(sql, parameters, options);
  }
  captureApplication(options = {}) {
    this.#assertOpen();
    const view = options.view ?? "local";
    const log = view === "final" ? this.#finalLog : this.#log;
    return {
      view,
      revision: view === "final" ? this.finalRevision : this.revision,
      orderLength: log.length,
      finalRevision: this.finalRevision,
      finalOrderLength: this.finalOrderLength,
      transactionAt(index) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= log.length) return null;
        const entry = log[index];
        return { txId: copyBytes(entry.txId), canonicalCandidate: copyBytes(entry.canonicalCandidate), outcome: entry.outcome };
      }
    };
  }
  captureRead(options = {}) {
    this.#assertOpen();
    if (this.#readLeases.size >= 16) throw new Error("MATERIALIZER_SNAPSHOT_LIMIT");
    const application = this.captureApplication(options);
    const { view, revision, orderLength, finalOrderLength } = application;
    const reader = view === "final" ? this.#finalReader : this.#reader;
    reader.leases++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#readLeases.delete(release);
      reader.leases--;
      if (!this.#closed) this.#closeRetiredReader(reader);
    };
    this.#readLeases.add(release);
    return {
      ...application,
      query(sql, parameters = []) {
        if (released) throw new Error("MATERIALIZER_SNAPSHOT_RELEASED");
        return { revision, orderLength, finalOrderLength, view, ...executeLocalSql(reader.database, sql, parameters) };
      },
      release
    };
  }
  subscribe(subscriber) {
    this.#assertOpen();
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }
  async materialize(orderedTransactions) {
    this.#assertOpen();
    if (this.#materializing) throw new Error("MATERIALIZER_REENTRANT_CALL");
    this.#materializing = true;
    let replayBranch = null;
    let revisionBranch2 = null;
    let newCheckpoint = null;
    let candidateReader = null;
    let publishedMoved = false;
    let replayBaseRef = null;
    try {
      const transactions = orderedTransactions.map(cloneTransaction);
      await validateTransactionSet(transactions, this.#log);
      for (const transaction of transactions) {
        if (!equalBytes(transaction.core.executionManifestDigest, this.#artifacts.executionManifestDigest)) {
          throw new MaterializerInputError("MATERIALIZER_EXECUTION_MANIFEST_UNAVAILABLE");
        }
      }
      verifyFinalTransactions(this.#finalLog, transactions);
      validateExistingIdentities(this.#log, transactions);
      const changedAt = earliestDifference(this.#order, transactions.map((transaction) => transaction.txId));
      if (changedAt === null) return null;
      const difference = changedAt;
      const previousRevision = this.revision;
      const previousLog = this.#log;
      const isAppend = difference === this.#order.length;
      const checkpoint = isAppend ? null : this.#checkpointAtOrBefore(difference);
      if (!isAppend && checkpoint === null) throw new Error("MATERIALIZER_GENESIS_CHECKPOINT_MISSING");
      const baseRef = isAppend ? this.#published.doltCommitHash : checkpoint.doltCommitHash;
      replayBaseRef = baseRef;
      const replayFrom = isAppend ? this.#order.length : checkpoint.prefixLength;
      const nextRevision = previousRevision + 1n;
      replayBranch = createReplayBranch(this.#writer, nextRevision, baseRef);
      this.#writer.doltCheckout(replayBranch);
      verifyDatabaseState(this.#writer, this.#expected);
      verifyReplayBase(readSystemLog(this.#writer), transactions, replayFrom);
      for (let index = replayFrom; index < transactions.length; index += 1) {
        verifyNextLogIndex(this.#writer, index);
        this.#applyTransaction(transactions[index], index);
      }
      const candidateLog = readSystemLog(this.#writer);
      verifyDesiredLog(candidateLog, transactions);
      verifyDatabaseState(this.#writer, this.#expected);
      const commitHash = this.#writer.prepare("SELECT * FROM dolt_status").all().length === 0 ? baseRef : this.#writer.doltCommit(`chronolog revision ${nextRevision}`);
      const contentHash = this.#writer.doltHashOf(commitHash);
      if (contentHash !== this.#writer.doltHashOf()) throw new Error("MATERIALIZER_COMMIT_CONTENT_MISMATCH");
      this.#publicationFault("after_candidate_commit");
      const retainedBeforeInsertion = this.#checkpoints.filter(
        (entry) => isAppend || entry.prefixLength <= difference
      );
      if (shouldCheckpoint(retainedBeforeInsertion, transactions.length, this.#options.checkpointEvery)) {
        newCheckpoint = createCheckpointRef(this.#writer, transactions.length, nextRevision, commitHash, candidateLog);
      }
      const nextPublished = createRevisionRef(this.#writer, nextRevision, transactions.length, commitHash, candidateLog);
      revisionBranch2 = nextPublished.branchRef;
      if (nextPublished.contentHash !== contentHash) throw new Error("MATERIALIZER_REVISION_CONTENT_MISMATCH");
      this.#publicationFault("after_revision_ref_created");
      candidateReader = openPublishedReader(this.#sourceOptions, this.#writer, nextPublished.doltCommitHash);
      verifyDatabaseState(candidateReader.database, this.#expected);
      const readerLog = readSystemLog(candidateReader.database);
      verifyPublishedLog(nextPublished, readerLog);
      if (candidateReader.database.doltHashOf(candidateReader.branchRef) !== contentHash) {
        throw new Error("MATERIALIZER_CANDIDATE_READER_CONTENT_MISMATCH");
      }
      this.#publicationFault("before_head_publish");
      publishRef(this.#writer, nextPublished);
      publishedMoved = true;
      this.#publicationFault("after_head_publish");
      const oldReader = this.#reader;
      this.#reader = candidateReader;
      this.#readers.add(candidateReader);
      candidateReader = null;
      this.#published = nextPublished;
      this.#log = readerLog;
      this.#order = transactions.map((transaction) => copyBytes(transaction.txId));
      oldReader.retired = true;
      this.#closeRetiredReader(oldReader);
      this.#publicationFault("after_reader_swap");
      try {
        this.#writer.doltCheckout(HEAD_BRANCH);
        const retained = newCheckpoint === null ? retainedBeforeInsertion : [...retainedBeforeInsertion, newCheckpoint];
        this.#checkpoints = this.#pruneCheckpoints(retained);
        cleanupOrphanBranches(this.#writer, nextPublished, this.#checkpoints, [...this.#readers].map((reader) => reader.branchRef));
        this.#checkpointError = null;
      } catch (error) {
        this.#checkpointError = nonThrowingDiagnostic(error, "CHECKPOINT_CLEANUP_FAILED");
      }
      const event = {
        revision: nextRevision,
        previousRevision,
        orderLength: transactions.length,
        replayFromIndex: replayFrom,
        replayedTransactions: transactions.length - replayFrom,
        checkpointPrefix: checkpoint?.prefixLength ?? replayFrom,
        contentHash,
        manifestDigest: this.executionManifestDigest,
        earliestChangedOrderIndex: difference,
        outcomeChanges: calculateOutcomeChanges(previousLog, this.#log)
      };
      for (const subscriber of [...this.#subscribers]) {
        try {
          subscriber(structuredClone(event));
        } catch {
        }
      }
      return event;
    } catch (error) {
      candidateReader?.database.close();
      rollbackIfActive(this.#writer);
      if (!publishedMoved) {
        try {
          if (replayBaseRef !== null && replayBranch !== null && this.#writer.doltActiveBranch() === replayBranch) {
            this.#writer.doltResetHard(replayBaseRef);
          }
          this.#writer.doltCheckout(HEAD_BRANCH);
          if (replayBranch !== null) removeBranchIfPresent(this.#writer, replayBranch);
          if (revisionBranch2 !== null) removeBranchIfPresent(this.#writer, revisionBranch2);
          if (newCheckpoint !== null) removeBranchIfPresent(this.#writer, newCheckpoint.branchRef);
        } catch {
        }
      }
      throw error;
    } finally {
      this.#materializing = false;
    }
  }
  async publishFinal(prefixLength) {
    this.#assertOpen();
    if (!Number.isSafeInteger(prefixLength) || prefixLength < this.finalOrderLength || prefixLength > this.orderLength) {
      throw new MaterializerInputError("MATERIALIZER_FINAL_PREFIX_INVALID");
    }
    if (prefixLength === this.finalOrderLength) return;
    if (this.#materializing) throw new Error("MATERIALIZER_REENTRANT_CALL");
    this.#materializing = true;
    let replayBranch = null;
    let replayBaseRef = null;
    let replayCommitted = false;
    let reader = null;
    try {
      const prefix = this.#log.slice(0, prefixLength);
      const transactions = prefix.map((row) => ({
        txId: row.txId,
        candidateDigest: row.candidateDigest,
        canonicalCandidate: row.canonicalCandidate,
        core: decodeTransactionCore(row.canonicalCandidate)
      }));
      let commitHash;
      if (prefixLength === this.#log.length) {
        commitHash = this.#published.doltCommitHash;
      } else {
        const checkpoint = this.#checkpointAtOrBefore(prefixLength);
        if (checkpoint === null) throw new Error("MATERIALIZER_GENESIS_CHECKPOINT_MISSING");
        const base = this.#finalPublished.prefixLength >= checkpoint.prefixLength ? this.#finalPublished : checkpoint;
        replayBaseRef = base.doltCommitHash;
        replayBranch = createReplayBranch(this.#writer, this.revision, replayBaseRef);
        this.#writer.doltCheckout(replayBranch);
        verifyDatabaseState(this.#writer, this.#expected);
        const baseLog = readSystemLog(this.#writer);
        verifyReplayBase(baseLog, transactions, base.prefixLength);
        verifyFinalPrefix(this.#finalLog, baseLog);
        for (let index = base.prefixLength; index < prefixLength; index += 1) {
          const transaction = transactions[index];
          this.#applyTransaction(transaction, index);
        }
        verifyFinalPrefix(prefix, readSystemLog(this.#writer));
        commitHash = this.#writer.prepare("SELECT * FROM dolt_status").all().length === 0 ? replayBaseRef : this.#writer.doltCommit(`chronolog final prefix ${prefixLength}`);
        replayCommitted = true;
      }
      reader = openPublishedReader(this.#sourceOptions, this.#writer, commitHash);
      verifyDatabaseState(reader.database, this.#expected);
      const log = readSystemLog(reader.database);
      if (log.length !== prefixLength) throw new Error("MATERIALIZER_FINAL_LOG_LENGTH_MISMATCH");
      verifyFinalPrefix(prefix, log);
      const published = publishFinalRef(this.#writer, this.finalRevision + 1n, log, commitHash);
      const oldReader = this.#finalReader;
      this.#finalReader = reader;
      this.#readers.add(reader);
      reader = null;
      this.#finalPublished = published;
      this.#finalLog = log;
      oldReader.retired = true;
      this.#closeRetiredReader(oldReader);
    } finally {
      try {
        reader?.database.close();
        rollbackIfActive(this.#writer);
        if (!replayCommitted && replayBaseRef !== null && this.#writer.doltActiveBranch() === replayBranch) {
          this.#writer.doltResetHard(replayBaseRef);
        }
        this.#writer.doltCheckout(HEAD_BRANCH);
        if (replayBranch !== null) removeBranchIfPresent(this.#writer, replayBranch);
        try {
          cleanupOrphanBranches(this.#writer, this.#published, this.#checkpoints, [...this.#readers].map((reader2) => reader2.branchRef));
          this.#checkpointError = null;
        } catch (error) {
          this.#checkpointError = nonThrowingDiagnostic(error, "CHECKPOINT_CLEANUP_FAILED");
        }
      } finally {
        this.#materializing = false;
      }
    }
  }
  close() {
    this.#closed = true;
    this.#subscribers.clear();
    for (const release of [...this.#readLeases]) release();
    const errors = [];
    for (const reader of this.#readers) {
      try {
        reader.database.close();
        this.#readers.delete(reader);
      } catch (error) {
        errors.push(error);
      }
    }
    if (!this.#writerClosed) {
      try {
        this.#writer.close();
        this.#writerClosed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "MATERIALIZER_CLOSE_FAILED");
  }
  #closeRetiredReader(reader) {
    if (!reader.retired || reader.leases !== 0) return;
    reader.database.close();
    this.#readers.delete(reader);
  }
  #applyTransaction(transaction, orderIndex) {
    this.#writer.exec("BEGIN IMMEDIATE");
    this.#writer.exec("SAVEPOINT chronolog_program");
    let rejection = null;
    try {
      const duplicate = this.#writer.prepare("SELECT tx_id FROM chronolog_transactions WHERE author_id = ? AND operation_id = ? LIMIT 1").get(transaction.core.authorId, transaction.core.operationId);
      if (duplicate !== void 0) throw new SqlRejection("operation_conflict", null);
      executeTransactionProgram(this.#writer, transaction.core.program, {
        authorTimestampMs: transaction.core.authorTimestampMs,
        txId: transaction.txId,
        actor: transaction.core.authorId,
        groupId: transaction.core.groupId
      }, this.#executionManifest.limits);
    } catch (error) {
      if (!(error instanceof SqlRejection)) {
        rollbackIfActive(this.#writer);
        throw error;
      }
      rejection = { code: error.code, statementIndex: error.statementIndex };
    }
    try {
      if (rejection !== null && !this.#writer.inTransaction) {
        this.#writer.exec("BEGIN IMMEDIATE");
      } else {
        if (rejection !== null) this.#writer.exec("ROLLBACK TO SAVEPOINT chronolog_program");
        this.#writer.exec("RELEASE SAVEPOINT chronolog_program");
      }
      insertSystemLogRow(this.#writer, logRow(transaction, orderIndex, rejection));
      this.#writer.exec("COMMIT");
    } catch (error) {
      rollbackIfActive(this.#writer);
      throw new Error(`MATERIALIZER_LOG_WRITE_FAILED:${errorMessage(error)}`, { cause: error });
    }
  }
  get #expected() {
    return { artifacts: this.#artifacts, rootPrincipal: this.#rootPrincipal };
  }
  #publicationFault(point) {
    this.#sourceOptions.publicationFaultInjector?.(point);
  }
  #checkpointAtOrBefore(prefixLength) {
    let selected = null;
    for (const checkpoint of this.#checkpoints) {
      if (checkpoint.prefixLength <= prefixLength && (selected === null || checkpoint.prefixLength > selected.prefixLength)) selected = checkpoint;
    }
    return selected;
  }
  #pruneCheckpoints(checkpoints) {
    const sorted = [...checkpoints].sort((left, right) => left.prefixLength - right.prefixLength);
    const genesis = sorted.find((checkpoint) => checkpoint.prefixLength === 0);
    const keep = sorted.slice(-Math.max(1, this.#options.retainCheckpoints - (genesis === void 0 ? 0 : 1)));
    if (genesis !== void 0 && !keep.some((checkpoint) => checkpoint.branchRef === genesis.branchRef)) keep.unshift(genesis);
    const retained = new Set(keep.map((checkpoint) => checkpoint.branchRef));
    for (const checkpoint of sorted) if (!retained.has(checkpoint.branchRef)) removeBranchIfPresent(this.#writer, checkpoint.branchRef);
    return keep;
  }
  #assertOpen() {
    if (this.#closed) throw new Error("MATERIALIZER_CLOSED");
  }
};
function openPublishedReader(options, writer, commit) {
  const branchRef = `chronolog_read_${crypto.randomUUID().replaceAll("-", "")}`;
  writer.doltBranch(branchRef, commit);
  let database;
  try {
    const opened = openDatabase(options, true);
    database = opened.database;
    if (!equalBytes(opened.backend.engineDigest, options.engine.executionManifest.engineDigest)) {
      throw new MaterializerInputError("MATERIALIZER_ENGINE_DIGEST_MISMATCH");
    }
    database.doltCheckout(branchRef);
    return { database, branchRef, leases: 0, retired: false };
  } catch (error) {
    try {
      database?.close();
    } catch {
    }
    try {
      removeBranchIfPresent(writer, branchRef);
    } catch {
    }
    throw error;
  }
}
function initializeRepository(database, expected, forkSeeding) {
  if (!isFreshRepository(database)) throw new Error("MATERIALIZER_RESERVED_HEAD_MISSING");
  database.exec("BEGIN IMMEDIATE");
  try {
    withAuthorizer(database, "internal_bootstrap", () => {
      initializeSystemLog(database);
      insertExecutionManifest(database, storedManifest(expected.artifacts));
      initializePlatform(database, expected.rootPrincipal, forkSeeding);
    });
    verifyDatabaseState(database, expected);
    database.exec("COMMIT");
  } catch (error) {
    rollbackIfActive(database);
    throw error;
  }
  const log = readSystemLog(database);
  const commitHash = database.doltCommit("chronolog genesis");
  createCheckpointRef(database, 0, 0n, commitHash, log);
  const published = createRevisionRef(database, 0n, 0, commitHash, log);
  publishRef(database, published);
  database.doltCheckout(HEAD_BRANCH);
  return published;
}
function isFreshRepository(database) {
  return database.prepare(`
    SELECT name FROM sqlite_schema
     WHERE type IN ('table', 'view', 'trigger', 'index')
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'dolt_%'
       ${database.nativeProfile === void 0 ? "" : "AND name NOT GLOB '_cf_*'"}
     LIMIT 1
  `).get() === void 0;
}
function verifyDatabaseState(database, expected) {
  const stored = readExecutionManifest(database);
  verifyStoredManifest(stored, expected.artifacts);
  if (!equalBytes(readRootPrincipal(database), expected.rootPrincipal)) {
    throw new Error("DATABASE_ROOT_PRINCIPAL_MISMATCH");
  }
}
function validateCheckpointRefs(database, published, publishedLog, artifacts) {
  const valid = [];
  for (const checkpoint of discoverCheckpoints(database)) {
    const expectedDigest = orderDigest(publishedLog.slice(0, checkpoint.prefixLength));
    if (checkpoint.prefixLength > publishedLog.length || checkpointOrderDigest(checkpoint.branchRef) !== expectedDigest) {
      removeBranchIfPresent(database, checkpoint.branchRef);
      continue;
    }
    let matches;
    try {
      database.doltCheckout(checkpoint.branchRef);
      verifyStoredManifest(readExecutionManifest(database), artifacts);
      const checkpointLog = readSystemLog(database);
      matches = checkpointLog.length === checkpoint.prefixLength && orderDigest(checkpointLog) === expectedDigest;
    } catch {
      matches = false;
    }
    database.doltCheckout(HEAD_BRANCH);
    if (!matches) {
      removeBranchIfPresent(database, checkpoint.branchRef);
      continue;
    }
    valid.push(checkpoint);
  }
  database.doltCheckout(HEAD_BRANCH);
  if (!valid.some((checkpoint) => checkpoint.prefixLength === 0)) throw new Error("MATERIALIZER_GENESIS_CHECKPOINT_MISSING");
  verifyPublishedLog(published, publishedLog);
  return valid.sort((left, right) => left.prefixLength - right.prefixLength);
}
async function validateTransactionSet(transactions, verified) {
  const seen = /* @__PURE__ */ new Set();
  const proposals = /* @__PURE__ */ new Set();
  for (const [index, transaction] of transactions.entries()) {
    if (!equalBytes(transaction.txId, transaction.candidateDigest)) throw new MaterializerInputError("MATERIALIZER_TRANSACTION_ID_INVALID");
    if (index > 0 && compareTransactionOrder(orderKeyOf(transactions[index - 1]), orderKeyOf(transaction)) >= 0) {
      throw new MaterializerInputError("MATERIALIZER_ORDER_INVALID");
    }
    if (!equalBytes(encodeTransactionCore(transaction.core), transaction.canonicalCandidate)) {
      throw new MaterializerInputError("MATERIALIZER_CANONICAL_CANDIDATE_MISMATCH");
    }
    const known = verified[index];
    const alreadyVerified = known !== void 0 && equalBytes(known.txId, transaction.txId) && equalBytes(known.canonicalCandidate, transaction.canonicalCandidate) && equalBytes(known.candidateDigest, transaction.candidateDigest);
    if (!alreadyVerified) {
      if (!equalBytes(await transactionDigest(transaction.canonicalCandidate), transaction.candidateDigest)) {
        throw new MaterializerInputError("MATERIALIZER_CANDIDATE_DIGEST_MISMATCH");
      }
    }
    const txKey = idKey(transaction.txId);
    if (seen.has(txKey)) throw new MaterializerInputError("MATERIALIZER_DUPLICATE_TRANSACTION");
    seen.add(txKey);
    const proposal = idKey(transaction.candidateDigest);
    if (proposals.has(proposal)) throw new MaterializerInputError("MATERIALIZER_DUPLICATE_PROPOSAL");
    proposals.add(proposal);
  }
}
function openDatabase(options, readOnly = false) {
  return options.engine.openDatabase({ path: options.path, ...readOnly ? { readOnly } : {} });
}
function verifyFinalTransactions(final, transactions) {
  if (transactions.length < final.length) throw new Error("MATERIALIZER_FINAL_PREFIX_CHANGED");
  for (let index = 0; index < final.length; index += 1) {
    if (!sameIdentity(final[index], transactions[index])) throw new Error("MATERIALIZER_FINAL_PREFIX_CHANGED");
  }
}
function verifyFinalPrefix(final, current) {
  if (current.length < final.length) throw new Error("MATERIALIZER_FINAL_PREFIX_CHANGED");
  for (let index = 0; index < final.length; index += 1) {
    const a = final[index], b = current[index];
    if (!equalBytes(a.txId, b.txId) || !equalBytes(a.candidateDigest, b.candidateDigest) || !equalBytes(a.canonicalCandidate, b.canonicalCandidate) || !equalBytes(a.authorId, b.authorId) || a.authorTimestampMs !== b.authorTimestampMs || a.operationId !== b.operationId || a.orderIndex !== b.orderIndex || a.outcome !== b.outcome || a.rejectionCode !== b.rejectionCode || a.failingStatementIndex !== b.failingStatementIndex) {
      throw new Error("MATERIALIZER_FINAL_PREFIX_CHANGED");
    }
  }
}
function validateExistingIdentities(existing, transactions) {
  const transactionsById = new Map(transactions.map((transaction) => [idKey(transaction.txId), transaction]));
  for (const row of existing) {
    const transaction = transactionsById.get(idKey(row.txId));
    if (transaction !== void 0 && !sameIdentity(row, transaction)) {
      throw new MaterializerInputError("MATERIALIZER_TRANSACTION_IDENTITY_CONFLICT");
    }
  }
}
function verifyReplayBase(baseLog, transactions, prefixLength) {
  if (baseLog.length !== prefixLength) throw new Error("MATERIALIZER_CHECKPOINT_PREFIX_LENGTH_MISMATCH");
  for (let index = 0; index < prefixLength; index += 1) {
    if (!sameIdentity(baseLog[index], transactions[index])) throw new Error("MATERIALIZER_CHECKPOINT_PREFIX_MISMATCH");
  }
}
function verifyNextLogIndex(database, expectedIndex) {
  const row = database.prepare(`
    SELECT count(*) AS row_count, max(order_index) AS maximum_index
      FROM chronolog_transactions
  `).get();
  if (row === void 0 || Array.isArray(row)) throw new Error("MATERIALIZER_REPLAY_LOG_STATE_UNAVAILABLE");
  const count = Number(row.row_count);
  const maximum = row.maximum_index === null ? -1 : Number(row.maximum_index);
  if (count !== expectedIndex || maximum !== expectedIndex - 1) {
    throw new Error(`MATERIALIZER_REPLAY_LOG_DRIFT:${expectedIndex}:${count}:${maximum}`);
  }
}
function verifyDesiredLog(log, transactions) {
  if (log.length !== transactions.length) throw new Error("MATERIALIZER_LOG_LENGTH_MISMATCH");
  for (let index = 0; index < log.length; index += 1) {
    if (log[index].orderIndex !== index || !sameIdentity(log[index], transactions[index])) {
      throw new Error("MATERIALIZER_LOG_ORDER_MISMATCH");
    }
  }
}
function sameIdentity(row, transaction) {
  return equalBytes(row.txId, transaction.txId) && equalBytes(row.candidateDigest, transaction.candidateDigest) && equalBytes(row.canonicalCandidate, transaction.canonicalCandidate) && equalBytes(row.authorId, transaction.core.authorId) && row.authorTimestampMs === transaction.core.authorTimestampMs && compareTransactionOrder(row.orderKey, orderKeyOf(transaction)) === 0;
}
function shouldCheckpoint(checkpoints, prefixLength, interval) {
  const nearest = checkpoints.reduce((max, checkpoint) => Math.max(max, checkpoint.prefixLength), 0);
  return prefixLength - nearest >= interval;
}
function calculateOutcomeChanges(previous, current) {
  const previousById = new Map(previous.map((row) => [idKey(row.txId), row]));
  const changes = [];
  for (const row of current) {
    const prior = previousById.get(idKey(row.txId));
    if (prior?.outcome !== row.outcome || prior.rejectionCode !== row.rejectionCode) {
      changes.push({
        txId: copyBytes(row.txId),
        previous: prior?.outcome ?? null,
        current: row.outcome,
        previousRejectionCode: prior?.rejectionCode ?? null,
        currentRejectionCode: row.rejectionCode
      });
    }
    previousById.delete(idKey(row.txId));
  }
  for (const row of previousById.values()) changes.push({
    txId: copyBytes(row.txId),
    previous: row.outcome,
    current: null,
    previousRejectionCode: row.rejectionCode,
    currentRejectionCode: null
  });
  return changes;
}
function earliestDifference(previous, next) {
  const length = Math.min(previous.length, next.length);
  for (let index = 0; index < length; index += 1) if (!equalBytes(previous[index], next[index])) return index;
  return previous.length === next.length ? null : length;
}
function logRow(transaction, orderIndex, rejection) {
  return {
    txId: transaction.txId,
    orderIndex,
    operationId: transaction.core.operationId,
    authorId: transaction.core.authorId,
    authorTimestampMs: transaction.core.authorTimestampMs,
    candidateDigest: transaction.candidateDigest,
    canonicalCandidate: transaction.canonicalCandidate,
    outcome: rejection === null ? "accepted" : "rejected",
    rejectionCode: rejection?.code ?? null,
    failingStatementIndex: rejection?.statementIndex ?? null
  };
}
function storedManifest(artifacts) {
  return {
    manifestDigest: artifacts.executionManifestDigest,
    canonicalManifest: artifacts.canonicalExecutionManifest
  };
}
function verifyStoredManifest(stored, artifacts) {
  if (!equalBytes(stored.manifestDigest, artifacts.executionManifestDigest) || !equalBytes(stored.canonicalManifest, artifacts.canonicalExecutionManifest)) {
    throw new Error("DATABASE_MANIFEST_MISMATCH");
  }
}
function rollbackIfActive(database) {
  if (database.inTransaction) database.exec("ROLLBACK");
}
function orderKeyOf(transaction) {
  return { authorTimestampMs: transaction.core.authorTimestampMs, authorId: copyBytes(transaction.core.authorId), txId: copyBytes(transaction.txId) };
}
function cloneTransaction(transaction) {
  return structuredClone(transaction);
}
function cloneLogRow(row) {
  return structuredClone(row);
}
function idKey(bytes2) {
  return bytesToBase64Url(bytes2);
}
function copyBytes(value) {
  return Uint8Array.from(value);
}
function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new MaterializerInputError(`MATERIALIZER_INVALID_${name.toUpperCase()}`);
  return value;
}
function nonThrowingDiagnostic(error, fallback) {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function resetActiveWorkingSet(database) {
  const active = database.doltActiveBranch();
  const branch = database.doltBranches().find((entry) => entry.name === active);
  if (branch === void 0) throw new Error("MATERIALIZER_ACTIVE_BRANCH_MISSING");
  database.doltResetHard(branch.hash);
}

// packages/materializer-doltlite/src/runtime-adapter.ts
function createDoltLiteMaterializationRuntime(materializer) {
  const prepared = /* @__PURE__ */ new Map();
  const publications = /* @__PURE__ */ new Map();
  const snapshot = () => ({
    revision: materializer.revision,
    orderLength: materializer.orderLength,
    executionManifestDigest: materializer.executionManifestDigest.slice()
  });
  const result = (status, publicationKey) => ({ status, publicationKey, ...snapshot() });
  const publishFinal = materializer.publishFinal?.bind(materializer);
  return {
    replay: {
      ...publishFinal === void 0 ? {} : { publishFinal },
      async materialize(orderedTransactions) {
        const revision = await materializer.materialize(orderedTransactions);
        if (revision === null) return null;
        const publication = publicationRequestForRevision(revision);
        prepared.set(publication.publicationKey, publication);
        return { revision, publication };
      }
    },
    queries: {
      capabilities: Object.freeze({ sql: true }),
      get revision() {
        return materializer.revision;
      },
      get orderLength() {
        return materializer.orderLength;
      },
      get finalRevision() {
        return materializer.finalRevision ?? 0n;
      },
      get finalOrderLength() {
        return materializer.finalOrderLength ?? 0;
      },
      get executionManifestDigest() {
        return materializer.executionManifestDigest;
      },
      proposalIdAt(index) {
        return materializer.proposalIdAt(index);
      },
      localSql(sql, parameters, options) {
        return materializer.localSql(sql, parameters, options);
      },
      outcome(txId) {
        return materializer.outcome(txId);
      },
      captureApplication(options) {
        return materializer.captureApplication(options);
      },
      captureRead(options) {
        if (materializer.captureRead === void 0) throw new Error("MATERIALIZER_SNAPSHOT_UNAVAILABLE");
        return materializer.captureRead(options);
      },
      subscribe(subscriber) {
        return materializer.subscribe((revision) => subscriber({
          revision: revision.revision,
          orderLength: revision.orderLength,
          executionManifestDigest: revision.manifestDigest.slice()
        }));
      }
    },
    publications: {
      async publish(request) {
        const previous = publications.get(request.publicationKey);
        if (previous !== void 0) {
          if (!sameRequest(previous.request, request)) {
            throw new Error("MATERIALIZATION_PUBLICATION_KEY_REUSED");
          }
          return copyResult(previous.result);
        }
        const candidate = prepared.get(request.publicationKey);
        if (candidate === void 0 || !sameRequest(candidate, request)) {
          throw new Error("MATERIALIZATION_PUBLICATION_NOT_PREPARED");
        }
        if (materializer.revision !== request.targetRevision || materializer.orderLength !== request.targetOrderLength) {
          throw new Error("MATERIALIZATION_PUBLICATION_NOT_CURRENT");
        }
        const completed = result("already_current", request.publicationKey);
        publications.set(request.publicationKey, { request: { ...request }, result: completed });
        prepared.delete(request.publicationKey);
        return copyResult(completed);
      },
      async reconcile(expectation) {
        if (materializer.orderLength !== expectation.targetOrderLength || expectation.targetRevision !== void 0 && materializer.revision !== expectation.targetRevision) {
          throw new Error("MATERIALIZATION_RECONCILIATION_MISMATCH");
        }
        return result("reconciled", null);
      }
    },
    close() {
      materializer.close();
    }
  };
}
function copyResult(value) {
  return {
    status: value.status,
    publicationKey: value.publicationKey,
    revision: value.revision,
    orderLength: value.orderLength,
    executionManifestDigest: value.executionManifestDigest.slice()
  };
}
function sameRequest(left, right) {
  return left.publicationKey === right.publicationKey && left.expectedRevision === right.expectedRevision && left.targetRevision === right.targetRevision && left.targetOrderLength === right.targetOrderLength && left.candidateIdentity === right.candidateIdentity;
}

// packages/materializer-doltlite/src/engine-manifest.ts
var strings = ["doltliteVersion", "doltliteSourceSha256", "sqliteVecVersion", "sqliteVecSourceSha256", "chronologPatchProfile"];
var flags = ["fts5", "json1", "rtree", "dynamicExtensions"];
function normalizeEngineManifest(value) {
  const invalid = () => {
    throw new Error("MATERIALIZER_ENGINE_MANIFEST_INVALID");
  };
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== strings.length + flags.length) return invalid();
  const result = {};
  for (const key of [...strings, ...flags]) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === void 0 || !property.enumerable || !("value" in property)) return invalid();
    const item = property.value;
    if (strings.some((field) => field === key)) {
      if (typeof item !== "string" || item.length < 1 || item.length > 1024) return invalid();
      result[key] = item;
    } else {
      if (typeof item !== "boolean") return invalid();
      result[key] = item;
    }
  }
  for (const key of ["doltliteSourceSha256", "sqliteVecSourceSha256"]) {
    if (!/^[0-9a-f]{64}$/u.test(result[key])) return invalid();
  }
  return result;
}
function engineManifestDescriptor(manifest) {
  const captured = normalizeEngineManifest(manifest);
  return `chronolog-engine-manifest-v1
${canonicalJson(captured, { maxBytes: 4096, maxNodes: 16, maxDepth: 2 })}`;
}
function digestEngineManifest(manifest) {
  return sha256Sync(utf8(engineManifestDescriptor(manifest)));
}

// packages/materializer-doltlite/src/manifest.ts
function createDoltLiteExecutionManifest(options) {
  return createExecutionManifest({
    profile: "chronolog-sql-v1",
    engineDigest: options.engineDigest,
    platformDigest: PLATFORM_DIGEST,
    ...options.limits === void 0 ? {} : { limits: options.limits }
  });
}

// packages/materializer-doltlite/src/database.ts
function configureSqlDatabase(database, manifest) {
  try {
    for (const method of [
      "setAuthorizer",
      "setProgressHandler",
      "setLimit",
      "interrupt",
      "configureSecurity",
      "doltCommit",
      "doltBranch",
      "doltCheckout",
      "doltResetHard",
      "doltForceBranch",
      "doltDeleteBranch",
      "doltHashOf",
      "doltVersion",
      "doltBranches",
      "doltActiveBranch"
    ]) {
      if (typeof database[method] !== "function") throw new Error(`MATERIALIZER_ENGINE_API_MISSING:${method}`);
    }
    const nativeManifest = normalizeEngineManifest(manifest);
    const security = database.configureSecurity();
    assertNativeSecurityConfiguration(security);
    configureSqliteLimits(database);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA trusted_schema = OFF");
    if (Number(scalar(database, "PRAGMA recursive_triggers")) !== 1) throw new Error("MATERIALIZER_RECURSIVE_TRIGGERS_UNAVAILABLE");
    const sqliteVersion = scalar(database, "SELECT sqlite_version()");
    if (typeof sqliteVersion !== "string") throw new Error("MATERIALIZER_SQLITE_VERSION_UNAVAILABLE");
    let vecVersion = null;
    try {
      const version = scalar(database, "SELECT vec_version()");
      if (typeof version === "string") vecVersion = version;
    } catch {
    }
    return { database, security, backend: {
      engine: "doltlite",
      version: database.doltVersion(),
      sqliteVersion,
      vecVersion,
      nativeManifest,
      engineDigest: digestEngineManifest(nativeManifest),
      securityConfigured: true
    } };
  } catch (error) {
    database.close();
    throw error;
  }
}
function scalar(database, sql) {
  const statement = database.prepare(sql);
  try {
    const row = statement.get();
    return row === void 0 ? void 0 : Array.isArray(row) ? row[0] : Object.values(row)[0];
  } finally {
    statement.finalize?.();
  }
}

// packages/materializer-doltlite/src/wasm-engine.ts
var SECURITY = {
  defensive: true,
  trustedSchema: true,
  loadExtension: true,
  dqsDml: true,
  dqsDdl: true,
  qpsg: true,
  ftsTokenizer: true,
  writableSchema: true,
  extendedResultCodes: true,
  attachCreate: true,
  attachWrite: true,
  reverseScanOrder: true,
  fpDigits: true
};
var PATCH_PROFILE = "authorizer-progress-limits-tailoffset-dolt-refs-static-vec-dolt-compat-real-empty-blob-bind-deterministic-context-assert-parameters-actor-policy-trigger-lint-actor-id-vec-innocuous-row-key-exact-values-tx-id-v8";
function verifyWasmBuild(bytes2, manifest) {
  if (manifest.format !== 1 || manifest.toolchain !== "emscripten-4.0.20" || bytes2.length !== manifest.wasmBytes || bytesToHex(sha256Sync(bytes2)) !== manifest.wasmSha256) throw new Error("WASM_ENGINE_BUILD_MISMATCH");
  if (manifest.portabilityPatches?.length !== 3 || manifest.portabilityPatches[0] !== "chunk-store-optional-sector-size-v1" || manifest.portabilityPatches[1] !== "chunk-store-optional-has-moved-v1" || manifest.portabilityPatches[2] !== "vfs-identity-forwarding-v1") {
    throw new Error("WASM_ENGINE_PORTABILITY_PROFILE_UNSUPPORTED");
  }
  const nativeManifest = normalizeEngineManifest(manifest.nativeManifest);
  if (nativeManifest.doltliteVersion !== "0.11.29" || nativeManifest.sqliteVecVersion !== "0.1.9" || nativeManifest.chronologPatchProfile !== PATCH_PROFILE) throw new Error("WASM_ENGINE_PROFILE_UNSUPPORTED");
}
function createBrowserSqlEngine(options) {
  const { module, manifest, vfs, limits } = options;
  const nativeManifest = normalizeEngineManifest(manifest.nativeManifest);
  const engineDigest = digestEngineManifest(nativeManifest);
  const runtimeVersions = { ...manifest.runtimeVersions };
  withBytes(module.wasm, utf8(vfs), (pointer) => {
    const rc = module.wasm.xCall("chronolog_wasm_init", pointer);
    if (rc !== 0) throw new Error(`WASM_ENGINE_VFS_UNAVAILABLE:${vfs}:${rc}`);
  });
  const openDatabase2 = (options2) => {
    if (typeof options2.path !== "string" || options2.path.length === 0 || options2.path === ":memory:") throw new Error("MATERIALIZER_PERSISTENT_PATH_REQUIRED");
    const opened = configureSqlDatabase(new WasmDatabase(module, options2.path), nativeManifest);
    try {
      if (opened.backend.version !== runtimeVersions.doltlite || opened.backend.sqliteVersion !== runtimeVersions.sqlite || opened.backend.vecVersion !== runtimeVersions.vec) throw new Error("WASM_ENGINE_VERSION_MISMATCH");
      return opened;
    } catch (error) {
      opened.database.close();
      throw error;
    }
  };
  return Object.freeze({ openDatabase: openDatabase2, executionManifest: createDoltLiteExecutionManifest({
    engineDigest,
    ...limits === void 0 ? {} : { limits }
  }) });
}
var WasmDatabase = class {
  module;
  pointer;
  #statements = /* @__PURE__ */ new Set();
  #closed = false;
  constructor(module, path) {
    this.module = module;
    const output = module.wasm.alloc(4);
    try {
      module.wasm.heap8u().fill(0, output, output + 4);
      const rc = module.capi.sqlite3_open_v2(path, output, 2 | 4, "chronolog");
      this.pointer = module.wasm.peekPtr(output);
      if (rc !== 0) {
        const error = this.error(rc);
        if (this.pointer !== 0) module.capi.sqlite3_close_v2(this.pointer);
        throw error;
      }
    } finally {
      module.wasm.dealloc(output);
    }
  }
  get inTransaction() {
    this.assertOpen();
    return this.module.capi.sqlite3_get_autocommit(this.pointer) === 0;
  }
  exec(sql) {
    this.assertOpen();
    this.check(this.module.capi.sqlite3_exec(this.pointer, sql, 0, 0, 0));
  }
  prepare(sql) {
    this.assertOpen();
    const statement = new WasmStatement(this, sql, () => {
      this.#statements.delete(statement);
    });
    this.#statements.add(statement);
    return statement;
  }
  close() {
    if (this.#closed) return;
    for (const statement of [...this.#statements]) statement.finalize();
    this.check(this.module.capi.sqlite3_close_v2(this.pointer));
    this.#closed = true;
  }
  configureSecurity() {
    this.check(this.module.wasm.xCall("chronolog_wasm_security", this.pointer));
    return { ...SECURITY };
  }
  triggerUsesIgnore(sql) {
    return withBytes(this.module.wasm, utf8(sql), (pointer) => this.module.wasm.xCall("chronolog_wasm_trigger", pointer) !== 0);
  }
  setAuthorizer(callback) {
    this.check(this.module.capi.sqlite3_set_authorizer(
      this.pointer,
      callback === null ? null : (_context, action, a, b, c, d) => callback(action, a || null, b || null, c || null, d || null),
      0
    ));
  }
  setProgressHandler(steps, callback) {
    this.module.capi.sqlite3_progress_handler(this.pointer, steps, callback === null ? null : () => callback() ? 1 : 0, 0);
  }
  setLimit(category, value) {
    return this.module.capi.sqlite3_limit(this.pointer, category, value);
  }
  interrupt() {
    this.module.capi.sqlite3_interrupt(this.pointer);
  }
  setDeterministicContext(unixMs, seed, actor = null, actorId = null, transactionId = null) {
    if (unixMs < 0n || unixMs > 253402300799999n || actor !== null && (actor.length < 1 || actor.length > 64) || actorId !== null && (actorId < 1n || actorId > (1n << 63n) - 1n) || transactionId !== null && transactionId.length === 0) throw new Error("WASM_DETERMINISTIC_CONTEXT_INVALID");
    const withActor = (actorPointer) => {
      const apply = (transactionPointer) => {
        this.module.wasm.xCall(
          "chronolog_wasm_context",
          this.pointer,
          unixMs,
          seed >>> 0,
          actorPointer,
          actor?.length ?? 0,
          actorId === null ? 0 : 1,
          actorId ?? 0n,
          transactionPointer,
          transactionId?.length ?? 0
        );
      };
      if (transactionId === null) apply(0);
      else withBytes(this.module.wasm, transactionId, apply);
    };
    if (actor === null) withActor(0);
    else withBytes(this.module.wasm, actor, withActor);
  }
  clearDeterministicContext() {
    this.module.wasm.xCall("chronolog_wasm_clear");
  }
  doltCommit(message) {
    return String(this.scalar("SELECT dolt_commit('-A', '-m', ?)", message));
  }
  doltBranch(name, from) {
    this.scalar(from === void 0 ? "SELECT dolt_branch(?)" : "SELECT dolt_branch(?, ?)", ...from === void 0 ? [name] : [name, from]);
  }
  doltCheckout(branch) {
    this.scalar("SELECT dolt_checkout(?)", branch);
  }
  doltResetHard(ref) {
    this.scalar("SELECT dolt_reset('--hard', ?)", ref);
  }
  doltForceBranch(name, ref) {
    this.scalar("SELECT dolt_branch('-f', ?, ?)", name, ref);
  }
  doltDeleteBranch(name) {
    this.scalar("SELECT dolt_branch('-D', ?)", name);
  }
  doltHashOf(ref = "HEAD") {
    return String(this.scalar("SELECT DOLT_HASHOF_DB(?)", ref));
  }
  doltVersion() {
    return String(this.scalar("SELECT dolt_version()"));
  }
  doltBranches() {
    const statement = this.prepare("SELECT name, hash FROM dolt_branches");
    try {
      return statement.all().map((row) => {
        const value = row;
        return { name: String(value.name), hash: String(value.hash) };
      });
    } finally {
      statement.finalize?.();
    }
  }
  doltActiveBranch() {
    return String(this.scalar("SELECT active_branch()"));
  }
  scalar(sql, ...parameters) {
    const statement = this.prepare(sql);
    try {
      statement.setReturnArrays?.(true);
      return statement.get(...parameters)?.[0];
    } finally {
      statement.finalize?.();
    }
  }
  check(code) {
    if (code !== 0) throw this.error(code);
  }
  error(code) {
    const extended = this.pointer === 0 ? code : this.module.capi.sqlite3_extended_errcode(this.pointer);
    return Object.assign(new Error(this.pointer === 0 ? `SQLite error ${code}` : this.module.capi.sqlite3_errmsg(this.pointer)), {
      sqliteCode: code & 255,
      sqliteExtendedCode: extended || code
    });
  }
  assertOpen() {
    if (this.#closed) throw new Error("WASM_DATABASE_CLOSED");
  }
};
var WasmStatement = class {
  sourceSQL;
  tailOffset;
  parameterCount;
  #database;
  #pointer;
  #onClose;
  #arrays = false;
  #bigints = false;
  #closed = false;
  constructor(database, sql, onClose) {
    this.#database = database;
    this.#onClose = onClose;
    const { capi, wasm } = database.module;
    const pointers = wasm.alloc(8);
    try {
      wasm.heap8u().fill(0, pointers, pointers + 8);
      const bytes2 = utf8(sql);
      const prepared = withBytes(wasm, bytes2, (pointer) => {
        const rc = capi.sqlite3_prepare_v3(database.pointer, pointer, bytes2.length, 0, pointers, pointers + 4);
        const statement = wasm.peekPtr(pointers);
        if (rc !== 0) {
          if (statement !== 0) capi.sqlite3_finalize(statement);
          throw database.error(rc);
        }
        return { statement, tail: wasm.peekPtr(pointers + 4) - pointer };
      });
      if (prepared.statement === 0) throw new Error("SQL_EMPTY_STATEMENT");
      this.#pointer = prepared.statement;
      this.tailOffset = prepared.tail;
      this.sourceSQL = capi.sqlite3_sql(this.#pointer);
      this.parameterCount = capi.sqlite3_bind_parameter_count(this.#pointer);
    } finally {
      wasm.dealloc(pointers);
    }
  }
  finalize() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.module.capi.sqlite3_finalize(this.#pointer);
    this.#onClose();
  }
  setReturnArrays(enabled) {
    this.#arrays = enabled;
  }
  setReadBigInts(enabled) {
    this.#bigints = enabled;
  }
  columns() {
    this.#assertOpen();
    const capi = this.#database.module.capi;
    return Array.from({ length: capi.sqlite3_column_count(this.#pointer) }, (_, index) => ({ name: capi.sqlite3_column_name(this.#pointer, index) }));
  }
  parameterIndex(name) {
    for (let index = 1; index <= this.parameterCount; index += 1) if (this.#database.module.capi.sqlite3_bind_parameter_name(this.#pointer, index) === name) return index;
    return 0;
  }
  run(...parameters) {
    this.#bind(parameters);
    const capi = this.#database.module.capi;
    try {
      let code;
      do {
        code = capi.sqlite3_step(this.#pointer);
      } while (code === 100);
      if (code !== 101) throw this.#database.error(code);
      return { changes: Number(capi.sqlite3_changes64(this.#database.pointer)), lastInsertRowid: capi.sqlite3_last_insert_rowid(this.#database.pointer) };
    } finally {
      capi.sqlite3_reset(this.#pointer);
    }
  }
  get(...parameters) {
    this.#bind(parameters);
    const capi = this.#database.module.capi;
    try {
      const code = capi.sqlite3_step(this.#pointer);
      if (code === 101) return void 0;
      if (code !== 100) throw this.#database.error(code);
      return this.#row();
    } finally {
      capi.sqlite3_reset(this.#pointer);
    }
  }
  all(...parameters) {
    this.#bind(parameters);
    const capi = this.#database.module.capi;
    const rows2 = [];
    try {
      for (; ; ) {
        const code = capi.sqlite3_step(this.#pointer);
        if (code === 101) return rows2;
        if (code !== 100) throw this.#database.error(code);
        rows2.push(this.#row());
      }
    } finally {
      capi.sqlite3_reset(this.#pointer);
    }
  }
  #bind(parameters) {
    this.#assertOpen();
    const values = parameters.length === 1 && Array.isArray(parameters[0]) ? parameters[0] : parameters;
    if (values.length !== this.parameterCount) throw new Error("SQL_PARAMETER_COUNT_MISMATCH");
    const { capi, wasm } = this.#database.module;
    capi.sqlite3_reset(this.#pointer);
    this.#database.check(capi.sqlite3_clear_bindings(this.#pointer));
    values.forEach((value, offset) => {
      const index = offset + 1;
      let result;
      if (value === null) result = wasm.xCall("sqlite3_bind_null", this.#pointer, index);
      else if (typeof value === "bigint") result = capi.sqlite3_bind_int64(this.#pointer, index, value);
      else if (value instanceof Float64Array && value.length === 1) result = capi.sqlite3_bind_double(this.#pointer, index, value[0]);
      else if (typeof value === "number") result = Number.isSafeInteger(value) ? capi.sqlite3_bind_int64(this.#pointer, index, BigInt(value)) : capi.sqlite3_bind_double(this.#pointer, index, value);
      else if (typeof value === "string") {
        const bytes2 = utf8(value);
        result = withBytes(wasm, bytes2, (pointer) => capi.sqlite3_bind_text(this.#pointer, index, pointer, bytes2.length, -1));
      } else if (value instanceof Uint8Array) {
        result = withBytes(wasm, value, (pointer) => capi.sqlite3_bind_blob(this.#pointer, index, pointer, value.length, -1));
      } else throw new Error("SQL_UNSUPPORTED_PARAMETER_TYPE");
      this.#database.check(result);
    });
  }
  #row() {
    const { capi, wasm } = this.#database.module;
    const columns = this.columns();
    const values = columns.map((_column, index) => {
      switch (capi.sqlite3_column_type(this.#pointer, index)) {
        case 1: {
          const integer2 = capi.sqlite3_column_int64(this.#pointer, index);
          return this.#bigints ? integer2 : Number(integer2);
        }
        case 2:
          return capi.sqlite3_column_double(this.#pointer, index);
        case 3:
          return capi.sqlite3_column_text(this.#pointer, index);
        case 4: {
          const pointer = capi.sqlite3_column_blob(this.#pointer, index);
          return wasm.heap8u().slice(pointer, pointer + capi.sqlite3_column_bytes(this.#pointer, index));
        }
        case 5:
          return null;
        default:
          throw new Error("SQL_UNSUPPORTED_RESULT_TYPE");
      }
    });
    return this.#arrays ? values : Object.fromEntries(columns.map((column, index) => [column.name, values[index]]));
  }
  #assertOpen() {
    this.#database.assertOpen();
    if (this.#closed) throw new Error("WASM_STATEMENT_CLOSED");
  }
};
function withBytes(wasm, bytes2, operation) {
  const pointer = wasm.alloc(bytes2.length + 1);
  try {
    wasm.heap8u().set(bytes2, pointer);
    wasm.heap8u()[pointer + bytes2.length] = 0;
    return operation(pointer);
  } finally {
    wasm.dealloc(pointer);
  }
}

// packages/materializer-doltlite/src/load-engine.ts
async function loadBrowserEngine(baseUrl) {
  const base = new URL("./", new URL(baseUrl, globalThis.location.href));
  const [manifestResponse, wasmResponse] = await Promise.all([
    fetch(new URL("manifest.json", base)),
    fetch(new URL("sqlite3.wasm", base))
  ]);
  if (!manifestResponse.ok || !wasmResponse.ok) throw new Error("WASM_ENGINE_DOWNLOAD_FAILED");
  const manifest = await manifestResponse.json();
  const bytes2 = new Uint8Array(await wasmResponse.arrayBuffer());
  verifyWasmBuild(bytes2, manifest);
  const compiled = await WebAssembly.compile(bytes2);
  const url = new URL("sqlite3.mjs", base).href;
  const { default: initialize } = await import(
    /* @vite-ignore */
    url
  );
  const module = await initialize({
    locateFile: (name) => new URL(name, base).href,
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(compiled, imports);
      done(instance, compiled);
      return instance.exports;
    }
  });
  return { module, manifest };
}

export {
  configureSqliteLimits,
  assertNativeSecurityConfiguration,
  SqlRejection,
  executeTransactionProgram,
  PLATFORM_CODE_VERSION,
  PLATFORM_DIGEST,
  MaterializerInputError,
  DeterministicMaterializer,
  createDoltLiteMaterializationRuntime,
  normalizeEngineManifest,
  engineManifestDescriptor,
  digestEngineManifest,
  createDoltLiteExecutionManifest,
  verifyWasmBuild,
  createBrowserSqlEngine,
  WasmDatabase,
  loadBrowserEngine
};
