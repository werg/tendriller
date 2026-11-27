// Portable, verifiable Chronolog v2 PageBlueprint export & fresh-log instantiation.
// Captures ONLY application logic (`$reducers` + public CAS ES Modules), optional SQL
// schema DDL + write-RLS policies (strictly ZERO rows / ZERO private data), and optional
// `$publications` manifest so any page can be safely shared, audited, or remixed into
// an independent encrypted log with a fresh `logId` and epoch 0 key.
import { computeCasHash } from '@chronolog/peer-session/kernel';
import { createPageGenesis } from './admission.mjs';

export const BLUEPRINT_FORMAT = 'tendriller-page-blueprint/v1';
const HEX64 = /^[0-9a-f]{64}$/u;

function bytesToBase64(bytes) {
  if (typeof Buffer === 'function') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  if (typeof Buffer === 'function') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isStandardModule(spec) {
  return typeof spec === 'string' && (spec.startsWith('chronolog/') || spec.startsWith('chronolog:'));
}

/**
 * Export a portable, secret-free `PageBlueprint` from an open Chronolog v2 session.
 * Never exports private table rows, encrypted envelopes, epoch keys, device keys, or member PII.
 */
export async function exportPageBlueprint(session, {
  title = 'Remixed Page',
  description = '',
  includeSchema = true,
  includePublication = true,
} = {}) {
  const reducers = session.topic?.('$reducers') ?? { imports: {}, topics: {} };
  const allTopics = reducers.topics ?? {};
  const allImports = reducers.imports ?? {};

  const appTopics = {};
  const neededSpecifiers = new Set();
  for (const [topicName, binding] of Object.entries(allTopics)) {
    if (topicName.startsWith('$')) continue;
    appTopics[topicName] = structuredClone(binding);
    if (binding?.module && !isStandardModule(binding.module)) {
      neededSpecifiers.add(binding.module);
    }
  }

  // Gather custom public CAS ES Module bytes referenced by `$reducers.imports`
  const customImports = {};
  const casModules = [];
  const seenHashes = new Set();
  for (const [spec, uri] of Object.entries(allImports)) {
    if (isStandardModule(spec)) continue;
    if (!neededSpecifiers.has(spec) && !spec.startsWith('@app/')) continue;
    customImports[spec] = uri;
    const m = /^cas:sha256-([0-9a-f]{64})$/u.exec(String(uri ?? ''));
    if (m && !seenHashes.has(m[1])) {
      const decoded = await session.readCasPayload(m[1], 'public');
      if (decoded?.payload instanceof Uint8Array) {
        seenHashes.add(m[1]);
        casModules.push({ hash: m[1], bytesBase64: bytesToBase64(decoded.payload) });
      }
    }
  }

  // Optional SQL DDL + write-RLS policies (strictly zero table rows!)
  const schemas = [];
  if (includeSchema) {
    for (const [topicName, binding] of Object.entries(appTopics)) {
      if (binding?.module !== 'chronolog/sql') continue;
      let schema = null;
      try {
        schema = (await session.query(topicName, { kind: 'schema' }))?.value ?? null;
      } catch { schema = null; }
      if (!schema) continue;
      const userOwned = new Set(Object.keys(schema.userOwnedObjects ?? {}));
      const statements = [];
      for (const obj of schema.objects ?? []) {
        if (!obj || typeof obj.sql !== 'string' || !obj.sql.trim()) continue;
        const name = String(obj.name ?? '');
        if (name.startsWith('_rls_') || name.startsWith('sqlite_') || userOwned.has(name)) continue;
        if (obj.type === 'trigger' && name.startsWith('_rls_')) continue;
        if (['table', 'index', 'view'].includes(obj.type)) {
          statements.push(obj.sql);
        }
      }
      schemas.push({
        topic: topicName,
        statements,
        policies: structuredClone(schema.policies ?? {}),
        allowUserDdl: schema.allowUserDdl !== false,
      });
    }
  }

  // Optional current `$publications` manifest (hashes & paths only)
  let publication = null;
  if (includePublication) {
    const pub = (await session.query('$publications', {}).catch(() => null))?.value?.current ?? null;
    if (pub && typeof pub.entry === 'string' && Array.isArray(pub.files)) {
      publication = {
        entry: pub.entry,
        files: pub.files.map(f => ({ path: f.path, hash: f.hash, size: f.size, type: f.type })),
      };
    }
  }

  const perms = session.permissions?.() ?? {};
  const authorityMode = perms.mode === 'open' ? 'open' : perms.mode === 'multisig' ? 'multisig' : 'attested';

  return {
    format: BLUEPRINT_FORMAT,
    createdAt: new Date().toISOString(),
    meta: {
      title: String(title || 'Remixed Page').slice(0, 120),
      description: String(description || '').slice(0, 500),
      privateLog: session.genesis?.privateLog !== false,
      authorityHint: authorityMode === 'open'
        ? { mode: 'open', openRead: Boolean(perms.openReaders), openWrite: Boolean(perms.openWriters) }
        : { mode: authorityMode },
    },
    reducers: {
      imports: customImports,
      topics: appTopics,
      casModules,
    },
    schemas,
    publication,
  };
}

/** Validate a `PageBlueprint` structure and verify every included CAS module hash. */
export function validatePageBlueprint(blueprint) {
  if (!blueprint || typeof blueprint !== 'object' || blueprint.format !== BLUEPRINT_FORMAT) {
    throw Object.assign(new Error(`Unsupported blueprint format; expected ${BLUEPRINT_FORMAT}`), { code: 'BLUEPRINT_INVALID' });
  }
  const topics = blueprint.reducers?.topics;
  if (!topics || typeof topics !== 'object' || Array.isArray(topics)) {
    throw Object.assign(new Error('Blueprint missing reducers.topics'), { code: 'BLUEPRINT_INVALID' });
  }
  for (const name of Object.keys(topics)) {
    if (name.startsWith('$')) {
      throw Object.assign(new Error(`Blueprint must not inject control topic ${name}`), { code: 'BLUEPRINT_INVALID' });
    }
  }
  const moduleBytesByHash = new Map();
  for (const mod of blueprint.reducers?.casModules ?? []) {
    if (!mod || !HEX64.test(mod.hash ?? '') || typeof mod.bytesBase64 !== 'string') {
      throw Object.assign(new Error('Invalid CAS module entry in blueprint'), { code: 'BLUEPRINT_INVALID' });
    }
    const bytes = base64ToBytes(mod.bytesBase64);
    const actual = computeCasHash(bytes, []);
    if (actual !== mod.hash) {
      throw Object.assign(new Error(`Blueprint CAS module hash mismatch for ${mod.hash}`), { code: 'BLUEPRINT_HASH_MISMATCH' });
    }
    moduleBytesByHash.set(mod.hash, bytes);
  }
  return { moduleBytesByHash };
}

/**
 * Instantiate a brand-new, independent Chronolog v2 `LogGenesis` (fresh `salt`, fresh `logId`,
 * fresh `epoch0Key`) from a verified `PageBlueprint`, returning initial SQL schema migrations
 * ready to apply on first session open.
 */
export async function createGenesisFromBlueprint({
  blueprint,
  identity,
  wrapKey,
  hostKey,
  accounts = [],
  ownerGrant,
  authority,
  admission,
  privateLog,
  finalitySchedule,
}) {
  const { moduleBytesByHash } = validatePageBlueprint(blueprint);
  const decoder = new TextDecoder();
  const imports = {};
  for (const [spec, uri] of Object.entries(blueprint.reducers?.imports ?? {})) {
    if (isStandardModule(spec)) continue;
    const m = /^cas:sha256-([0-9a-f]{64})$/u.exec(String(uri ?? ''));
    if (m && moduleBytesByHash.has(m[1])) {
      imports[spec] = decoder.decode(moduleBytesByHash.get(m[1]));
    }
  }
  const resolvedPrivateLog = privateLog !== undefined ? privateLog : (blueprint.meta?.privateLog !== false);
  const resolvedAuthority = authority !== undefined
    ? authority
    : (blueprint.meta?.authorityHint?.mode === 'open' ? blueprint.meta.authorityHint : undefined);

  const created = await createPageGenesis({
    identity,
    wrapKey,
    hostKey,
    accounts,
    ownerGrant,
    authority: resolvedAuthority,
    admission,
    privateLog: resolvedPrivateLog,
    imports,
    topics: blueprint.reducers.topics,
    finalitySchedule,
  });

  const initialMigrations = (blueprint.schemas ?? [])
    .filter(s => s && typeof s.topic === 'string' && ((s.statements?.length ?? 0) > 0 || Object.keys(s.policies ?? {}).length > 0))
    .map(s => ({
      topic: s.topic,
      input: {
        action: 'migrate',
        statements: [...(s.statements ?? [])],
        ...(s.policies && Object.keys(s.policies).length > 0 ? { policies: structuredClone(s.policies) } : {}),
        allowUserDdl: s.allowUserDdl !== false,
      },
    }));

  return { ...created, initialMigrations };
}
