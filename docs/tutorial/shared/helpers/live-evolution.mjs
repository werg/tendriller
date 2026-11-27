// Safe live schema & ES Module reducer evolution helpers for Chronolog.
// Lets admins and agents hot-add or upgrade `$reducers` ES Modules (with local
// QuickJS-NG dry-run validation before touching the live log), evolve `chronolog-db`
// schemas and write-RLS policies atomically, and let writers manage personal tables.
import {
  createApplicationSession,
  createLogGenesis,
  openApplicationDevice,
} from '@chronolog/peer-session';
import { computeCasHash, MemoryBytesStore } from '@chronolog/peer-session/kernel';

const encoder = new TextEncoder();

/**
 * Dry-run a candidate ES Module reducer inside an ephemeral QuickJS-NG + SQLite-CAS
 * sandbox BEFORE submitting it to `$reducers` on a live log.
 * Catches syntax errors, missing `reduce` exports, broken imports, and runtime faults.
 */
export async function dryRunReducerModule({
  specifier,
  source,
  exportName = 'default',
  sampleTopic = '__dryrun__',
  sampleInput = null,
  wasmModule,
  sqliteWasmModule,
} = {}) {
  if (typeof specifier !== 'string' || !specifier.trim() || specifier.startsWith('chronolog:')) {
    throw Object.assign(new Error('Invalid reducer module specifier'), { code: 'REDUCER_SPECIFIER_INVALID' });
  }
  if (typeof source !== 'string' || !source.trim()) {
    throw Object.assign(new Error('Reducer ES Module source is empty'), { code: 'REDUCER_SOURCE_EMPTY' });
  }
  const bytes = encoder.encode(source);
  const hash = computeCasHash(bytes, []);
  const casUri = `cas:sha256-${hash}`;

  const device = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  let session;
  try {
    const created = await createLogGenesis({
      creator: {
        publicKey: device.identity.publicKey,
        reader: true,
        writer: true,
        administrator: true,
        publisher: true,
        finalizer: true,
      },
      privateLog: false,
      imports: { [specifier]: source },
      topics: {
        [sampleTopic]: {
          module: specifier,
          ...(exportName && exportName !== 'default' ? { export: exportName } : {}),
        },
      },
    });
    session = await createApplicationSession({
      device,
      genesis: created.genesisBytes,
      casNodes: created.casNodes,
      ...(wasmModule ? { wasmModule } : {}),
      ...(sqliteWasmModule ? { sqliteWasmModule } : {}),
    });
    const described = await session.describe().catch(() => null);
    // Probe a read-only query if no sampleInput provided, or submit sampleInput to prove reduce() works
    if (sampleInput !== null && sampleInput !== undefined) {
      const op = await session.submit({
        updates: [{ topic: sampleTopic, input: sampleInput }],
        operationId: 'dryrun-sample',
      });
      const mat = await op.materialized();
      if (mat.outcome !== 'accepted') {
        throw Object.assign(
          new Error(`Dry-run sample rejected (${mat.rejectionCode ?? 'rejected'}${mat.rejectionDetail ? `: ${mat.rejectionDetail}` : ''})`),
          { code: 'REDUCER_DRYRUN_REJECTED', materialized: mat },
        );
      }
    } else {
      // Trigger module instantiation via a harmless no-op query (or probe reduce with an invalid ping)
      try {
        await session.query(sampleTopic, null);
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (/SyntaxError|ReferenceError|module|export|compile|not a function/i.test(msg)) {
          throw err;
        }
      }
      // Also instantiate reduce path with an empty probe to verify `reduce` is callable
      const probe = await session.submit({
        updates: [{ topic: sampleTopic, input: { __dryrunProbe: true } }],
        operationId: 'dryrun-probe',
      });
      const mat = await probe.materialized();
      if (mat.rejectionCode && /syntax|compile|module|export|not_a_function|reducer_load|reducer_invalid|no_reduce/i.test(String(mat.rejectionCode) + ' ' + String(mat.rejectionDetail ?? ''))) {
        throw Object.assign(
          new Error(`Reducer module failed validation: ${mat.rejectionCode} ${mat.rejectionDetail ?? ''}`.trim()),
          { code: 'REDUCER_DRYRUN_FAILED', materialized: mat },
        );
      }
    }
    return Object.freeze({ ok: true, specifier, hash, casUri, bytes, described });
  } catch (err) {
    if (err?.code?.startsWith('REDUCER_')) throw err;
    throw Object.assign(
      new Error(`Reducer dry-run failed for ${specifier}: ${err?.message ?? String(err)}`, { cause: err }),
      { code: 'REDUCER_DRYRUN_FAILED' },
    );
  } finally {
    if (session) await session.close().catch(() => {});
    await device.close().catch(() => {});
  }
}

/**
 * Safely publish a new or upgraded ES Module reducer into public CAS and bind it in `$reducers`.
 * Every browser, local agent, and hosted MCP participant deterministically switches to the
 * new hash-pinned reducer at this operation's canonical author timestamp — zero redeploys required.
 */
export async function publishReducerModule(session, {
  specifier,
  source,
  exportName = 'default',
  topicBindings = {},
  operationId,
  dryRun = true,
  sampleInput = null,
  wasmModule,
  sqliteWasmModule,
} = {}) {
  let bytes, hash, casUri, described = null;
  if (dryRun) {
    const firstTopic = Object.keys(topicBindings)[0] ?? '__dryrun__';
    const check = await dryRunReducerModule({
      specifier,
      source,
      exportName,
      sampleTopic: firstTopic,
      sampleInput,
      wasmModule,
      sqliteWasmModule,
    });
    bytes = check.bytes;
    hash = check.hash;
    casUri = check.casUri;
    described = check.described;
  } else {
    bytes = encoder.encode(source);
    hash = computeCasHash(bytes, []);
    casUri = `cas:sha256-${hash}`;
  }

  // Seed public CAS node so local materializer and sync peers have the exact bytes immediately
  await session.mergeFacts({
    publicOps: [],
    encryptedEnvelopes: [],
    casNodes: [{ hash, bytes, partition: 'public' }],
    retentions: [],
    checkpoints: [],
  });

  const payload = {
    imports: { [specifier]: casUri },
    ...(Object.keys(topicBindings).length > 0 ? { topics: topicBindings } : {}),
  };
  const op = await session.submit({
    visibility: 'public',
    ...(operationId ? { operationId } : {}),
    updates: [{ topic: '$reducers', input: payload }],
  });
  return { operation: op, specifier, hash, casUri, described };
}

/**
 * Atomically evolve a `chronolog/sql` topic's schema and/or write-RLS policies with optional
 * optimistic schemaVersion checking.
 */
export async function evolveSqlSchema(session, {
  topic = 'sql',
  statements = [],
  policies,
  preconditions,
  postconditions,
  allowUserDdl,
  expectedSchemaVersion,
  schemaVersion,
  events,
  operationId,
} = {}) {
  const current = (await session.query(topic, { kind: 'schema' }))?.value ?? null;
  if (expectedSchemaVersion !== undefined && current && current.schemaVersion !== expectedSchemaVersion) {
    throw Object.assign(
      new Error(`Expected schemaVersion ${expectedSchemaVersion}, found ${current.schemaVersion}`),
      { code: 'SCHEMA_VERSION_MISMATCH', currentSchemaVersion: current.schemaVersion },
    );
  }
  const input = {
    action: 'migrate',
    statements,
    ...(policies ? { policies } : {}),
    ...(preconditions ? { preconditions } : {}),
    ...(postconditions ? { postconditions } : {}),
    ...(allowUserDdl === undefined ? {} : { allowUserDdl: Boolean(allowUserDdl) }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(events ? { events } : {}),
  };
  const op = await session.submit({
    ...(operationId ? { operationId } : {}),
    updates: [{ topic, input }],
  });
  return { operation: op, previousSchemaVersion: current?.schemaVersion ?? 0 };
}

/** Allow any authorized writer to create/alter/drop their own `_rls_table_owners`-scoped SQL table. */
export async function runPersonalDdl(session, { topic = 'sql', statements, operationId } = {}) {
  const list = Array.isArray(statements) ? statements : [statements];
  if (!list.length || list.some(s => typeof s !== 'string' || !s.trim())) {
    throw Object.assign(new Error('Supply one or more DDL SQL statements'), { code: 'INVALID_DDL' });
  }
  return session.submit({
    ...(operationId ? { operationId } : {}),
    updates: [{ topic, input: { action: 'exec', statements: list } }],
  });
}
