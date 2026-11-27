/**
 * Owner-direct page allocation and one-click Remix / Fork.
 *
 * Keeps the Tendriller host 100% application-neutral: copies or seeds ONLY opaque
 * immutable public publication files + optional host configuration into a fresh
 * owner-claimed page DO. Strictly ZERO private envelopes, ZERO `v2_public_ops`,
 * ZERO links, ZERO agent grants, and ZERO device keys are ever copied.
 */
import type { Env } from './env';
import { HttpError } from './http';
import { newTendrilId, sha256Hex } from './ids';
import { PAGE_LIMIT, RESIDENT_LIMIT } from './limits';
import { accountLimits } from './service-state';

export interface SeedFile {
  path: string;
  type: string;
  bytesBase64: string;
}

export interface AllocatedOwnerPage {
  id: string;
  name: string;
  page_url: string;
  version: number;
  application: { id: string };
}

function pageStub(env: Env, id: string): DurableObjectStub {
  return env.TENDRIL.get(env.TENDRIL.idFromName(id));
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Allocate a fresh, owner-claimed page DO with zero local agent required,
 * optionally seeding immutable v1 public files (e.g. from Remix or a browser-first starter).
 */
export async function createOwnerPage(
  env: Env,
  accountId: string,
  options: {
    name?: string;
    entry?: string;
    files?: readonly SeedFile[];
    rewriteConfigJson?: boolean;
    authorityHint?: { mode: 'attested' | 'open'; openRead?: boolean; openWrite?: boolean } | null;
    blueprint?: Record<string, unknown> | null;
    activitySummary?: string;
  } = {},
): Promise<AllocatedOwnerPage> {
  if (!env.ACCOUNTS) throw new HttpError(503, 'unavailable', 'Accounts database is not configured');

  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newTendrilId();
    const collidesSub = await env.ACCOUNTS.prepare('SELECT 1 FROM page_subdomains WHERE subdomain = ?').bind(id).first().catch(() => null);
    if (collidesSub) continue;
    const now = Date.now();
    const admission = env.ADMISSION.get(env.ADMISSION.idFromName('global'));
    const allowed = await admission.fetch(new Request('https://admission.internal/reserve', {
      method: 'POST',
      headers: { 'x-tendril-id': id },
    }));
    if (!allowed.ok) {
      const body = await allowed.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new HttpError(allowed.status, body?.error?.code ?? 'admission_denied', body?.error?.message ?? 'Creation temporarily unavailable');
    }
    await allowed.body?.cancel();

    let indexed = false;
    const cancel = async () => {
      try {
        if (indexed) await env.ACCOUNTS.prepare('DELETE FROM tendrils WHERE id = ?').bind(id).run();
      } finally {
        const cancelled = await admission.fetch(new Request('https://admission.internal/cancel', {
          method: 'POST',
          headers: { 'x-tendril-id': id },
        }));
        await cancelled.body?.cancel();
      }
    };

    try {
      try {
        await env.ACCOUNTS.prepare(
          'INSERT INTO tendrils (id, owner_account, intended_owner, creator_ip, created_at, claimed_at, lifetime) VALUES (?, ?, NULL, NULL, ?, ?, ?)',
        ).bind(id, accountId, now, now, 'ad_hoc').run();
      } catch (err) {
        const message = String(err);
        if (message.includes('account_tendrils_full') || message.includes('account_residents_full')) {
          const limits = await accountLimits(env, accountId);
          if (message.includes('account_tendrils_full')) {
            throw new HttpError(429, 'quota', 'Account tendril limit reached', { limit: limits.pages ?? PAGE_LIMIT });
          }
          throw new HttpError(429, 'quota', 'Account resident tendril limit reached', { limit: limits.residents ?? RESIDENT_LIMIT });
        }
        throw err;
      }
      indexed = true;

      const res = await pageStub(env, id).fetch(new Request('https://tendril.internal/create-owned', {
        method: 'POST',
        headers: {
          'x-tendril-id': id,
          'x-account-id': accountId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: options.name ?? 'New Page',
          entry: options.entry ?? 'index.html',
          files: options.files ?? [],
          rewriteConfigJson: options.rewriteConfigJson === true,
          authorityHint: options.authorityHint ?? null,
          ...(options.blueprint ? { blueprint: options.blueprint } : {}),
          activitySummary: options.activitySummary ?? null,
        }),
      }));

      if (res.status === 409) {
        await res.body?.cancel();
        await cancel();
        continue;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
        await cancel();
        throw new HttpError(res.status, errBody?.error?.code ?? 'create_failed', errBody?.error?.message ?? 'Could not create page');
      }
      return await res.json() as AllocatedOwnerPage;
    } catch (err) {
      await cancel();
      throw err;
    }
  }
  throw new HttpError(503, 'id_collision', 'Could not allocate a unique page ID; please try again.');
}

/**
 * One-click Remix / Fork of an existing page:
 * Allowed when the requester owns `sourceId` OR `sourceId` is a public `open_readers` page.
 * Copies ONLY the source's current immutable public R2 publication files (rewriting
 * `configuration.json` to the brand-new `applicationId` and `page_url` so the remixed page
 * initializes its own isolated Chronolog v2 log) and ZERO private state.
 */
export async function remixExistingPage(
  env: Env,
  accountId: string,
  sourceId: string,
  options: { name?: string } = {},
): Promise<AllocatedOwnerPage> {
  const srcRes = await pageStub(env, sourceId).fetch(new Request('https://tendril.internal/remix-source', {
    method: 'GET',
    headers: { 'x-account-id': accountId },
  }));
  if (!srcRes.ok) {
    const errBody = await srcRes.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new HttpError(srcRes.status, errBody?.error?.code ?? 'remix_unavailable', errBody?.error?.message ?? 'Page cannot be remixed');
  }
  const source = await srcRes.json() as {
    id: string;
    name: string;
    entry: string;
    files: Array<{ path: string; hash: string; type: string; size: number }>;
  };

  const seedFiles: SeedFile[] = [];
  for (const file of source.files) {
    const obj = await env.FILES.get(`t/${source.id}/files/${file.hash}`);
    if (!obj) {
      throw new HttpError(409, 'remix_asset_missing', `Source asset ${file.path} is no longer in host cache; export a portable blueprint from a connected peer instead.`);
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.hash) {
      throw new HttpError(500, 'remix_asset_corrupt', `Integrity check failed while copying ${file.path}`);
    }
    seedFiles.push({
      path: file.path,
      type: file.type,
      bytesBase64: bytesToBase64(bytes),
    });
  }

  const nextName = (options.name?.trim() || `${source.name} (Remix)`).slice(0, 80);
  return createOwnerPage(env, accountId, {
    name: nextName,
    entry: source.entry,
    files: seedFiles,
    rewriteConfigJson: true,
    activitySummary: `Remixed from page ${source.id} (fresh isolated Chronolog log)`,
  });
}

function visibilityAuthorityHint(vis: string): { mode: 'open'; openRead: boolean; openWrite: boolean } | null {
  if (!['private', 'public-read', 'public-write'].includes(vis)) {
    throw new HttpError(400, 'invalid_visibility', 'Choose visibility private, public-read, or public-write.');
  }
  return vis === 'public-write'
    ? { mode: 'open', openRead: true, openWrite: true }
    : vis === 'public-read'
      ? { mode: 'open', openRead: true, openWrite: false }
      : null;
}

/**
 * Launch a fresh, isolated page directly from a portable, secret-free
 * `tendriller-page-blueprint/v1` JSON document. Strictly verifies blueprint format
 * and strips any forbidden secret/state fields. Optionally clones UI assets from
 * `sourcePageId` (owned or public), rewriting `configuration.json` with the
 * validated blueprint and fresh `applicationId`.
 */
export async function createPageFromBlueprint(
  env: Env,
  accountId: string,
  options: {
    blueprint: unknown;
    sourcePageId?: string;
    name?: string;
    visibility?: 'private' | 'public-read' | 'public-write';
  },
): Promise<AllocatedOwnerPage> {
  const bp = options.blueprint as Record<string, any> | null;
  if (!bp || typeof bp !== 'object' || Array.isArray(bp) || bp.format !== 'tendriller-page-blueprint/v1') {
    throw new HttpError(400, 'invalid_blueprint', 'Expected a valid tendriller-page-blueprint/v1 JSON document.');
  }
  if (!bp.reducers || typeof bp.reducers !== 'object' || !bp.reducers.topics || typeof bp.reducers.topics !== 'object') {
    throw new HttpError(400, 'invalid_blueprint', 'Blueprint must include reducers.topics.');
  }
  const imports = bp.reducers.imports && typeof bp.reducers.imports === 'object' ? bp.reducers.imports as Record<string, string> : {};
  const topics = bp.reducers.topics as Record<string, unknown>;
  const casModules = Array.isArray(bp.casModules) ? bp.casModules : [];
  if (casModules.length > 64) throw new HttpError(400, 'invalid_blueprint', 'Blueprint contains too many CAS modules.');
  const cleanModules: Array<{ hash: string; bytesBase64: string }> = [];
  for (const mod of casModules) {
    if (!mod || typeof mod !== 'object' || typeof mod.hash !== 'string' || !/^[0-9a-f]{64}$/.test(mod.hash) || typeof mod.bytesBase64 !== 'string' || mod.bytesBase64.length > 512 * 1024) {
      throw new HttpError(400, 'invalid_blueprint', 'Invalid CAS module entry in blueprint.');
    }
    cleanModules.push({ hash: mod.hash, bytesBase64: mod.bytesBase64 });
  }
  const schemas = Array.isArray(bp.schemas) ? bp.schemas.slice(0, 16) : [];
  const cleanBlueprint = {
    format: 'tendriller-page-blueprint/v1',
    title: typeof bp.title === 'string' ? bp.title.slice(0, 80) : 'Blueprint Page',
    description: typeof bp.description === 'string' ? bp.description.slice(0, 400) : '',
    reducers: { imports, topics },
    casModules: cleanModules,
    schemas,
  };

  let entry = 'index.html';
  let seedFiles: SeedFile[] = [];
  if (options.sourcePageId && /^[a-z2-7]{12}$/.test(options.sourcePageId)) {
    const srcRes = await pageStub(env, options.sourcePageId).fetch(new Request('https://tendril.internal/remix-source', {
      method: 'GET',
      headers: { 'x-account-id': accountId },
    }));
    if (!srcRes.ok) {
      const errBody = await srcRes.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new HttpError(srcRes.status, errBody?.error?.code ?? 'remix_unavailable', errBody?.error?.message ?? 'Source page UI cannot be copied');
    }
    const source = await srcRes.json() as {
      id: string;
      entry: string;
      files: Array<{ path: string; hash: string; type: string; size: number }>;
    };
    entry = source.entry;
    for (const file of source.files) {
      const obj = await env.FILES.get(`t/${source.id}/files/${file.hash}`);
      if (!obj) throw new HttpError(409, 'remix_asset_missing', `Source asset ${file.path} is no longer in host cache.`);
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.hash) {
        throw new HttpError(500, 'remix_asset_corrupt', `Integrity check failed while copying ${file.path}`);
      }
      seedFiles.push({ path: file.path, type: file.type, bytesBase64: bytesToBase64(bytes) });
    }
  }

  const vis = options.visibility ?? (bp.authority?.mode === 'open'
    ? (bp.authority.openWrite ? 'public-write' : 'public-read')
    : 'private');
  const authorityHint = visibilityAuthorityHint(vis);
  const pageName = (options.name?.trim() || cleanBlueprint.title || 'Blueprint Page').slice(0, 80);
  return createOwnerPage(env, accountId, {
    name: pageName,
    entry,
    files: seedFiles,
    rewriteConfigJson: seedFiles.length > 0,
    authorityHint,
    blueprint: cleanBlueprint,
    activitySummary: `Created page from portable PageBlueprint "${cleanBlueprint.title}"`,
  });
}
