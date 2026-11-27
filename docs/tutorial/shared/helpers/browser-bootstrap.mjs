import { createPeersClient } from '@tendriller/core/peers';
import { createAdmission, deviceWrapKey, openPageGenesis } from '@tendriller/core/admission';
import { authorityRecord } from '@tendriller/core/authority';

function decodeBlueprintImports(blueprint) {
  const casList = blueprint?.reducers?.casModules;
  if (!Array.isArray(casList)) return { imports: { ...(blueprint?.reducers?.imports ?? {}) }, casNodes: [] };
  const decoder = new TextDecoder();
  const byHash = new Map();
  const casNodes = [];
  for (const mod of casList) {
    if (!mod || typeof mod.hash !== 'string' || typeof mod.bytesBase64 !== 'string') continue;
    const bin = atob(mod.bytesBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    byHash.set(mod.hash, bytes);
    casNodes.push({ hash: mod.hash, bytes, partition: 'public' });
  }
  const imports = {};
  for (const [spec, uri] of Object.entries(blueprint.reducers?.imports ?? {})) {
    const m = /^cas:sha256-([0-9a-f]{64})$/u.exec(String(uri ?? ''));
    imports[spec] = (m && byHash.has(m[1])) ? decoder.decode(byHash.get(m[1])) : uri;
  }
  return { imports, casNodes };
}

/**
 * Open or initialize a browser device's Chronolog genesis and wrap key.
 * On an uninitialized page, the owner's browser creates genesis (using either the
 * template's imports/topics or an embedded portable `configuration.blueprint`);
 * on an initialized page it pins the host's genesis and opens from local cache first.
 */
export async function bootstrapBrowser({ configuration, device, imports, topics, authority, signal }) {
  const base = new URL('_tendril/', configuration.page_url);
  if (base.origin !== globalThis.location.origin) throw Error('Open the signed page at its own authorized origin');
  const peers = createPeersClient({
    base: base.href,
    applicationId: configuration.applicationId,
    async request(path, { method = 'GET', body, signal: requestSignal } = {}) {
      const response = await fetch(new URL(path, base), {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000), ...[requestSignal].filter(Boolean)]),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!response.ok) {
        throw Object.assign(Error(value.error?.message ?? `Host request failed (${response.status})`), { code: value.error?.code, status: response.status });
      }
      return value;
    },
  });
  const wrapKey = await deviceWrapKey(device.store);
  const bp = configuration.blueprint ?? null;
  let effectiveImports = imports ?? configuration.imports;
  let effectiveTopics = topics ?? configuration.topics;
  let extraCasNodes = [];
  if (bp?.reducers) {
    const decoded = decodeBlueprintImports(bp);
    effectiveImports = decoded.imports;
    effectiveTopics = { ...(bp.reducers.topics ?? {}) };
    extraCasNodes = decoded.casNodes;
  }
  const opened = await openPageGenesis({
    store: device.store,
    identity: device.identity,
    wrapKey,
    peers,
    applicationId: configuration.applicationId,
    imports: effectiveImports,
    topics: effectiveTopics,
    ...(authority !== undefined || configuration.authority !== undefined ? { authority: authority ?? configuration.authority } : {}),
    signal,
  });
  const casNodes = extraCasNodes.length
    ? [...opened.casNodes, ...extraCasNodes.filter(c => !opened.casNodes.some(o => o.hash === c.hash))]
    : opened.casNodes;
  return { ...opened, casNodes, peers, wrapKey, blueprint: bp };
}

/**
 * On a brand-new browser-first page (`opened.created === true`), sign the initial
 * `$publications` record for any host-seeded v1 starter manifest AND apply any
 * initial SQL DDL / RLS schemas declared by an imported `PageBlueprint`.
 */
export async function finalizeFirstBrowserGenesis({ session, opened }) {
  if (!opened?.created) return;
  try {
    if (opened.seededVersion?.files?.length && typeof session.publishRelease === 'function') {
      const pubState = session.topic?.('$publications');
      if (!pubState || (pubState.revision ?? 0) === 0) {
        await session.publishRelease({
          entry: opened.seededVersion.entry || 'index.html',
          files: opened.seededVersion.files,
          operationId: `browser-first-v${opened.seededVersion.version}`,
        });
        const facts = await session.exportPublicControlFacts();
        if (facts.publicOps.length > 0 && typeof opened.peers?.syncControl === 'function') {
          await opened.peers.syncControl({ publicOps: facts.publicOps.map(authorityRecord) }).catch(() => {});
        }
      }
    }
  } catch { /* best-effort; never block local authoring */ }
  try {
    const schemas = opened.blueprint?.schemas;
    if (Array.isArray(schemas) && schemas.length > 0) {
      for (const s of schemas) {
        if (!s?.topic || !Array.isArray(s.statements) || s.statements.length === 0) continue;
        await session.submit({
          operationId: `blueprint-schema-${s.topic}`,
          updates: [{
            topic: s.topic,
            input: {
              action: 'migrate',
              statements: s.statements,
              ...(s.policies && Object.keys(s.policies).length ? { policies: s.policies } : {}),
              allowUserDdl: s.allowUserDdl !== false,
            },
          }],
        });
      }
    }
  } catch { /* best-effort */ }
}

/** Start the one admission controller beside an open browser session; pass its extensions to the owner. */
export function admitBrowserSession(session, { peers, wrapKey, onEpochRotated } = {}) {
  return createAdmission(session, {
    peers,
    wrapKey,
    store: session.device.store,
    subject: 'device',
    ...(onEpochRotated ? { onEpochRotated } : {}),
  });
}
