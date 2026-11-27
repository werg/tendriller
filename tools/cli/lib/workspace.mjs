// An agent workspace: one account-level credential and signer, many pages.
//
//   tendriller.json          { schemaVersion, service, agent: { id, handle, bio }, kit, pages: { <slug>: { id } } }
//   pages/<slug>/            per-page source (agent.mjs, domain.mjs, page.mjs, ...)
//   .tendriller/agent/       identity.sqlite (shared signer), wrap-key.json (shared key-wrap key), credential.json, attach.json, owner/ (attach socket)
//   .tendriller/pages/<id>/  page.json, device.sqlite, descriptor and setup records
//   .tendriller/checkpoint-retired.json  present once `tendril checkpoint export` moved this workspace away
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { assertValid } from '@tendriller/core/contract';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkspacePage } from './page-creation.mjs';
import { agentCredential, createAgentClient, describeReadiness, describeService, evaluateBroadcastMatch, fetchBroadcastKeys, fetchBroadcasts, fetchChangelog, joinAgent, registerAgent, requireCreationReady, requireService, requireServiceOrigin, validateClientVersions, verifyBroadcastSignature } from '@tendriller/core';
import { compareSemver } from '@tendriller/core/broadcasts';

const execFileAsync = promisify(execFile);
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const sha512Sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

export const WORKSPACE_FILE = 'tendriller.json';
export const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const PAGE_ID = /^[a-z2-7]{12}$/u;
const AGENT_TOKEN = /^ta_[a-z2-7]{32}$/u;
export const ATTACH_POLICY = Object.freeze({ capabilities: ['commands', 'queries', 'events', 'content', 'signals', 'operations', 'diagnostics', 'finality', 'extensions', 'publish'] });
const failure = (code, message, exit) => Object.assign(new Error(message), { code, ...(exit ? { exit } : {}) });

async function readJson(path, optional = false) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw failure('workspace_state_invalid', `${path} is not valid JSON. Restore it from a checkpoint; nothing was replaced.`);
    throw error;
  }
}
/** Write-once private record; an identical retry is accepted, a different one refused. */
export async function savePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(path, text, { flag: 'wx', mode: 0o600, flush: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== text) throw failure('private_record_exists', `Refusing to replace ${path}; inspect the original record.`);
  }
  return value;
}
async function replaceJson(path, value, mode = 0o644) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode, flush: true });
  await rename(temporary, path);
}

export function findWorkspace({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.TENDRIL_WORKSPACE) return resolve(env.TENDRIL_WORKSPACE);
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if (existsSync(join(current, WORKSPACE_FILE))) return current;
    if (dirname(current) === current) return null;
  }
}

export function workspacePaths(root) {
  const secret = join(root, '.tendriller');
  return Object.freeze({
    root, config: join(root, WORKSPACE_FILE), secret, sources: join(root, 'pages'),
    agent: join(secret, 'agent'), identity: join(secret, 'agent', 'identity.sqlite'), wrapKey: join(secret, 'agent', 'wrap-key.json'),
    credential: join(secret, 'agent', 'credential.json'), attach: join(secret, 'agent', 'attach.json'),
    broadcasts: join(secret, 'agent', 'broadcasts.json'),
    owner: join(secret, 'agent', 'owner'), pages: join(secret, 'pages'),
    retired: join(secret, 'checkpoint-retired.json'),
  });
}

/** Chronolog Ed25519 public keys are hex; the host registers them as base64url. */
export const publicKeyBase64url = hex => Buffer.from(hex, 'hex').toString('base64url');

/** The shared signer outlives each page device. It is read once and never serialized elsewhere. */
export async function openSharedSigner(path, { create = false } = {}) {
  const { openNativeDevice } = await import('@chronolog/peer-session/native');
  if (!create && !existsSync(path)) throw failure('agent_signer_missing', `The workspace signer ${path} is missing. Restore it from a checkpoint; a new key would not match the registered agent.`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const device = await openNativeDevice({ path, ...(create ? { create: true } : {}) });
  try { return device.identity; } finally { await device.close(); }
}

/** The agent's one X25519 key-wrap key, registered with the host beside its signing key.
 * Members wrap each page's epoch keys to it; the private half never leaves this folder. */
export async function openWrapKey(path, { create = false } = {}) {
  let saved = await readJson(path, true);
  if (!saved) {
    if (!create) throw failure('agent_wrap_key_missing', `The workspace key-wrap key ${path} is missing. Restore it from a checkpoint; a new key would not match the registered agent.`);
    const { createWrapKeyPair } = await import('@chronolog/peer-session');
    const pair = await createWrapKeyPair();
    saved = await savePrivateJson(path, { publicKey: pair.publicKey, privateKey: Buffer.from(pair.privateKey).toString('hex') });
  }
  if (!/^[0-9a-f]{64}$/u.test(saved.publicKey ?? '') || !/^[0-9a-f]+$/u.test(saved.privateKey ?? '')) throw failure('agent_wrap_key_invalid', `${path} is damaged; restore it from a checkpoint.`);
  return saved;
}
async function importWrapKey(saved) {
  const { importWrapPrivateKey } = await import('@chronolog/peer-session');
  return Object.freeze({ publicKey: saved.publicKey, privateKey: await importWrapPrivateKey(Uint8Array.from(Buffer.from(saved.privateKey, 'hex'))) });
}

/** One page device: its own native store, always signed by the shared agent key.
 * Every store is served by Chronolog's one pooled SQLite worker for this process. */
export async function openPageDevice({ path, signer, create = false }) {
  const { openNativeDevice } = await import('@chronolog/peer-session/native');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return openNativeDevice({ path, managedSigner: signer, ...(create ? { create: true } : {}) });
}

const HANDLE_RE = /^[a-z][a-z0-9_-]{1,31}$/u;
const agentHandle = value => {
  const handle = String(value ?? '').trim().replace(/^@+/u, '').toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    throw failure('invalid_agent_handle', 'Supply a speakable --handle matching ^[a-z][a-z0-9_-]{1,31}$ (e.g. --handle atlas).', 64);
  }
  return handle;
};
const agentBio = value => {
  if (value === undefined || value === null) return '';
  const bio = String(value).replace(/[\r\n\t]+/gu, ' ').trim();
  if (bio.length > 160) throw failure('invalid_agent_bio', '--bio must be at most 160 characters.', 64);
  return bio;
};

async function requireEmptyWorkspace(root) {
  const entries = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const blocking = entries.filter(name => !['.git', '.gitignore', 'README.md', 'package.json', 'package-lock.json', 'node_modules', 'shared', 'templates', '.tendriller'].includes(name));
  if (entries.includes(WORKSPACE_FILE)) throw failure('workspace_exists', `${join(root, WORKSPACE_FILE)} already exists. Resume this workspace; do not register a second agent for it.`);
  if (blocking.includes('pages')) throw failure('workspace_not_empty', 'This folder already holds page sources without a workspace file. Restore tendriller.json instead of creating a new agent.');
}

async function enroll(root, { service, handle, bio = '', kit, signal }, request) {
  const origin = requireServiceOrigin(service), paths = workspacePaths(root);
  await requireEmptyWorkspace(root);
  const retained = await readJson(paths.credential, true);
  if (retained) {
    if (retained.service !== origin) throw failure('service_origin_mismatch', 'This workspace credential belongs to another service origin. Use a separate folder for that service.');
  } else {
    requireService(await describeService(origin, { signal }));
  }
  const signer = await openSharedSigner(paths.identity, { create: !existsSync(paths.identity) });
  const wrap = await openWrapKey(paths.wrapKey, { create: !existsSync(paths.wrapKey) });
  let credential = retained;
  if (!credential) {
    const cleanHandle = agentHandle(handle);
    const cleanBio = agentBio(bio);
    const result = await request(origin, {
      handle: cleanHandle,
      ...(cleanBio ? { bio: cleanBio } : {}),
      publicKey: publicKeyBase64url(signer.publicKey),
      wrapKey: wrap.publicKey,
    }, { signal });
    credential = await savePrivateJson(paths.credential, {
      schemaVersion: 1, service: origin,
      agent: { id: result.id, handle: result.handle, bio: result.bio ?? cleanBio },
      token: result.token, publicKey: signer.publicKey, wrapKey: wrap.publicKey,
      accountState: result.account_state ?? null,
    });
  }
  if (credential.publicKey !== signer.publicKey) throw failure('agent_signer_mismatch', 'The retained signer does not match the registered agent key. Restore the original identity.sqlite.');
  if (credential.wrapKey !== wrap.publicKey) throw failure('agent_wrap_key_mismatch', 'The retained key-wrap key does not match the registered agent. Restore the original wrap-key.json.');
  const config = { schemaVersion: 1, service: origin, agent: credential.agent, ...(kit ? { kit } : {}), pages: {} };
  await replaceJson(paths.config, config);
  await ensureGitignore(root);
  return { workspace: root, service: origin, agent: credential.agent, accountState: credential.accountState,
    publicKey: signer.publicKey,
    next: 'Create a page with tendril page new <slug>; the owner claims this agent by signing in to the first page it creates. Then run tendril agent run.' };
}

async function ensureGitignore(root) {
  const path = join(root, '.gitignore');
  const current = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (!current.split(/\r?\n/u).includes('.tendriller/')) await writeFile(path, current + (current && !current.endsWith('\n') ? '\n' : '') + '.tendriller/\n');
}

/** Register a new unclaimed agent; the owner claims it by signing in to a page it creates. */
export async function initWorkspace(root, { service, owner, handle, bio = '', kit, signal } = {}) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(owner ?? '') || owner.length > 254) throw failure('invalid_owner', 'workspace init requires --owner VERIFIED_EMAIL', 64);
  const cleanHandle = agentHandle(handle);
  const cleanBio = agentBio(bio);
  const origin = requireServiceOrigin(service);
  if (!existsSync(workspacePaths(root).credential)) requireCreationReady(await describeReadiness(origin, { signal }), { service: origin });
  return enroll(root, { service: origin, handle: cleanHandle, bio: cleanBio, kit, signal }, (origin, body, options) => registerAgent(origin, { owner, ...body }, options));
}
/** Join the inviting account with a one-time code from Dashboard -> Your agents -> Add agent. */
export async function joinWorkspace(root, { service, code, handle, bio = '', kit, signal } = {}) {
  if (typeof code !== 'string' || !code.trim()) throw failure('invalid_join_code', 'workspace join requires --code from the owner dashboard', 64);
  const cleanHandle = agentHandle(handle);
  const cleanBio = agentBio(bio);
  return enroll(root, { service, handle: cleanHandle, bio: cleanBio, kit, signal }, (origin, body, options) => joinAgent(origin, { code: code.trim(), ...body }, options));
}

/**
 * The account-linked MCP route: create the shared key and print the public
 * register_agent arguments. Nothing is sent; the key is retained for adoptWorkspace.
 */
export async function workspaceKey(root, { service, handle, bio = '' } = {}) {
  const origin = requireServiceOrigin(service), paths = workspacePaths(root);
  const cleanHandle = agentHandle(handle);
  const cleanBio = agentBio(bio);
  await requireEmptyWorkspace(root);
  if (existsSync(paths.credential)) throw failure('agent_credential_exists', `${paths.credential} already exists. Resume with tendril workspace adopt or restore tendriller.json.`);
  const signer = await openSharedSigner(paths.identity, { create: !existsSync(paths.identity) });
  const wrap = await openWrapKey(paths.wrapKey, { create: !existsSync(paths.wrapKey) });
  return {
    service: origin,
    register_agent: { handle: cleanHandle, ...(cleanBio ? { bio: cleanBio } : {}), publicKey: publicKeyBase64url(signer.publicKey), wrapKey: wrap.publicKey },
    next: 'Call register_agent through the account-linked connector for this service with exactly these arguments, save its result privately, then run tendril workspace adopt --service ORIGIN --credential FILE.',
  };
}

/** Retain the agent credential an account-linked register_agent call returned for this workspace's key. */
export async function adoptWorkspace(root, { service, credential: file, kit, signal } = {}) {
  if (typeof file !== 'string' || !file) throw failure('invalid_credential_file', 'workspace adopt requires --credential FILE with the saved register_agent result', 64);
  const paths = workspacePaths(root);
  if (!existsSync(paths.identity)) throw failure('agent_signer_missing', 'Run tendril workspace key first; the registered public key must be this workspace key.', 64);
  const result = await readJson(resolve(root, file));
  const value = agentCredential(result?.structuredContent ?? result);
  if (!/^ag_[a-z2-7]{26}$/u.test(value?.id ?? '') || !AGENT_TOKEN.test(value?.token ?? '') || typeof value?.handle !== 'string' || !HANDLE_RE.test(value.handle))
    throw failure('invalid_agent_credential', 'The file does not hold a register_agent result {id, handle, token}.', 64);
  const origin = requireServiceOrigin(service);
  // The token is checked against this service before the workspace retains it.
  await createAgentClient({ service: origin, token: value.token }).self({ signal });
  return enroll(root, { service: origin, handle: value.handle, bio: value.bio ?? '', kit, signal }, async () => value);
}

/**
 * Re-enroll an existing workspace agent on the host while preserving its Ed25519 signing key
 * (`identity.sqlite`), X25519 wrap key (`wrap-key.json`), authored `pages/` source, and
 * retained `.tendriller/pages/<id>/` device stores. Archives the replaced credential and old
 * page registry instead of deleting data or silently recreating empty pages.
 */
export async function reenrollWorkspace(root, { service, owner, code, credential: credFile, handle, bio, signal, fetch: fetcher } = {}) {
  const dir = resolve(root), paths = workspacePaths(dir);
  const existingConfig = await readJson(paths.config, true);
  if (!existingConfig || existingConfig.schemaVersion !== 1 || !existingConfig.agent?.id) {
    throw failure('workspace_required', `No valid ${WORKSPACE_FILE} found in ${dir}. Use tendril workspace init for a new folder.`, 64);
  }
  const origin = requireServiceOrigin(service ?? existingConfig.service);
  if (existingConfig.service && existingConfig.service !== origin) {
    throw failure('service_origin_mismatch', `Workspace belongs to ${existingConfig.service}, not ${origin}. Use a separate folder for another origin.`);
  }
  if (!existsSync(paths.identity)) {
    throw failure('agent_signer_missing', `${paths.identity} is missing; cannot re-enroll without the existing agent signing key.`);
  }
  if (!existsSync(paths.wrapKey)) {
    throw failure('agent_wrap_key_missing', `${paths.wrapKey} is missing; cannot re-enroll without the existing agent wrap key.`);
  }
  const signer = await openSharedSigner(paths.identity, { create: false });
  const wrap = await openWrapKey(paths.wrapKey, { create: false });
  const cleanHandle = agentHandle(handle ?? existingConfig.agent.handle);
  const cleanBio = agentBio(bio !== undefined ? bio : (existingConfig.agent.bio ?? ''));
  const modes = [Boolean(owner), Boolean(code), Boolean(credFile)].filter(Boolean).length;
  if (modes !== 1) {
    throw failure('reenroll_mode_required', 'Supply exactly one of --owner EMAIL, --code JOIN_CODE, or --credential FILE.', 64);
  }

  let result;
  if (credFile) {
    const raw = await readJson(resolve(dir, credFile));
    const value = agentCredential(raw?.structuredContent ?? raw);
    if (!/^ag_[a-z2-7]{26}$/u.test(value?.id ?? '') || !AGENT_TOKEN.test(value?.token ?? '') || typeof value?.handle !== 'string' || !HANDLE_RE.test(value.handle)) {
      throw failure('invalid_agent_credential', 'The file does not hold a register_agent result {id, handle, token}.', 64);
    }
    await createAgentClient({ service: origin, token: value.token }, fetcher ? { fetch: fetcher } : undefined).self({ signal });
    result = value;
  } else if (code) {
    requireService(await describeService(origin, { ...(fetcher ? { fetch: fetcher } : {}), signal }));
    result = await joinAgent(origin, {
      code: String(code).trim(),
      handle: cleanHandle,
      ...(cleanBio ? { bio: cleanBio } : {}),
      publicKey: publicKeyBase64url(signer.publicKey),
      wrapKey: wrap.publicKey,
    }, { ...(fetcher ? { fetch: fetcher } : {}), signal });
  } else {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(owner ?? '') || owner.length > 254) {
      throw failure('invalid_owner', 'workspace reenroll --owner requires VERIFIED_EMAIL', 64);
    }
    requireCreationReady(await describeReadiness(origin, { ...(fetcher ? { fetch: fetcher } : {}), signal }), { service: origin });
    requireService(await describeService(origin, { ...(fetcher ? { fetch: fetcher } : {}), signal }));
    result = await registerAgent(origin, {
      owner,
      handle: cleanHandle,
      ...(cleanBio ? { bio: cleanBio } : {}),
      publicKey: publicKeyBase64url(signer.publicKey),
      wrapKey: wrap.publicKey,
    }, { ...(fetcher ? { fetch: fetcher } : {}), signal });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const previousCred = await readJson(paths.credential, true);
  let archivedCredential = null;
  if (previousCred) {
    archivedCredential = join(paths.agent, `credential.replaced-${stamp}.json`);
    await savePrivateJson(archivedCredential, { replacedAt: new Date().toISOString(), previous: previousCred });
  }
  const previousPages = existingConfig.pages && typeof existingConfig.pages === 'object' ? existingConfig.pages : {};
  let archivedPagesFile = null;
  if (Object.keys(previousPages).length > 0) {
    archivedPagesFile = join(paths.secret, `migration-archive-${stamp}.json`);
    await savePrivateJson(archivedPagesFile, {
      archivedAt: new Date().toISOString(),
      previousAgent: existingConfig.agent,
      publicKey: signer.publicKey,
      wrapKey: wrap.publicKey,
      pages: previousPages,
      note: 'Retained prior page references and local .tendriller/pages/<id>/ device stores. Export and import your data before creating replacement pages.',
    });
  }

  const nextAgent = { id: result.id, handle: result.handle ?? cleanHandle, bio: result.bio ?? cleanBio };
  await replaceJson(paths.credential, {
    schemaVersion: 1,
    service: origin,
    agent: nextAgent,
    token: result.token,
    publicKey: signer.publicKey,
    wrapKey: wrap.publicKey,
    accountState: result.account_state ?? null,
    reenrolledAt: new Date().toISOString(),
  }, 0o600);

  const nextConfig = {
    ...existingConfig,
    service: origin,
    agent: nextAgent,
    pages: {},
  };
  await replaceJson(paths.config, nextConfig);

  return {
    reenrolled: true,
    workspace: dir,
    service: origin,
    agent: nextAgent,
    publicKey: signer.publicKey,
    wrapKey: wrap.publicKey,
    archivedCredential,
    archivedPagesFile,
    archivedPageSlugs: Object.keys(previousPages),
    next: 'Existing signing/wrap keys and local .tendriller/pages/ stores were preserved. Export local data, then create replacement v2 pages (npm run page:new / init / deploy) and import your data before acknowledging any migration broadcast.',
  };
}

/** Update this workspace agent's @handle and/or bio on the host and in local workspace files. */
export async function updateWorkspaceProfile(workspace, { handle, bio } = {}, { signal } = {}) {
  const body = {};
  if (handle !== undefined) body.handle = agentHandle(handle);
  if (bio !== undefined) body.bio = agentBio(bio);
  if (Object.keys(body).length === 0) throw failure('invalid_profile_update', 'Supply --handle and/or --bio to update the agent profile.', 64);
  const client = await workspace.client();
  const updated = await client.updateProfile(body, { signal });
  const nextAgent = {
    id: workspace.config.agent.id,
    handle: updated.handle ?? body.handle ?? workspace.config.agent.handle,
    bio: updated.bio ?? body.bio ?? workspace.config.agent.bio ?? '',
  };
  workspace.config.agent = nextAgent;
  await replaceJson(workspace.paths.config, workspace.config);
  const cred = await workspace.credential();
  await replaceJson(workspace.paths.credential, { ...cred, agent: nextAgent }, 0o600);
  return nextAgent;
}

export async function openWorkspace({ root = findWorkspace(), fetch: fetcher, WebSocket } = {}) {
  if (!root) throw failure('workspace_required', 'No tendriller.json found here or in a parent folder. Run tendril workspace init --service ORIGIN --owner EMAIL in an empty folder, or cd into the workspace.', 64);
  const paths = workspacePaths(root);
  if (existsSync(paths.retired)) throw failure('workspace_retired_by_checkpoint', `This workspace was moved to a checkpoint (${paths.retired}). Restore that checkpoint with tendril checkpoint restore in an empty folder and use that copy; this one never resumes.`);
  const config = await readJson(paths.config);
  if (config?.schemaVersion !== 1 || typeof config.service !== 'string' || !config.agent?.id)
    throw failure('workspace_state_invalid', `${paths.config} is not a Tendriller workspace file.`);
  let credential, client, signer, wrapKey;
  const readCredential = async () => {
    credential ??= await readJson(paths.credential, true);
    if (!credential) throw failure('agent_credential_missing', `${paths.credential} is missing. Restore it from a checkpoint; the agent token is never reissued silently.`);
    if (credential.service !== config.service || credential.agent?.id !== config.agent.id || !AGENT_TOKEN.test(credential.token ?? ''))
      throw failure('workspace_state_invalid', 'The retained agent credential does not match tendriller.json.');
    return credential;
  };
  const getClient = async () => client ??= createAgentClient({ service: config.service, token: (await readCredential()).token },
    { ...(fetcher ? { fetch: fetcher } : {}), ...(WebSocket ? { WebSocket } : {}) });
  // Another process (page new, page grant) may register pages while this one runs.
  const refreshPages = async () => {
    const current = await readJson(paths.config);
    if (current?.agent?.id === config.agent.id) config.pages = current.pages;
  };
  const pageDirectory = id => join(paths.pages, id);
  const record = async id => readJson(join(pageDirectory(id), 'page.json'), true);
  const workspace = {
    root, paths, config,
    credential: readCredential,
    client: getClient,
    async signer() {
      signer ??= await openSharedSigner(paths.identity);
      if (signer.publicKey !== (await readCredential()).publicKey) throw failure('agent_signer_mismatch', 'identity.sqlite does not hold the registered agent key.');
      return signer;
    },
    async wrapKey() {
      if (!wrapKey) {
        const saved = await openWrapKey(paths.wrapKey);
        if (saved.publicKey !== (await readCredential()).wrapKey) throw failure('agent_wrap_key_mismatch', 'wrap-key.json does not hold the registered agent key-wrap key.');
        wrapKey = await importWrapKey(saved);
      }
      return wrapKey;
    },
    /** Resolve --page <slug|id> against the workspace registry. */
    async page(ref) {
      await refreshPages();
      const slugs = Object.entries(config.pages ?? {});
      if (ref === undefined) {
        if (slugs.length === 1) ref = slugs[0][0];
        else throw failure('page_required', slugs.length ? `Choose --page <slug|id>: ${slugs.map(([slug]) => slug).join(', ')}` : 'This workspace has no pages yet. Run tendril page new <slug>.', 64);
      }
      const entry = slugs.find(([slug, value]) => slug === ref || value.id === ref);
      if (!entry) throw failure('page_unknown', `No page ${JSON.stringify(String(ref).slice(0, 64))} in this workspace. Run tendril page list.`, 64);
      const [slug, { id }] = entry, saved = await record(id);
      if (!saved || saved.id !== id) throw failure('page_state_missing', `.tendriller/pages/${id}/page.json is missing. Restore it from a checkpoint.`);
      return { ...saved, slug, directory: pageDirectory(id), source: join(paths.sources, slug) };
    },
    async pages() {
      await refreshPages();
      return Promise.all(Object.entries(config.pages ?? {}).map(async ([slug, { id }]) => {
        const saved = await record(id);
        return { slug, id, ...(saved ? { name: saved.name, application: saved.application } : { missing: true }),
          initialized: existsSync(join(pageDirectory(id), 'initialized.json')),
          module: existsSync(join(paths.sources, slug, 'agent.mjs')) };
      }));
    },
    /** Retain exact creation intent before dispatch; uncertainty never creates a replacement page. */
    async createPage(slug, { name = slug, mode, application, subdomain } = {}, { signal } = {}) {
      if (typeof slug !== 'string' || !SLUG.test(slug)) throw failure('invalid_slug', 'Use a page slug of lowercase letters, digits and dashes (max 48).', 64);
      assertValid('agentPageCreate', { name, ...(mode === undefined ? {} : { mode }), ...(application === undefined ? {} : { application }), ...(subdomain === undefined ? {} : { subdomain }) });
      await refreshPages();
      if (!config.pages?.[slug]) requireCreationReady(await describeReadiness(config.service, { ...(fetcher ? { fetch: fetcher } : {}), signal }), { service: config.service });
      const directory = join(paths.secret, 'page-intents', slug);
      const store = {
        read: (name, optional) => readJson(join(directory, name), optional),
        save: (name, value) => savePrivateJson(join(directory, name), value),
        async claim(name, value) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          try { await writeFile(join(directory, name), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true }); return true; }
          catch (error) { if (error.code === 'EEXIST') return false; throw error; }
        },
      };
      return createWorkspacePage({ workspace, client: await getClient(), store, slug, name, mode, application, subdomain, signal });
    },
    /** Set, rename, reassign/swap, or clear a page's named subdomain and persist updated page URLs locally. */
    async setPageSubdomain(ref, subdomain, { reassign = false, swap = false, signal } = {}) {
      const page = await workspace.page(ref);
      const client = await getClient();
      const updated = await client.page(page.id).setSubdomain(subdomain, { ...(reassign ? { reassign: true } : {}), ...(swap ? { swap: true } : {}), signal });
      const saved = await record(page.id);
      if (saved) {
        await replaceJson(join(pageDirectory(page.id), 'page.json'), {
          ...saved,
          subdomain: updated.subdomain ?? null,
          page_url: updated.page_url ?? saved.page_url,
          bare_url: updated.bare_url ?? null,
        });
      }
      if (updated.previous_tendril_id) {
        const prevSaved = await record(updated.previous_tendril_id);
        if (prevSaved) {
          const prevInfo = await client.page(updated.previous_tendril_id).info().catch(() => null);
          await replaceJson(join(pageDirectory(updated.previous_tendril_id), 'page.json'), {
            ...prevSaved,
            subdomain: updated.swapped_subdomain ?? null,
            page_url: typeof prevInfo?.page_url === 'string' ? prevInfo.page_url : prevSaved.page_url,
            bare_url: typeof prevInfo?.bare_url === 'string' ? prevInfo.bare_url : null,
          });
        }
      }
      return { slug: page.slug, ...updated };
    },
    /** Register a granted page under a slug; the page URL stays in the private record. */
    async registerPage(slug, page) {
      if (!SLUG.test(slug ?? '')) throw failure('invalid_slug', 'Use a page slug of lowercase letters, digits and dashes (max 48).', 64);
      if (!PAGE_ID.test(page?.id ?? '')) throw failure('invalid_page', 'The host returned an invalid page identity.');
      await refreshPages();
      const existing = config.pages?.[slug];
      if (existing && existing.id !== page.id) throw failure('slug_taken', `Slug ${slug} already names page ${existing.id}.`, 64);
      const other = Object.entries(config.pages ?? {}).find(([name, value]) => value.id === page.id && name !== slug);
      if (other) throw failure('page_registered', `Page ${page.id} is already registered as ${other[0]}.`, 64);
      await mkdir(pageDirectory(page.id), { recursive: true, mode: 0o700 });
      const previous = await record(page.id);
      if (!previous) await savePrivateJson(join(pageDirectory(page.id), 'page.json'), { schemaVersion: 1, id: page.id, name: page.name ?? slug,
        ...(page.subdomain ? { subdomain: page.subdomain } : {}),
        page_url: page.page_url, ...(page.bare_url ? { bare_url: page.bare_url } : {}), application: page.application, scopes: page.scopes ?? [], registered_at: new Date().toISOString() });
      config.pages = { ...config.pages, [slug]: { id: page.id } };
      await replaceJson(paths.config, config);
      await mkdir(join(paths.sources, slug), { recursive: true });
      return workspace.page(slug);
    },
    async unregisterPage(slug) {
      await refreshPages();
      const { [slug]: removed, ...rest } = config.pages ?? {};
      if (!removed) return false;
      config.pages = rest; await replaceJson(paths.config, config); return true;
    },
    /** The local terminal binding for the running agent program's attach socket. */
    async attachBinding({ create = false } = {}) {
      const saved = await readJson(paths.attach, true);
      if (saved || !create) return saved;
      const { createNativeAttachmentKey } = await import('@tendriller/core/native-owner');
      return savePrivateJson(paths.attach, { id: 'local-terminal', token: createNativeAttachmentKey(), policy: ATTACH_POLICY });
    },
    /** Everything a page module needs; it never sees the agent token or private key bytes. */
    async pageContext(ref, { signal, report = () => {}, roster, broadcasts } = {}) {
      const page = await workspace.page(ref), agent = await getClient(), shared = await workspace.signer(), wrap = await workspace.wrapKey();
      const host = agent.page(page.id, { applicationId: page.application.id });
      const privatePath = name => {
        if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) throw failure('invalid_private_name', 'Private record names are plain file names.');
        return join(page.directory, name);
      };
      const defaultRoster = Object.freeze({
        get primaryAgentId() { return null; },
        get isPrimary() { return false; },
        get agents() { return []; },
        snapshot: () => ({ primary_agent_id: null, is_primary: false, agents: [] }),
        onChange: () => () => {},
      });
      const defaultBroadcasts = Object.freeze({
        snapshot: () => ({ latestSeq: 0, versions: null, active: [], all: [] }),
        acknowledge: async () => false,
        onBroadcast: () => () => {},
      });
      return Object.freeze({
        workspace: root, service: config.service, agent: config.agent,
        page: Object.freeze({ id: page.id, slug: page.slug, name: page.name, applicationId: page.application.id,
          pageUrl: page.page_url, directory: page.directory, source: page.source }),
        host, signal, report,
        roster: roster ?? defaultRoster,
        broadcasts: broadcasts ?? defaultBroadcasts,
        // Opaque signing authority stays in the Node-only context; never serialize it
        // into configuration, authored files, diagnostics or a checkpoint record.
        signer: Object.freeze({ publicKey: shared.publicKey, privateKey: shared.privateKey }),
        // The agent's key-wrap key (opaque, non-extractable private CryptoKey) for receiving wrapped page keys.
        wrapKey: wrap,
        devicePath: join(page.directory, 'device.sqlite'),
        openDevice: ({ create = false } = {}) => openPageDevice({ path: join(page.directory, 'device.sqlite'), signer: shared, create }),
        readPrivate: (name, optional = false) => readJson(privatePath(name), optional),
        savePrivate: (name, value) => savePrivateJson(privatePath(name), value),
        privatePath,
      });
    },
    pageModule: async page => import(pathToFileURL(join(paths.sources, page.slug, 'agent.mjs')).href),
  };
  return workspace;
}

/** Detect installed connector & Chronolog dependency versions in a workspace. */
export async function detectWorkspaceVersions(root, kit) {
  const readPkgVersion = async rel => {
    const pkg = await readJson(join(root, rel), true);
    return typeof pkg?.version === 'string' ? pkg.version.trim() : null;
  };
  const [core, tools, chronolog, authority, rootPkg] = await Promise.all([
    readPkgVersion('node_modules/@tendriller/core/package.json'),
    readPkgVersion('node_modules/@tendriller/tools/package.json'),
    readPkgVersion('node_modules/@chronolog/peer-session/package.json'),
    readPkgVersion('node_modules/@chronolog/authority/package.json'),
    readJson(join(root, 'package.json'), true),
  ]);
  const packages = {};
  if (core) packages['@tendriller/core'] = core;
  if (tools) packages['@tendriller/tools'] = tools;
  if (chronolog) packages['@chronolog/peer-session'] = chronolog;
  if (authority) packages['@chronolog/authority'] = authority;
  const declared = { ...(rootPkg?.dependencies ?? {}), ...(rootPkg?.devDependencies ?? {}) };
  for (const name of ['@tendriller/core', '@tendriller/tools', '@chronolog/peer-session', '@chronolog/authority']) {
    if (!packages[name] && typeof declared[name] === 'string' && /^[0-9]/.test(declared[name].replace(/^[\^~]/, ''))) {
      packages[name] = declared[name].replace(/^[\^~]/, '');
    }
  }
  const raw = {
    ...(packages['@tendriller/core'] ? { core: packages['@tendriller/core'] } : {}),
    ...(packages['@tendriller/tools'] ? { tools: packages['@tendriller/tools'] } : {}),
    ...(packages['@chronolog/peer-session'] ? { chronolog: packages['@chronolog/peer-session'] } : {}),
    ...(packages['@chronolog/authority'] ? { authority: packages['@chronolog/authority'] } : {}),
    node: process.versions.node,
    ...(typeof kit === 'string' && /^[A-Za-z0-9.+_-]{1,64}$/.test(kit) ? { kit } : {}),
    ...(Object.keys(packages).length ? { packages } : {}),
  };
  try { return validateClientVersions(raw); } catch { return { node: process.versions.node }; }
}

export async function readBroadcastState(workspace) {
  if (!workspace?.paths?.broadcasts) {
    return { schemaVersion: 1, lastSeq: 0, acknowledged: [], trustedKeys: [], items: [] };
  }
  const saved = await readJson(workspace.paths.broadcasts, true);
  if (!saved || typeof saved !== 'object') {
    return { schemaVersion: 1, lastSeq: 0, lastSyncedAt: null, acknowledged: [], trustedKeys: [], items: [] };
  }
  return {
    schemaVersion: 1,
    lastSeq: Number.isSafeInteger(saved.lastSeq) && saved.lastSeq >= 0 ? saved.lastSeq : 0,
    lastSyncedAt: Number.isSafeInteger(saved.lastSyncedAt) && saved.lastSyncedAt > 0 ? saved.lastSyncedAt : null,
    acknowledged: Array.isArray(saved.acknowledged) ? saved.acknowledged.filter(v => typeof v === 'string') : [],
    trustedKeys: Array.isArray(saved.trustedKeys) ? saved.trustedKeys : [],
    items: Array.isArray(saved.items) ? saved.items : [],
  };
}

export async function saveBroadcastState(workspace, state) {
  if (!workspace?.paths?.broadcasts) return;
  await mkdir(dirname(workspace.paths.broadcasts), { recursive: true, mode: 0o700 });
  await replaceJson(workspace.paths.broadcasts, {
    schemaVersion: 1,
    lastSeq: state.lastSeq ?? 0,
    lastSyncedAt: state.lastSyncedAt ?? Date.now(),
    acknowledged: [...new Set(state.acknowledged ?? [])].slice(-200),
    trustedKeys: state.trustedKeys ?? [],
    items: (state.items ?? []).slice(-100),
  }, 0o600);
}

/** Verify and locally evaluate signed broadcasts for a workspace, persisting the cursor. */
export async function syncWorkspaceBroadcasts(workspace, { signal, all = false } = {}) {
  const client = await workspace.client();
  const [versions, state] = await Promise.all([
    detectWorkspaceVersions(workspace.root, workspace.config.kit),
    readBroadcastState(workspace),
  ]);
  let trustedKeys = state.trustedKeys;
  try {
    const fetchedKeys = await client.broadcastKeys({ signal });
    if (fetchedKeys.keys.length) trustedKeys = fetchedKeys.keys;
  } catch { /* fall back to cached trusted keys */ }
  const feed = await client.broadcasts({
    audience: 'agents',
    since: all ? 0 : 0,
    verifyKeys: trustedKeys,
    signal,
  });
  const ackSet = new Set(state.acknowledged);
  const evaluated = feed.verified.map(signed => {
    const match = evaluateBroadcastMatch(signed.payload, { audience: 'agents', versions });
    return {
      ...signed.payload,
      signed: { payload: signed.payload, signature: signed.signature },
      signature: signed.signature,
      verified: true,
      matched: match.matched,
      matchReasons: match.reasons,
      acknowledged: ackSet.has(signed.payload.id),
    };
  });
  const nextSeq = Math.max(state.lastSeq, feed.latest_seq);
  await saveBroadcastState(workspace, {
    lastSeq: nextSeq,
    acknowledged: state.acknowledged,
    trustedKeys,
    items: evaluated,
  });
  return {
    issuer: feed.issuer,
    latest_seq: nextSeq,
    versions,
    active: evaluated.filter(b => b.matched && !b.acknowledged),
    all: evaluated,
    rejected: feed.rejected.map(r => ({ reason: r.reason })),
  };
}

export async function acknowledgeWorkspaceBroadcast(workspace, id) {
  if (typeof id !== 'string' || !/^bc_[a-z2-7]{26}$/.test(id)) {
    throw failure('invalid_broadcast_id', 'Supply a valid broadcast id (bc_...).', 64);
  }
  const state = await readBroadcastState(workspace);
  const acked = new Set(state.acknowledged);
  acked.add(id);
  const items = state.items.map(item => item.id === id ? { ...item, acknowledged: true } : item);
  await saveBroadcastState(workspace, { ...state, acknowledged: [...acked], items });
  return { acknowledged: true, id };
}

const FALLOW_WORKSPACE_MS = 14 * 86_400_000;
const ROLE_TO_PACKAGE = Object.freeze({
  sdk: '@tendriller/core',
  tools: '@tendriller/tools',
  authority: '@chronolog/authority',
  session: '@chronolog/peer-session',
  'session-sql-browser': '@chronolog/peer-session',
});

/**
 * Verify that a workspace's composition.json, packages/*.tgz archives, package-lock.json
 * SRI integrity values, and installed node_modules match the exact selected immutable release.
 * Detects silent stale-lockfile installs when distinct releases share a semver filename.
 */
export async function verifyWorkspaceComposition(root, { requireInstalled = true } = {}) {
  const dir = resolve(root);
  const issues = [];
  const composition = await readJson(join(dir, 'composition.json'), true);
  if (!composition) {
    return {
      present: false,
      ok: true,
      compositionId: null,
      sourceCommit: null,
      runtimeId: null,
      version: null,
      issues: [],
    };
  }
  const { id, ...body } = composition;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id) || sha256Hex(Buffer.from(JSON.stringify(body))) !== id) {
    issues.push({ kind: 'composition_hash_mismatch', message: 'composition.json self-hash does not match its contents.' });
  }
  const profile = await readJson(join(dir, 'first-app-profile.json'), true);
  const selectedRoles = Array.isArray(profile?.packages) ? profile.packages
    : ['sdk', 'tools', 'authority', 'session'];
  const components = Array.isArray(composition.components) ? composition.components : [];
  const expectedArchives = new Map();
  for (const role of selectedRoles) {
    const comp = components.find(item => item.role === role);
    if (!comp) {
      issues.push({ kind: 'composition_component_missing', role, message: `composition.json is missing component role "${role}".` });
      continue;
    }
    const archivePath = join(dir, 'packages', comp.file);
    let bytes;
    try { bytes = await readFile(archivePath); }
    catch {
      issues.push({ kind: 'archive_missing', role, file: comp.file, message: `Missing release archive packages/${comp.file}.` });
      continue;
    }
    const actualSha256 = sha256Hex(bytes);
    if (actualSha256 !== comp.sha256) {
      issues.push({
        kind: 'archive_hash_mismatch',
        role,
        file: comp.file,
        expectedSha256: comp.sha256,
        actualSha256,
        message: `packages/${comp.file} SHA-256 does not match composition.json.`,
      });
    }
    const pkgName = ROLE_TO_PACKAGE[role];
    if (pkgName) {
      expectedArchives.set(pkgName, { role, file: comp.file, sha256: comp.sha256, sri: sha512Sri(bytes) });
    }
  }

  const lockfile = await readJson(join(dir, 'package-lock.json'), true);
  if (lockfile && typeof lockfile === 'object') {
    const lockPackages = lockfile.packages && typeof lockfile.packages === 'object' ? lockfile.packages : {};
    for (const [pkgName, info] of expectedArchives) {
      const entry = lockPackages[`node_modules/${pkgName}`];
      const expectedResolved = `packages/${info.file}`;
      if (!entry) {
        if (requireInstalled) {
          issues.push({ kind: 'lockfile_entry_missing', package: pkgName, file: info.file, message: `package-lock.json is missing node_modules/${pkgName}.` });
        }
        continue;
      }
      const resolvedNorm = String(entry.resolved ?? '').replace(/^file:/u, '').replace(/^\.\//u, '');
      if (resolvedNorm && resolvedNorm !== expectedResolved && !resolvedNorm.endsWith(`/${expectedResolved}`)) {
        issues.push({
          kind: 'lockfile_resolved_mismatch',
          package: pkgName,
          expected: expectedResolved,
          actual: entry.resolved,
          message: `package-lock.json resolves ${pkgName} to ${entry.resolved} instead of ${expectedResolved}.`,
        });
      }
      if (entry.integrity && entry.integrity !== info.sri) {
        issues.push({
          kind: 'lockfile_archive_mismatch',
          package: pkgName,
          file: info.file,
          expectedIntegrity: info.sri,
          lockIntegrity: entry.integrity,
          message: `package-lock.json integrity for ${pkgName} (${info.file}) still pins stale archive bytes. Regenerate the lockfile with tendril workspace upgrade.`,
        });
      }
    }
  } else if (requireInstalled) {
    issues.push({ kind: 'lockfile_missing', message: 'package-lock.json is missing; run tendril workspace upgrade to generate a verified lockfile.' });
  }

  if (requireInstalled) {
    const expectedSource = composition.core?.source ?? null;
    const expectedRuntime = composition.runtime ?? null;
    const corePkg = await readJson(join(dir, 'node_modules/@tendriller/core/package.json'), true);
    if (!corePkg) {
      issues.push({ kind: 'installed_package_missing', package: '@tendriller/core', message: 'node_modules/@tendriller/core is not installed.' });
    } else {
      let installedSource = corePkg.tendriller?.sourceCommit ?? null;
      if (!installedSource) {
        const onboardingSrc = await readFile(join(dir, 'node_modules/@tendriller/core/onboarding.mjs'), 'utf8').catch(() => '');
        const match = /const RELEASE_SOURCE = '([a-f0-9]{40})'/u.exec(onboardingSrc);
        if (match) installedSource = match[1];
      }
      if (expectedSource && installedSource && installedSource !== expectedSource) {
        issues.push({
          kind: 'installed_package_mismatch',
          package: '@tendriller/core',
          expectedSourceCommit: expectedSource,
          installedSourceCommit: installedSource,
          message: `Installed @tendriller/core (${installedSource.slice(0, 8)}) does not match composition source ${expectedSource.slice(0, 8)}.`,
        });
      }
    }
    const toolsPkg = await readJson(join(dir, 'node_modules/@tendriller/tools/package.json'), true);
    if (!toolsPkg) {
      issues.push({ kind: 'installed_package_missing', package: '@tendriller/tools', message: 'node_modules/@tendriller/tools is not installed.' });
    } else {
      if (expectedRuntime && toolsPkg.tendriller?.runtime && toolsPkg.tendriller.runtime !== expectedRuntime) {
        issues.push({
          kind: 'installed_package_mismatch',
          package: '@tendriller/tools',
          expectedRuntime,
          installedRuntime: toolsPkg.tendriller.runtime,
          message: `Installed @tendriller/tools runtime (${toolsPkg.tendriller.runtime.slice(0, 8)}) does not match composition runtime ${expectedRuntime.slice(0, 8)}.`,
        });
      }
      if (expectedSource && toolsPkg.tendriller?.sourceCommit && toolsPkg.tendriller.sourceCommit !== expectedSource) {
        issues.push({
          kind: 'installed_package_mismatch',
          package: '@tendriller/tools',
          expectedSourceCommit: expectedSource,
          installedSourceCommit: toolsPkg.tendriller.sourceCommit,
          message: `Installed @tendriller/tools (${toolsPkg.tendriller.sourceCommit.slice(0, 8)}) does not match composition source ${expectedSource.slice(0, 8)}.`,
        });
      }
    }
  }

  return {
    present: true,
    ok: issues.length === 0,
    compositionId: typeof id === 'string' ? id : null,
    sourceCommit: composition.core?.source ?? null,
    runtimeId: composition.runtime ?? null,
    version: composition.version ?? null,
    issues,
  };
}

/**
 * Upgrade a workspace to a verified release composition without losing `.tendriller/` or `pages/`.
 * Cleanly regenerates `package-lock.json` in an isolated staging directory so npm cannot keep
 * stale integrity hashes for same-version archive filenames, runs `npm ci --ignore-scripts`,
 * and fails closed if any installed package or lockfile entry disagrees with `composition.json`.
 */
export async function upgradeWorkspace(root, { kit, checkOnly = false, npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm', exec = execFileAsync } = {}) {
  const dir = resolve(root);
  if (checkOnly) {
    const check = await verifyWorkspaceComposition(dir, { requireInstalled: true });
    if (!check.present) {
      throw failure('composition_missing', `No composition.json found in ${dir}.`, 1);
    }
    if (!check.ok) {
      throw Object.assign(
        failure('workspace_composition_mismatch', check.issues.map(i => i.message).join(' '), 1),
        { verification: check },
      );
    }
    return check;
  }

  let stagedKitDir = null;
  let cleanupKit = false;
  try {
    if (kit) {
      const kitPath = resolve(dir, kit);
      const info = await stat(kitPath).catch(() => null);
      if (!info) throw failure('upgrade_kit_missing', `Upgrade kit not found: ${kitPath}`, 64);
      if (info.isDirectory()) {
        stagedKitDir = kitPath;
      } else {
        stagedKitDir = await mkdtemp(join(tmpdir(), 'tendril-upgrade-kit-'));
        cleanupKit = true;
        await exec('tar', ['-xzf', kitPath, '-C', stagedKitDir], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      }
      const kitCheck = await verifyWorkspaceComposition(stagedKitDir, { requireInstalled: false });
      if (!kitCheck.present || !kitCheck.ok) {
        throw Object.assign(
          failure('upgrade_kit_invalid', kitCheck.issues.map(i => i.message).join(' ') || 'Kit is missing composition.json.', 1),
          { verification: kitCheck },
        );
      }
      for (const name of ['composition.json', 'first-app-profile.json', 'setup.mjs']) {
        if (existsSync(join(stagedKitDir, name))) {
          await cp(join(stagedKitDir, name), join(dir, name), { force: true });
        }
      }
      for (const folder of ['packages', 'shared', 'consumers', 'templates']) {
        if (existsSync(join(stagedKitDir, folder))) {
          await rm(join(dir, folder), { recursive: true, force: true });
          await cp(join(stagedKitDir, folder), join(dir, folder), { recursive: true, force: true });
        }
      }
    }

    const preCheck = await verifyWorkspaceComposition(dir, { requireInstalled: false });
    if (!preCheck.present) {
      throw failure('composition_missing', `No composition.json found in ${dir}. Pass --kit <archive-or-dir> or unpack the verified release kit first.`, 64);
    }
    const preArchiveIssues = preCheck.issues.filter(i => i.kind !== 'lockfile_archive_mismatch' && i.kind !== 'lockfile_resolved_mismatch' && i.kind !== 'lockfile_entry_missing' && i.kind !== 'lockfile_missing');
    if (preArchiveIssues.length > 0) {
      throw Object.assign(
        failure('upgrade_kit_invalid', preArchiveIssues.map(i => i.message).join(' '), 1),
        { verification: preCheck },
      );
    }

    const composition = await readJson(join(dir, 'composition.json'));
    const profile = await readJson(join(dir, 'first-app-profile.json'), true);
    const selectedRoles = Array.isArray(profile?.packages) ? profile.packages : ['sdk', 'tools', 'authority', 'session'];
    const pkgPath = join(dir, 'package.json');
    const pkgJson = await readJson(pkgPath, true) ?? { name: 'tendriller-pages', private: true, type: 'module', dependencies: {} };
    pkgJson.dependencies = { ...(pkgJson.dependencies ?? {}) };
    for (const role of selectedRoles) {
      const comp = (composition.components ?? []).find(item => item.role === role);
      const pkgName = ROLE_TO_PACKAGE[role];
      if (comp && pkgName) pkgJson.dependencies[pkgName] = `file:packages/${comp.file}`;
    }
    await replaceJson(pkgPath, pkgJson);

    const lockStage = await mkdtemp(join(tmpdir(), 'tendril-upgrade-lock-'));
    try {
      await cp(pkgPath, join(lockStage, 'package.json'));
      await cp(join(dir, 'packages'), join(lockStage, 'packages'), { recursive: true });
      await exec(npmBin, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: lockStage, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      const generatedLock = await readFile(join(lockStage, 'package-lock.json'), 'utf8');
      const tmpLock = join(dir, `package-lock.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(tmpLock, generatedLock, { flag: 'wx', mode: 0o644, flush: true });
      await rename(tmpLock, join(dir, 'package-lock.json'));
    } finally {
      await rm(lockStage, { recursive: true, force: true });
    }

    await exec(npmBin, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: dir, timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    });

    const postCheck = await verifyWorkspaceComposition(dir, { requireInstalled: true });
    if (!postCheck.ok) {
      throw Object.assign(
        failure('workspace_upgrade_verification_failed', postCheck.issues.map(i => i.message).join(' '), 1),
        { verification: postCheck },
      );
    }
    return {
      upgraded: true,
      workspace: dir,
      compositionId: postCheck.compositionId,
      sourceCommit: postCheck.sourceCommit,
      runtimeId: postCheck.runtimeId,
      version: postCheck.version,
      verified: true,
    };
  } finally {
    if (cleanupKit && stagedKitDir) await rm(stagedKitDir, { recursive: true, force: true });
  }
}

/** Bounded, non-secret status for terminals and the status command. */
export async function describeWorkspace(workspace, { signal, remote = true } = {}) {
  const [pages, versions, priorBroadcastState, compositionCheck] = await Promise.all([
    workspace.pages(),
    detectWorkspaceVersions(workspace.root, workspace.config.kit),
    readBroadcastState(workspace),
    verifyWorkspaceComposition(workspace.root, { requireInstalled: true }),
  ]);
  let agent = null, granted = null, broadcasts = null, catchup = null, error;
  if (remote) {
    try {
      const client = await workspace.client();
      const [selfRes, serviceInfo, readinessInfo] = await Promise.all([
        client.self({ signal }),
        describeService(workspace.config.service, { signal }).catch(() => null),
        describeReadiness(workspace.config.service, { signal }).catch(() => null),
      ]);
      agent = selfRes;
      granted = [];
      for await (const page of client.pages.all({ signal })) granted.push({ id: page.id, name: page.name, scopes: page.scopes ?? [] });
      broadcasts = await syncWorkspaceBroadcasts(workspace, { signal }).then(res => ({
        latestSeq: res.latest_seq,
        activeCount: res.active.length,
        active: res.active.map(({ id, seq, kind, severity, title, summary, docs_url, action, matchReasons }) => ({
          id, seq, kind, severity, title, summary, docs_url, action, matchReasons,
        })),
      })).catch(() => null);

      const installedCore = versions.core ?? versions.packages?.['@tendriller/core'] ?? null;
      const hostCore = serviceInfo?.core_release ?? readinessInfo?.build?.coreRelease ?? null;
      const coreBehind = Boolean(installedCore && hostCore && compareSemver(installedCore, hostCore) === -1);
      const installedCompositionId = compositionCheck.compositionId;
      const hostCompositionId = readinessInfo?.build?.compositionId ?? null;
      const installedSourceCommit = compositionCheck.sourceCommit;
      const hostSourceCommit = readinessInfo?.build?.sourceCommit ?? null;
      const compositionBehind = Boolean(
        (installedCompositionId && hostCompositionId && installedCompositionId !== hostCompositionId) ||
        (installedSourceCommit && hostSourceCommit && installedSourceCommit !== hostSourceCommit),
      );
      const archiveMismatch = compositionCheck.present && !compositionCheck.ok;
      const fallow = Boolean(priorBroadcastState.lastSyncedAt && (Date.now() - priorBroadcastState.lastSyncedAt) > FALLOW_WORKSPACE_MS);
      if (coreBehind || compositionBehind || archiveMismatch || fallow) {
        const sinceDate = priorBroadcastState.lastSyncedAt ? new Date(priorBroadcastState.lastSyncedAt).toISOString().slice(0, 10) : undefined;
        const changelog = await fetchChangelog(workspace.config.service, {
          ...(sinceDate ? { since: sinceDate } : {}),
          ...(coreBehind && installedCore ? { sinceCore: installedCore } : {}),
          signal,
        }).catch(() => null);
        const counts = { security: 0, breaking: 0, deprecation: 0, feature: 0 };
        for (const item of changelog?.entries ?? []) {
          if (Object.hasOwn(counts, item.category)) counts[item.category]++;
        }
        const origin = new URL(workspace.config.service).origin;
        const cmdHint = (compositionBehind || archiveMismatch)
          ? 'tendril workspace upgrade --kit <verified-first-app.tgz>'
          : sinceDate
            ? `tendril changelog --since ${sinceDate}`
            : installedCore ? `tendril changelog --since-core ${installedCore}` : 'tendril changelog';
        catchup = {
          stale: true,
          reasons: [
            ...(coreBehind ? ['core_behind_host'] : []),
            ...(compositionBehind ? ['composition_behind_host'] : []),
            ...(archiveMismatch ? ['lockfile_archive_mismatch'] : []),
            ...(fallow ? ['fallow_workspace'] : []),
          ],
          installedCore,
          hostCore,
          ...(installedCompositionId ? { installedCompositionId } : {}),
          ...(hostCompositionId ? { hostCompositionId } : {}),
          ...(installedSourceCommit ? { installedSourceCommit } : {}),
          ...(hostSourceCommit ? { hostSourceCommit } : {}),
          ...(archiveMismatch ? { verificationIssues: compositionCheck.issues } : {}),
          lastSyncedAt: priorBroadcastState.lastSyncedAt ? new Date(priorBroadcastState.lastSyncedAt).toISOString() : null,
          counts,
          changelogUrl: `${origin}/changelog.md`,
          nextAction: (compositionBehind || archiveMismatch)
            ? `Workspace composition or installed archives do not match the host release. Run ${cmdHint} (regenerates package-lock.json cleanly and verifies installed archives) and review ${origin}/changelog.md.`
            : `Run ${cmdHint} or read ${origin}/changelog.md before modifying or redeploying this workspace.`,
        };
      }
    } catch (cause) { error = { code: cause.code ?? 'agent_unavailable', status: cause.status ?? null, message: cause.message }; }
  }
  const running = await stat(join(workspace.paths.owner, 'endpoint.json')).then(() => true, () => false);
  return { workspace: workspace.root, service: workspace.config.service, agent: { ...workspace.config.agent, ...(agent ? { remote: agent } : {}) },
    versions,
    ...(compositionCheck.present ? {
      composition: {
        id: compositionCheck.compositionId,
        sourceCommit: compositionCheck.sourceCommit,
        runtimeId: compositionCheck.runtimeId,
        verified: compositionCheck.ok,
        ...(compositionCheck.ok ? {} : { issues: compositionCheck.issues }),
      },
    } : {}),
    ...(broadcasts ? { broadcasts } : {}),
    ...(catchup ? { catchup } : {}),
    pages: pages.map(page => ({ ...page, granted: granted ? granted.some(item => item.id === page.id) : null })),
    unregistered: granted ? granted.filter(item => !pages.some(page => page.id === item.id)) : null,
    agentProgram: { endpointRecorded: running }, ...(error ? { error } : {}) };
}


/** Attach to one page of the running `tendril agent run`; detaching never stops it. */
export { attachPage } from './agent.mjs';
