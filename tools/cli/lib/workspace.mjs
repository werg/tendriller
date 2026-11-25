// An agent workspace: one account-level credential and signer, many pages.
//
//   tendriller.json          { schemaVersion, service, agent: { id, name }, kit, pages: { <slug>: { id } } }
//   pages/<slug>/            per-page source (agent.mjs, domain.mjs, page.mjs, ...)
//   .tendriller/agent/       identity.sqlite (shared signer), credential.json, attach.json, owner/ (attach socket)
//   .tendriller/pages/<id>/  page.json, device.sqlite, descriptor and setup records
//   .tendriller/checkpoint-retired.json  present once `tendril checkpoint export` moved this workspace away
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { assertValid } from '@tendriller/core/contract';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkspacePage } from './page-creation.mjs';
import { randomBytes } from 'node:crypto';
import { agentCredential, createAgentClient, describeReadiness, describeService, joinAgent, registerAgent, requireCreationReady, requireService, requireServiceOrigin } from '@tendriller/core';

export const WORKSPACE_FILE = 'tendriller.json';
export const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const PAGE_ID = /^[a-z2-7]{12}$/u;
const AGENT_TOKEN = /^ta_[a-z2-7]{32}$/u;
export const ATTACH_POLICY = Object.freeze({ capabilities: ['commands', 'queries', 'events', 'content', 'signals', 'operations', 'diagnostics', 'finality', 'publish'] });
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
    agent: join(secret, 'agent'), identity: join(secret, 'agent', 'identity.sqlite'),
    credential: join(secret, 'agent', 'credential.json'), attach: join(secret, 'agent', 'attach.json'),
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

/** One page device: its own native store, always signed by the shared agent key.
 * Every store is served by Chronolog's one pooled SQLite worker for this process. */
export async function openPageDevice({ path, signer, create = false }) {
  const { openNativeDevice } = await import('@chronolog/peer-session/native');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return openNativeDevice({ path, managedSigner: signer, ...(create ? { create: true } : {}) });
}

const agentName = value => {
  const name = String(value ?? `agent-${hostname()}`).replace(/[^A-Za-z0-9 ._-]+/gu, '-').replace(/^[^A-Za-z0-9]+/u, '').slice(0, 64);
  if (!name) throw failure('invalid_agent_name', 'Supply --name with letters, digits, space, dot, underscore or dash.', 64);
  return name;
};

async function requireEmptyWorkspace(root) {
  const entries = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const blocking = entries.filter(name => !['.git', '.gitignore', 'README.md', 'package.json', 'package-lock.json', 'node_modules', 'shared', 'templates', '.tendriller'].includes(name));
  if (entries.includes(WORKSPACE_FILE)) throw failure('workspace_exists', `${join(root, WORKSPACE_FILE)} already exists. Resume this workspace; do not register a second agent for it.`);
  if (blocking.includes('pages')) throw failure('workspace_not_empty', 'This folder already holds page sources without a workspace file. Restore tendriller.json instead of creating a new agent.');
}

async function enroll(root, { service, name, kit, signal }, request) {
  const origin = requireServiceOrigin(service), paths = workspacePaths(root);
  await requireEmptyWorkspace(root);
  const retained = await readJson(paths.credential, true);
  if (retained) {
    if (retained.service !== origin) throw failure('service_origin_mismatch', 'This workspace credential belongs to another service origin. Use a separate folder for that service.');
  } else {
    requireService(await describeService(origin, { signal }));
  }
  const signer = await openSharedSigner(paths.identity, { create: !existsSync(paths.identity) });
  let credential = retained;
  if (!credential) {
    const result = await request(origin, { name: agentName(name), publicKey: publicKeyBase64url(signer.publicKey) }, { signal });
    credential = await savePrivateJson(paths.credential, { schemaVersion: 1, service: origin,
      agent: { id: result.id, name: result.name }, token: result.token, publicKey: signer.publicKey,
      accountState: result.account_state ?? null });
  }
  if (credential.publicKey !== signer.publicKey) throw failure('agent_signer_mismatch', 'The retained signer does not match the registered agent key. Restore the original identity.sqlite.');
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
export async function initWorkspace(root, { service, owner, name, kit, signal } = {}) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(owner ?? '') || owner.length > 254) throw failure('invalid_owner', 'workspace init requires --owner VERIFIED_EMAIL', 64);
  const origin = requireServiceOrigin(service);
  if (!existsSync(workspacePaths(root).credential)) requireCreationReady(await describeReadiness(origin, { signal }), { service: origin });
  return enroll(root, { service: origin, name, kit, signal }, (origin, body, options) => registerAgent(origin, { owner, ...body }, options));
}
/** Join the inviting account with a one-time code from Dashboard -> Your agents -> Add agent. */
export async function joinWorkspace(root, { service, code, name, kit, signal } = {}) {
  if (typeof code !== 'string' || !code.trim()) throw failure('invalid_join_code', 'workspace join requires --code from the owner dashboard', 64);
  return enroll(root, { service, name, kit, signal }, (origin, body, options) => joinAgent(origin, { code: code.trim(), ...body }, options));
}

/**
 * The account-linked MCP route: create the shared key and print the public
 * register_agent arguments. Nothing is sent; the key is retained for adoptWorkspace.
 */
export async function workspaceKey(root, { service, name } = {}) {
  const origin = requireServiceOrigin(service), paths = workspacePaths(root);
  await requireEmptyWorkspace(root);
  if (existsSync(paths.credential)) throw failure('agent_credential_exists', `${paths.credential} already exists. Resume with tendril workspace adopt or restore tendriller.json.`);
  const signer = await openSharedSigner(paths.identity, { create: !existsSync(paths.identity) });
  return { service: origin, register_agent: { name: agentName(name), publicKey: publicKeyBase64url(signer.publicKey) },
    next: 'Call register_agent through the account-linked connector for this service with exactly these arguments, save its result privately, then run tendril workspace adopt --service ORIGIN --credential FILE.' };
}

/** Retain the agent credential an account-linked register_agent call returned for this workspace's key. */
export async function adoptWorkspace(root, { service, credential: file, kit, signal } = {}) {
  if (typeof file !== 'string' || !file) throw failure('invalid_credential_file', 'workspace adopt requires --credential FILE with the saved register_agent result', 64);
  const paths = workspacePaths(root);
  if (!existsSync(paths.identity)) throw failure('agent_signer_missing', 'Run tendril workspace key first; the registered public key must be this workspace key.', 64);
  const result = await readJson(resolve(root, file));
  const value = agentCredential(result?.structuredContent ?? result);
  if (!/^ag_[a-z2-7]{26}$/u.test(value?.id ?? '') || !AGENT_TOKEN.test(value?.token ?? '') || typeof value?.name !== 'string')
    throw failure('invalid_agent_credential', 'The file does not hold a register_agent result {id, name, token}.', 64);
  const origin = requireServiceOrigin(service);
  // The token is checked against this service before the workspace retains it.
  await createAgentClient({ service: origin, token: value.token }).self({ signal });
  return enroll(root, { service: origin, name: value.name, kit, signal }, async () => value);
}

export async function openWorkspace({ root = findWorkspace(), fetch: fetcher, WebSocket } = {}) {
  if (!root) throw failure('workspace_required', 'No tendriller.json found here or in a parent folder. Run tendril workspace init --service ORIGIN --owner EMAIL in an empty folder, or cd into the workspace.', 64);
  const paths = workspacePaths(root);
  if (existsSync(paths.retired)) throw failure('workspace_retired_by_checkpoint', `This workspace was moved to a checkpoint (${paths.retired}). Restore that checkpoint with tendril checkpoint restore in an empty folder and use that copy; this one never resumes.`);
  const config = await readJson(paths.config);
  if (config?.schemaVersion !== 1 || typeof config.service !== 'string' || !config.agent?.id)
    throw failure('workspace_state_invalid', `${paths.config} is not a Tendriller workspace file.`);
  let credential, client, signer;
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
    async createPage(slug, { name = slug, mode, application } = {}, { signal } = {}) {
      if (typeof slug !== 'string' || !SLUG.test(slug)) throw failure('invalid_slug', 'Use a page slug of lowercase letters, digits and dashes (max 48).', 64);
      assertValid('agentPageCreate', { name, ...(mode === undefined ? {} : { mode }), ...(application === undefined ? {} : { application }) });
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
      return createWorkspacePage({ workspace, client: await getClient(), store, slug, name, mode, application, signal });
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
        page_url: page.page_url, application: page.application, scopes: page.scopes ?? [], registered_at: new Date().toISOString() });
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
    async pageContext(ref, { signal, report = () => {} } = {}) {
      const page = await workspace.page(ref), agent = await getClient(), shared = await workspace.signer();
      const host = agent.page(page.id, { applicationId: page.application.id });
      const privatePath = name => {
        if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) throw failure('invalid_private_name', 'Private record names are plain file names.');
        return join(page.directory, name);
      };
      return Object.freeze({
        workspace: root, service: config.service, agent: config.agent,
        page: Object.freeze({ id: page.id, slug: page.slug, name: page.name, applicationId: page.application.id,
          pageUrl: page.page_url, directory: page.directory, source: page.source }),
        host, signal, report,
        // Opaque signing authority stays in the Node-only context; never serialize it
        // into configuration, authored files, diagnostics or a checkpoint record.
        signer: Object.freeze({ publicKey: shared.publicKey, privateKey: shared.privateKey }),
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

/** Bounded, non-secret status for terminals and the status command. */
export async function describeWorkspace(workspace, { signal, remote = true } = {}) {
  const pages = await workspace.pages();
  let agent = null, granted = null, error;
  if (remote) {
    try {
      const client = await workspace.client();
      agent = await client.self({ signal });
      granted = [];
      for await (const page of client.pages.all({ signal })) granted.push({ id: page.id, name: page.name, scopes: page.scopes ?? [] });
    } catch (cause) { error = { code: cause.code ?? 'agent_unavailable', status: cause.status ?? null, message: cause.message }; }
  }
  const running = await stat(join(workspace.paths.owner, 'endpoint.json')).then(() => true, () => false);
  return { workspace: workspace.root, service: workspace.config.service, agent: { ...workspace.config.agent, ...(agent ? { remote: agent } : {}) },
    pages: pages.map(page => ({ ...page, granted: granted ? granted.some(item => item.id === page.id) : null })),
    unregistered: granted ? granted.filter(item => !pages.some(page => page.id === item.id)) : null,
    agentProgram: { endpointRecorded: running }, ...(error ? { error } : {}) };
}


/** Attach to one page of the running `tendril agent run`; detaching never stops it. */
export { attachPage } from './agent.mjs';
