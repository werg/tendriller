import { once } from 'node:events';
import { parseArgs, intFlag } from './args.mjs';
import { jsonInput, runSessionCommand, watchPages, watchSession, watchSignals, withSession } from './session.mjs';
import { onboardingGuide, publicServiceOrigin, serverBase } from './guide.mjs';
import { diagnosticFinding } from '@tendriller/core/diagnostics';
import { describeReadiness, describeService, fetchBroadcasts } from '@tendriller/core';
import { probeCapabilities } from '@tendriller/core/probe';
import { serveStdioMcp } from './mcp-stdio.mjs';
import { exportSourceHandoff } from './handoff.mjs';
import { exportWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from './checkpoint.mjs';
import { acknowledgeWorkspaceBroadcast, adoptWorkspace, describeWorkspace, findWorkspace, initWorkspace, joinWorkspace, openWorkspace, syncWorkspaceBroadcasts, updateWorkspaceProfile, workspaceKey } from './workspace.mjs';
import { attachPage, runAgent } from './agent.mjs';
import { connectProvider, listConnections, listProviders, pullAgentConnections, revokeConnection } from './connections.mjs';

export const usage = `Usage: tendril <command> [options]

Start with a service origin (no workspace required):
  guide [--server URL]                  Print the application-building workflow; no network access
  probe [--server URL] [--check-network] [--project DIR]  Inspect local runtime, storage, IPC and network capabilities
  service --server URL                  Read the public host contract and limits
  readiness --server URL                Check current creation availability before setup
  broadcasts [--server URL] [--audience A] [--all] [--ack ID]  Read & verify signed system broadcasts (dependency upgrades, security advisories)
  handoff source <out.tgz> [--project DIR]  Pack non-secret source files for another sandbox

Workspace (one agent credential and signing key for many pages):
  workspace init --service URL --owner VERIFIED_EMAIL --handle HANDLE [--bio BIO]  Register a new agent in this empty folder
  workspace join --service URL --code CODE --handle HANDLE [--bio BIO]             Join an account with a dashboard code
  workspace key --service URL --handle HANDLE [--bio BIO]                          Print register_agent arguments (account-linked MCP)
  workspace adopt --service URL --credential FILE                                  Retain the saved register_agent result
  page new <slug> [--name TITLE]        Create a page (granted to this agent) and its pages/<slug>/ folder
  page grant <slug> <page-id>           Register a page the owner granted to this agent
  page list                             Granted and registered pages
  page devices <slug>                   Admitted devices/agents, pending sign-ins, invites and admission mode
  page approve <slug> <public-key> [--writer] [--admin]   Admit a pending device (strict mode, guests)
  page remove-device <slug> <public-key>  Remove a device or agent and rotate the page key
  page mode <slug> attested|strict      Auto-admit owner devices, or require approval
  page owner-grant <slug> admin|writer|reader   Rights owner-account devices get on admission (default admin)
  page invite <slug> --email ADDRESS | --open | --public [--max N] [--expires DAYS] [--role reader|writer|admin]
  page revoke-invite <slug> <invite-id> Stop an invite (signed in page state; the host stops redemptions)
  page group <slug> [--add GROUP --role reader|writer|admin] [--remove RULE_ID]  Manage org/team admission rules
  status                                Workspace, agent, grants and the agent program
  agent run                             The only long-running program: hub, one session per page, attach socket
  agent profile [--handle H] [--bio B]  Update this agent's @handle or short bio
  connection providers [--server URL]   List built-in and custom outbound OAuth 2.1 providers
  connection connect <provider> --tier agent-held|host-brokered [--custody personal|page] [--scopes S] [--actions A] [--page SLUG]
  connection list | pull | revoke <id>  Manage external OAuth connections (pull unseals Tier A tokens locally)
  mcp-stdio                             Local MCP server for every page; each tool takes page
  checkpoint export <file> [--secret-env VAR]   Move this stopped workspace's private state (agent key,
                                        credential, every page device and record) into one encrypted file;
                                        this copy is retired once the file is durable
  checkpoint restore <file> [--secret-env VAR]  Recreate that private state in an empty folder (this one or
                                        --workspace DIR); page source moves with handoff source

Page host (--page <slug|id>; optional when the workspace has one page):
  info [--show-url] | meta <json> | release | link list | create <json> | rotate <id> | remove <id>
  notify --title TEXT [--body TEXT] [--path REL] [--tag TAG] [--badge N]
  activity [--after N] | remove --yes

Page application session (attaches to tendril agent run; --page <slug|id>):
  self | endpoints | doctor | describe | status --page P | query <name> [json]
  command <name> <json> --operation ID [--author-time MS] [--wait materialized|retained|finalized]
  command-batch <json-array> [--wait materialized|retained|finalized]
  operation <id> | retry <id> [--wait materialized|retained|finalized]
  events [--cursor CURSOR] [--topics JSON] [--limit N]
  watch [--events [--cursor CURSOR] [--topics JSON] [--limit N]]   Without --page: every running page, cursors per page
  logs [--topics JSON] [--latest]
  signal <topic> <json> [--ttl MILLISECONDS]
  finality close|vote --through MS | finality submit <canonical-proof-record>
  definition | publication | publication-operation <id>
  publish <directory> [--operation ID] [--entry index.html]

--workspace DIR (or TENDRIL_WORKSPACE) selects the workspace; otherwise the nearest
tendriller.json above the current folder. --timeout SECONDS bounds an invocation
(default 30; watch, logs, mcp-stdio and agent run wait until interrupted).
--pretty formats JSON. Session commands attach to the page owner inside tendril
agent run; detaching never stops it, and attach failure never opens a second signer.
Chronolog owns signing, exact retry and durable identity. Finality is optional;
a timed out waiter preserves its original stored proposal and author timestamp.`;

const sessionCommands = new Set(['self', 'endpoints', 'doctor', 'describe', 'query', 'command', 'command-batch', 'operation', 'retry',
  'events', 'watch', 'logs', 'signal', 'finality', 'definition', 'publication', 'publication-operation', 'publish']);
const hostCommands = new Set(['info', 'meta', 'release', 'link', 'notify', 'activity', 'remove']);
const flagsByCommand = {
  self: [], endpoints: [], doctor: [], describe: [], status: [], query: [], command: ['operation', 'author-time', 'wait'],
  'command-batch': ['wait'], operation: [],
  retry: ['wait'], events: ['cursor', 'topics', 'limit'], watch: ['events', 'cursor', 'topics', 'limit'],
  logs: ['topics', 'latest'],
  signal: ['ttl'], finality: ['through'], definition: [], publication: [], 'publication-operation': [], publish: ['operation', 'entry'],
  guide: ['server'], probe: ['server', 'check-network', 'project'],
  handoff: ['project'], checkpoint: ['secret-env'],
  readiness: ['server'], service: ['server'], broadcasts: ['server', 'audience', 'all', 'ack'],
  workspace: ['service', 'owner', 'handle', 'bio', 'code', 'kit', 'credential'], page: ['name', 'writer', 'admin', 'email', 'open', 'public', 'max', 'expires', 'role', 'add', 'remove', 'label'], agent: ['handle', 'bio'], connection: ['server', 'tier', 'custody', 'scopes', 'actions', 'page', 'label'], 'mcp-stdio': [],
  info: ['show-url'], meta: [], release: [], link: [], notify: ['title', 'body', 'path', 'tag', 'badge'],
  activity: ['after'], remove: ['yes'],
};
const arity = { self: [0, 0], endpoints: [0, 0], doctor: [0, 0], describe: [0, 0], status: [0, 0], query: [1, 2], command: [2, 2],
  'command-batch': [1, 1], operation: [1, 1], retry: [1, 1],
  events: [0, 0], watch: [0, 0], logs: [0, 0], signal: [2, 2], finality: [1, 2], definition: [0, 0], publication: [0, 0],
  'publication-operation': [1, 1], publish: [1, 1], guide: [0, 0], probe: [0, 0], handoff: [2, 2], checkpoint: [2, 2],
  readiness: [0, 0], service: [0, 0], broadcasts: [0, 0], workspace: [1, 1], page: [1, 3], agent: [1, 1], connection: [1, 2], 'mcp-stdio': [0, 0],
  info: [0, 0], meta: [1, 1], release: [0, 0], link: [1, 2], notify: [0, 0], activity: [0, 0], remove: [0, 0] };
const workspaceFree = new Set(['guide', 'probe', 'handoff', 'readiness', 'service', 'broadcasts']);
const invalid = message => Object.assign(Error(message), { exit: 64 });
const checkedName = value => { if (!value) throw invalid('Supply an identity'); return encodeURIComponent(value); };

async function publicCommand(command, args, flags, signal) {
  if (command === 'guide') return onboardingGuide(flags);
  if (command === 'probe') {
    const server = flags.server || process.env.TENDRIL_SERVER;
    return probeCapabilities({ projectPath: flags.project ?? process.cwd(),
      ...(server ? { serviceOrigin: publicServiceOrigin(server) } : {}), checkNetwork: Boolean(flags['check-network']), signal });
  }
  if (command === 'handoff') {
    if (args[0] !== 'source') throw invalid('Use: tendril handoff source <output.tgz> [--project DIR]');
    return exportSourceHandoff(flags.project ?? process.cwd(), args[1]);
  }
  if (command === 'broadcasts') {
    const wsRoot = flags.workspace ?? (process.env.TENDRIL_WORKSPACE || (!flags.server ? findWorkspace() : null));
    if (wsRoot && !flags.server) {
      const workspace = await openWorkspace({ root: wsRoot });
      if (typeof flags.ack === 'string') return acknowledgeWorkspaceBroadcast(workspace, flags.ack.trim());
      return syncWorkspaceBroadcasts(workspace, { signal, all: Boolean(flags.all) });
    }
    if (!flags.server && !process.env.TENDRIL_SERVER) throw invalid('broadcasts requires a workspace or --server / TENDRIL_SERVER');
    const server = publicServiceOrigin(serverBase(process.env, flags));
    return fetchBroadcasts(server, {
      ...(typeof flags.audience === 'string' ? { audience: flags.audience } : {}),
      verifyKeys: 'discover',
      signal,
    });
  }
  if (!flags.server && !process.env.TENDRIL_SERVER) throw invalid(`${command} requires --server or TENDRIL_SERVER with the selected connector service origin`);
  const server = publicServiceOrigin(serverBase(process.env, flags));
  if (command === 'readiness') return describeReadiness(server, { signal });
  return describeService(server, { signal });
}

async function workspaceCommand(command, args, flags, signal, emit, { workspaceDir }) {
  if (command === 'checkpoint') {
    const secretVar = flags['secret-env'] ?? 'TENDRILLER_CHECKPOINT_SECRET', secret = process.env[secretVar];
    if (!secret) throw invalid(`Set environment variable ${secretVar} (64-hex key or >=12-char passphrase).`);
    if (args[0] === 'export') return exportWorkspaceCheckpoint({ root: workspaceDir ?? findWorkspace(), outputPath: args[1], secret });
    if (args[0] === 'restore') return restoreWorkspaceCheckpoint({ root: workspaceDir ?? process.cwd(), inputPath: args[1], secret });
    throw invalid('Use: tendril checkpoint export|restore <file> [--secret-env VAR]');
  }
  if (command === 'workspace') {
    const root = workspaceDir ?? process.cwd();
    if (args[0] === 'init') {
      if (!flags.service) throw invalid('workspace init requires --service with the selected connector service origin; creation never defaults to production');
      return initWorkspace(root, { service: publicServiceOrigin(flags.service), owner: String(flags.owner ?? '').trim(), handle: flags.handle, bio: flags.bio, kit: flags.kit, signal });
    }
    if (args[0] === 'join') {
      if (!flags.service) throw invalid('workspace join requires --service with the inviting service origin');
      return joinWorkspace(root, { service: publicServiceOrigin(flags.service), code: flags.code, handle: flags.handle, bio: flags.bio, kit: flags.kit, signal });
    }
    if (args[0] === 'key' || args[0] === 'adopt') {
      if (!flags.service) throw invalid(`workspace ${args[0]} requires --service with the account-linked connector's service origin`);
      const service = publicServiceOrigin(flags.service);
      return args[0] === 'key' ? workspaceKey(root, { service, handle: flags.handle, bio: flags.bio })
        : adoptWorkspace(root, { service, credential: flags.credential, kit: flags.kit, signal });
    }
    throw invalid('Use workspace init, join, key or adopt');
  }
  const workspace = await openWorkspace({ root: workspaceDir ?? findWorkspace() });
  if (command === 'status') return describeWorkspace(workspace, { signal });
  if (command === 'page') {
    const [action, slug, id] = args;
    if (action === 'list' && args.length === 1) return describeWorkspace(workspace, { signal });
    if (action === 'new' && args.length === 2) {
      const page = await workspace.createPage(slug, { name: flags.name ?? slug }, { signal });
      return { slug, id: page.id, name: page.name, page_url: page.page_url, application: page.application, source: page.source,
        next: `Write the page source in pages/${slug}/ (agent.mjs exports openPage), initialize it, publish, then give the owner page_url.` };
    }
    if (action === 'grant' && args.length === 3) {
      const client = await workspace.client();
      let granted;
      for await (const page of client.pages.all({ signal })) if (page.id === id) { granted = page; break; }
      if (!granted) throw Object.assign(Error(`Page ${id} is not granted to this agent. The owner grants it from the dashboard (Agents).`), { code: 'page_not_granted' });
      const page = await workspace.registerPage(slug, granted);
      return { slug, id: page.id, name: page.name, source: page.source };
    }
    if (['devices', 'approve', 'remove-device', 'mode', 'owner-grant', 'invite', 'revoke-invite', 'group'].includes(action)) return pageAdmission(workspace, action, slug, id, flags, signal);
    throw invalid('Use page new|grant|list|devices|approve|remove-device|mode|owner-grant|invite|revoke-invite|group; see --help');
  }
  if (command === 'agent') {
    if (args[0] === 'profile') {
      return updateWorkspaceProfile(workspace, { handle: flags.handle, bio: flags.bio }, { signal });
    }
    if (args[0] !== 'run') throw invalid('Use agent run or agent profile');
    await runAgent(workspace, { signal, report: value => { void emit(value).catch(() => {}); } });
    return undefined;
  }
  if (command === 'connection') {
    const [sub, target] = args;
    if (sub === 'providers') {
      const origin = flags.server ? publicServiceOrigin(flags.server) : (await workspace.credential()).service;
      return listProviders(origin, signal);
    }
    if (sub === 'connect') {
      if (!target) throw invalid('Use: tendril connection connect <provider> --tier agent-held|host-brokered');
      return connectProvider(workspace, target, flags, signal);
    }
    if (sub === 'list') return listConnections(workspace, signal);
    if (sub === 'pull') return pullAgentConnections(workspace, signal);
    if (sub === 'revoke') {
      if (!target) throw invalid('Use: tendril connection revoke <connection-id>');
      return revokeConnection(workspace, target, signal);
    }
    throw invalid('Use connection providers|connect|list|pull|revoke');
  }
  if (command === 'mcp-stdio') {
    const client = await workspace.client(), attached = new Map();
    const fetchRoster = async (pageId, requestSignal) => {
      try {
        const info = await client.page(pageId).request('', { signal: requestSignal });
        return {
          self: workspace.config.agent,
          primary_agent_id: info?.primary_agent_id ?? null,
          is_primary: Boolean(info?.is_primary),
          agents: Array.isArray(info?.agents) ? info.agents : [],
        };
      } catch {
        return { self: workspace.config.agent, primary_agent_id: null, is_primary: false, agents: [] };
      }
    };
    const pages = {
      self: () => workspace.config.agent,
      broadcasts: async ({ acknowledgeId, signal: requestSignal } = {}) => {
        if (acknowledgeId) return acknowledgeWorkspaceBroadcast(workspace, acknowledgeId);
        return syncWorkspaceBroadcasts(workspace, { signal: requestSignal ?? signal });
      },
      list: async () => {
        const local = await workspace.pages();
        const remoteById = new Map();
        try {
          for await (const p of client.pages.all({ signal })) remoteById.set(p.id, p);
        } catch { /* offline: return local page list */ }
        return local.map(p => {
          const r = remoteById.get(p.id);
          const primary = r?.agents?.find(a => a.id === r.primary_agent_id || a.is_primary);
          return {
            ...p,
            ...(r ? {
              primary_agent_id: r.primary_agent_id ?? null,
              primaryHandle: primary?.handle ?? null,
              isPrimary: Boolean(r.is_primary),
              agents: r.agents ?? [],
            } : {}),
          };
        });
      },
      async open(ref, { signal: requestSignal } = {}) {
        const page = await workspace.page(ref);
        let entry = attached.get(page.id);
        if (!entry || entry.session.signal?.aborted) {
          entry = await attachPage(workspace, page.id, { signal });
          entry.notify = (payload, options) => client.page(page.id).request('/push', { method: 'POST', body: payload, ...options });
          entry.roster = opts => fetchRoster(page.id, opts?.signal ?? requestSignal);
          attached.set(page.id, entry);
        }
        requestSignal?.throwIfAborted();
        return entry;
      },
    };
    try { await serveStdioMcp(pages, { signal }); }
    finally { await Promise.allSettled([...attached.values()].map(entry => entry.detach())); }
    return undefined;
  }
  const page = await workspace.page(flags.page);
  const host = (await workspace.client()).page(page.id, { applicationId: page.application.id });
  const options = { signal };
  if (command === 'info') {
    const result = await host.request('', options);
    return { ...result, ...(result.page_url && !flags['show-url'] ? { page_url: '[REDACTED; use --show-url privately]' } : {}) };
  }
  if (command === 'meta') return host.request('', { method: 'PATCH', body: jsonInput(args[0]), ...options });
  if (command === 'notify') {
    const title = typeof flags.title === 'string' ? flags.title.trim() : '';
    if (!title) throw invalid('notify requires --title TEXT');
    return host.request('/push', { method: 'POST', ...options, body: { title,
      ...(typeof flags.body === 'string' ? { body: flags.body } : {}), ...(typeof flags.path === 'string' ? { path: flags.path } : {}),
      ...(typeof flags.tag === 'string' ? { tag: flags.tag } : {}), ...(flags.badge !== undefined ? { badge: intFlag(flags.badge, 'badge') } : {}) } });
  }
  if (command === 'release') return host.request('/release', { method: 'POST', body: {}, ...options });
  if (command === 'activity') return host.request(`/activity${flags.after === undefined ? '' : `?after=${checkedName(flags.after)}`}`, options);
  if (command === 'remove') {
    if (!flags.yes) throw invalid('remove deletes hosted control and publication state; supply --yes');
    await host.request('', { method: 'DELETE', ...options });
    await workspace.unregisterPage(page.slug);
    return { deleted: page.id, slug: page.slug, retained: page.directory };
  }
  const [action, input] = args;
  if (action === 'list' && args.length === 1) return host.request('/links', options);
  if (action === 'create' && args.length === 2) return host.request('/links', { method: 'POST', body: jsonInput(input), ...options });
  if (action === 'remove' && args.length === 2) { await host.request(`/links/${checkedName(input)}`, { method: 'DELETE', ...options }); return { removed: input }; }
  if (action === 'rotate' && args.length === 2) return host.request(`/links/${checkedName(input)}/rotate`, { method: 'POST', body: {}, ...options });
  throw invalid('Unknown link action; see --help');
}

const KEY_RE = /^[0-9a-f]{64}$/u;
/** Page admission actions run inside the page owner of the running agent program (its signer, never the host's). */
async function pageAdmission(workspace, action, slug, value, flags, signal) {
  if (!slug) throw invalid(`page ${action} requires a page slug`);
  const call = async (name, ...input) => {
    const owned = await attachPage(workspace, slug, { signal });
    try { return await owned.session.extensions.call(name, input); } finally { await owned.detach(); }
  };
  if (action === 'devices') {
    const state = await call('admission.state');
    return { page: slug, phase: state.phase, mode: state.mode, ownerGrant: state.ownerGrant, administrator: state.administrator, members: state.members, pending: state.pending, invites: state.invites };
  }
  if (action === 'approve' || action === 'remove-device') {
    if (!KEY_RE.test(value ?? '')) throw invalid(`page ${action} requires the device's 64-hex public key (see page devices)`);
    return action === 'approve' ? call('admission.approve', value, { ...(flags.writer ? { writer: true } : {}), ...(flags.admin ? { writer: true, administrator: true } : {}) })
      : call('admission.remove', value);
  }
  if (action === 'mode') { if (!['attested', 'strict'].includes(value)) throw invalid('page mode takes attested or strict'); return call('admission.mode', value); }
  if (action === 'owner-grant') { if (!['admin', 'writer', 'reader'].includes(value)) throw invalid('page owner-grant takes admin, writer or reader'); return call('admission.ownerGrant', value); }
  if (action === 'revoke-invite') { if (!/^[0-9a-f]{32}$/u.test(value ?? '')) throw invalid('page revoke-invite requires the invite id'); return call('admission.revokeInvite', value); }
  if (action === 'group') {
    const page = await workspace.page(slug);
    const current = await call('admission.groups');
    const existingRules = Array.isArray(current?.policy?.payload?.rules) ? [...current.policy.payload.rules] : [];
    if (!flags.add && !flags.remove) return { page: slug, rules: existingRules, departures: current?.departures ?? [] };
    let nextRules = existingRules;
    if (flags.remove) {
      nextRules = nextRules.filter(r => r.ruleId !== flags.remove && r.group !== flags.remove);
    }
    if (flags.add) {
      const group = String(flags.add).trim().toLowerCase();
      const role = flags.role ?? 'writer';
      if (!['reader', 'writer', 'admin'].includes(role)) throw invalid('--role must be reader, writer, or admin');
      const ruleId = `r_${group.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48)}`;
      nextRules = [...nextRules.filter(r => r.group !== group), { ruleId, group, role, ...(flags.label ? { label: String(flags.label).slice(0, 80) } : {}) }];
    }
    return call('admission.setGroupPolicy', page.id, nextRules);
  }
  const kinds = ['email', 'open', 'public'].filter(name => flags[name] !== undefined && flags[name] !== false);
  if (kinds.length !== 1 || value !== undefined) throw invalid('page invite takes exactly one of --email ADDRESS, --open or --public');
  if (kinds[0] === 'email' && typeof flags.email !== 'string') throw invalid('--email requires the invitee address');
  const binding = kinds[0] === 'email' ? { kind: 'email', email: flags.email } : kinds[0] === 'open' ? { kind: 'open' } : { kind: 'public', max: flags.max === undefined ? null : intFlag(flags.max, 'max') };
  const days = flags.expires === undefined ? 7 : intFlag(flags.expires, 'expires');
  const created = await call('admission.invite', { binding, ...(flags.role ? { role: flags.role } : {}), expiresInMs: days * 86_400_000 });
  const page = await workspace.page(slug), link = new URL(page.page_url); link.hash = created.fragment;
  return { inviteId: created.inviteId, role: created.role, binding: created.binding, expiresAt: String(created.expiresAt), link: link.href,
    note: 'The link fragment carries the invite secret; share it only with the invitee. Revoke with page revoke-invite.' };
}

/** JSON output for every command. Chronolog author times and admission records carry BigInt values,
 * which JSON cannot represent; emit them as decimal strings, as the wire contracts do. */
export function jsonText(value, pretty) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, pretty ? 2 : undefined);
}

/** Parse, validate and run one invocation. `attach` replaces the agent attachment in tests only. */
export async function main(argv, { attach } = {}) {
  const { cmd, args, flags } = parseArgs(argv);
  if (flags.help || cmd === 'help' || cmd === undefined) { console.log(usage); return; }
  if (!Object.hasOwn(flagsByCommand, cmd)) throw invalid(`Unknown command: ${cmd}`);
  const pageScoped = sessionCommands.has(cmd) || hostCommands.has(cmd) || cmd === 'status' && flags.page !== undefined;
  const session = sessionCommands.has(cmd) || cmd === 'status' && flags.page !== undefined;
  const allowed = new Set(['pretty', 'timeout', ...(workspaceFree.has(cmd) && cmd !== 'broadcasts' ? [] : ['workspace']),
    ...(pageScoped || cmd === 'status' ? ['page'] : []), ...flagsByCommand[cmd]]);
  for (const name of Object.keys(flags)) if (!allowed.has(name)) throw invalid(`${cmd} does not accept --${name}`);
  const [min, max] = arity[cmd];
  if (args.length < min || args.length > max) throw invalid(`Invalid arguments for ${cmd}; see --help`);
  if (cmd === 'watch' && !flags.events && ['cursor', 'topics', 'limit'].some(name => flags[name] !== undefined))
    throw invalid('watch --cursor, --topics and --limit require --events');
  const combined = cmd === 'watch' && flags.page === undefined;
  const watchOptions = cmd === 'watch' ? { events: Boolean(flags.events),
    ...(flags.cursor === undefined ? {} : { cursor: combined ? jsonInput(flags.cursor, 'per-page cursor JSON object') : flags.cursor }),
    ...(flags.topics === undefined ? {} : { topics: jsonInput(flags.topics, 'topic array JSON') }),
    ...(flags.limit === undefined ? {} : { limit: intFlag(flags.limit, 'limit') }) } : undefined;
  if (combined && watchOptions.cursor !== undefined && (!watchOptions.cursor || typeof watchOptions.cursor !== 'object' || Array.isArray(watchOptions.cursor)))
    throw invalid('watch without --page takes --cursor as a JSON object of page id to cursor');
  if (watchOptions?.topics !== undefined && (!Array.isArray(watchOptions.topics) || watchOptions.topics.length > 128 ||
      watchOptions.topics.some(topic => typeof topic !== 'string' || topic.length > 128))) throw invalid('Use --topics with an array of at most 128 bounded topic names');
  if (watchOptions?.limit !== undefined && (watchOptions.limit < 1 || watchOptions.limit > 1024)) throw invalid('--limit must be between 1 and 1024');
  const unbounded = ['watch', 'logs', 'mcp-stdio', 'agent'].includes(cmd);
  const seconds = intFlag(flags.timeout, 'timeout', unbounded ? 0 : 30);
  if (seconds < 0 || seconds > 3600) throw invalid('--timeout must be between 0 and 3600 seconds');
  const workspaceDir = flags.workspace ?? (process.env.TENDRIL_WORKSPACE || undefined);
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(Object.assign(Error('Invocation interrupted; inspect the original operation before retrying'), { code: 'invocation_interrupted' }));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const timer = seconds ? setTimeout(() => lifetime.abort(Object.assign(Error('Invocation timed out; inspect or retry the original operation'), { code: 'invocation_timeout' })), seconds * 1000) : undefined;
  const emit = async value => {
    if (!process.stdout.write(jsonText(value, flags.pretty) + '\n')) await once(process.stdout, 'drain', { signal: lifetime.signal });
  };
  const openPage = ref => attach ? options => attach({ page: ref, ...options })
    : async options => { const workspace = await openWorkspace({ root: workspaceDir ?? findWorkspace() }); return { ...await attachPage(workspace, ref, options), page: ref ?? null }; };
  let completedResult;
  try {
    if (session) {
      if (combined) {
        const workspace = attach ? null : await openWorkspace({ root: workspaceDir ?? findWorkspace() });
        const refs = attach ? [undefined] : (await workspace.pages()).filter(page => page.initialized).map(page => page.id);
        if (!refs.length) throw Object.assign(Error('No initialized pages to watch. Initialize a page and keep tendril agent run running.'), { code: 'OWNER_UNREACHABLE' });
        completedResult = await watchPages(refs.map(ref => ({ page: ref ?? null, open: openPage(ref) })), emit, { ...watchOptions, signal: lifetime.signal });
        console.error(jsonText({ watch: completedResult }));
      } else await withSession(openPage(flags.page), async owned => {
        if (cmd === 'watch') completedResult = await watchSession(owned, emit, { ...watchOptions, signal: lifetime.signal });
        else if (cmd === 'logs') completedResult = await watchSignals(owned, emit, {
          ...(flags.topics === undefined ? {} : { topics: jsonInput(flags.topics, 'topic array JSON') }),
          mode: flags.latest ? 'latest' : 'all', signal: lifetime.signal,
        });
        else completedResult = await runSessionCommand(owned, cmd === 'status' ? 'status' : cmd, args, flags, { signal: lifetime.signal });
      }, { signal: lifetime.signal });
      if (cmd === 'watch' && !combined) console.error(jsonText({ watch: completedResult }));
      else if (cmd === 'logs') console.error(jsonText({ logs: completedResult }));
      else if (cmd !== 'watch') await emit(completedResult);
    } else if (workspaceFree.has(cmd)) await emit(await publicCommand(cmd, args, flags, lifetime.signal));
    else {
      const result = await workspaceCommand(cmd, args, flags, lifetime.signal, emit, { workspaceDir });
      if (result !== undefined) await emit(result);
    }
  } catch (error) {
    if (cmd === 'watch') {
      if (!(error instanceof Error) || !Object.isExtensible(error)) error = new Error('Session watch failed', { cause: error });
      error.watch ??= completedResult ?? { mode: watchOptions.events ? 'events' : 'changes', cursor: watchOptions.cursor ?? null, revision: null };
    }
    if (cmd === 'publish' && completedResult?.publication?.id && Number.isSafeInteger(completedResult.version)) {
      error.publication = { operationId: flags.operation, publicationId: completedResult.publication.id,
        outcome: 'committed', phase: 'cleanup',
        receipt: { publicationId: completedResult.publication.id, version: completedResult.version },
        nextAction: 'Publication completed before this local failure. Preserve the same operation and device; inspect publication after reopening instead of creating a replacement release.' };
    }
    throw error;
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

// Only the executable owns process lifetime. Session libraries finish their
// cleanup before lingering transport handles are disposed; watch does not settle
// main() until its awaited change loop has stopped.
function flushOutput(stream) {
  if (stream.destroyed) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); stream.removeListener('error', finish); resolve(!error);
    };
    const timer = setTimeout(() => finish(Error('Output flush deadline')), 1000);
    stream.once('error', finish);
    // A queued callback follows all prior writes, including console.error's
    // asynchronous pipe writes. Do not end shared stdio or wait without a bound.
    try { stream.write('', finish); } catch (error) { finish(error); }
  });
}

export function runExecutable(argv = process.argv.slice(2), options = {}) {
  let outputFailed = false;
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => { outputFailed = true; });
  return main(argv, options).catch(error => {
    const exit = error?.exit;
    process.exitCode = Number.isInteger(exit) && exit >= 1 && exit <= 255 ? exit : 1;
    console.error(jsonText({ error: { code: error.code ?? 'command_failed', message: error.message },
      diagnostic: diagnosticFinding(error, { scope: error.scope ?? {} }),
      ...(Number.isInteger(error.status) ? { status: error.status } : {}), ...(error.operation ? { operation: error.operation } : {}),
      ...(error.publication ? { publication: error.publication } : {}),
      ...(error.checkpoint ? { checkpoint: error.checkpoint } : {}),
      ...(error.watch ? { watch: error.watch } : {}),
      ...(error.revision !== undefined ? { revision: error.revision } : {}),
      ...(error.cleanupError ? { cleanup: { code: error.cleanupError.code ?? 'cleanup_failed', message: error.cleanupError.message } } : {}) }));
  }).finally(async () => {
    const flushed = await Promise.all([process.stdout, process.stderr].map(flushOutput));
    if ((outputFailed || flushed.includes(false)) && !process.exitCode) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
  });
}
