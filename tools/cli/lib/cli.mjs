import { once } from 'node:events';
import { parseArgs, intFlag } from './args.mjs';
import { jsonInput, runSessionCommand, watchPages, watchSession, watchSignals, withSession } from './session.mjs';
import { onboardingGuide, publicServiceOrigin, serverBase } from './guide.mjs';
import { diagnosticFinding } from '@tendriller/core/diagnostics';
import { describeReadiness, describeService } from '@tendriller/core';
import { probeCapabilities } from '@tendriller/core/probe';
import { serveStdioMcp } from './mcp-stdio.mjs';
import { exportSourceHandoff } from './handoff.mjs';
import { exportWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from './checkpoint.mjs';
import { adoptWorkspace, describeWorkspace, findWorkspace, initWorkspace, joinWorkspace, openWorkspace, workspaceKey } from './workspace.mjs';
import { attachPage, runAgent } from './agent.mjs';

export const usage = `Usage: tendril <command> [options]

Start with a service origin (no workspace required):
  guide [--server URL]                  Print the application-building workflow; no network access
  probe [--server URL] [--check-network] [--project DIR]  Inspect local runtime, storage, IPC and network capabilities
  service --server URL                  Read the public host contract and limits
  readiness --server URL                Check current creation availability before setup
  handoff source <out.tgz> [--project DIR]  Pack non-secret source files for another sandbox

Workspace (one agent credential and signing key for many pages):
  workspace init --service URL --owner VERIFIED_EMAIL [--name AGENT]   Register a new agent in this empty folder
  workspace join --service URL --code CODE [--name AGENT]              Join an account with a dashboard code
  workspace key --service URL [--name AGENT]                           Print register_agent arguments (account-linked MCP)
  workspace adopt --service URL --credential FILE                      Retain the saved register_agent result
  page new <slug> [--name TITLE]        Create a page (granted to this agent) and its pages/<slug>/ folder
  page grant <slug> <page-id>           Register a page the owner granted to this agent
  page list                             Granted and registered pages
  status                                Workspace, agent, grants and the agent program
  agent run                             The only long-running program: hub, one session per page, attach socket
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
  readiness: ['server'], service: ['server'],
  workspace: ['service', 'owner', 'name', 'code', 'kit', 'credential'], page: ['name'], agent: [], 'mcp-stdio': [],
  info: ['show-url'], meta: [], release: [], link: [], notify: ['title', 'body', 'path', 'tag', 'badge'],
  activity: ['after'], remove: ['yes'],
};
const arity = { self: [0, 0], endpoints: [0, 0], doctor: [0, 0], describe: [0, 0], status: [0, 0], query: [1, 2], command: [2, 2],
  'command-batch': [1, 1], operation: [1, 1], retry: [1, 1],
  events: [0, 0], watch: [0, 0], logs: [0, 0], signal: [2, 2], finality: [1, 2], definition: [0, 0], publication: [0, 0],
  'publication-operation': [1, 1], publish: [1, 1], guide: [0, 0], probe: [0, 0], handoff: [2, 2], checkpoint: [2, 2],
  readiness: [0, 0], service: [0, 0], workspace: [1, 1], page: [1, 3], agent: [1, 1], 'mcp-stdio': [0, 0],
  info: [0, 0], meta: [1, 1], release: [0, 0], link: [1, 2], notify: [0, 0], activity: [0, 0], remove: [0, 0] };
const workspaceFree = new Set(['guide', 'probe', 'handoff', 'readiness', 'service']);
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
      return initWorkspace(root, { service: publicServiceOrigin(flags.service), owner: String(flags.owner ?? '').trim(), name: flags.name, kit: flags.kit, signal });
    }
    if (args[0] === 'join') {
      if (!flags.service) throw invalid('workspace join requires --service with the inviting service origin');
      return joinWorkspace(root, { service: publicServiceOrigin(flags.service), code: flags.code, name: flags.name, kit: flags.kit, signal });
    }
    if (args[0] === 'key' || args[0] === 'adopt') {
      if (!flags.service) throw invalid(`workspace ${args[0]} requires --service with the account-linked connector's service origin`);
      const service = publicServiceOrigin(flags.service);
      return args[0] === 'key' ? workspaceKey(root, { service, name: flags.name })
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
    throw invalid('Use page new <slug>, page grant <slug> <page-id> or page list');
  }
  if (command === 'agent') {
    if (args[0] !== 'run') throw invalid('Use agent run');
    await runAgent(workspace, { signal, report: value => { void emit(value).catch(() => {}); } });
    return undefined;
  }
  if (command === 'mcp-stdio') {
    const client = await workspace.client(), attached = new Map();
    const pages = {
      list: () => workspace.pages(),
      async open(ref, { signal: requestSignal } = {}) {
        const page = await workspace.page(ref);
        let entry = attached.get(page.id);
        if (!entry || entry.session.signal?.aborted) {
          entry = await attachPage(workspace, page.id, { signal });
          entry.notify = (payload, options) => client.page(page.id).request('/push', { method: 'POST', body: payload, ...options });
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

/** Parse, validate and run one invocation. `attach` replaces the agent attachment in tests only. */
export async function main(argv, { attach } = {}) {
  const { cmd, args, flags } = parseArgs(argv);
  if (flags.help || cmd === 'help' || cmd === undefined) { console.log(usage); return; }
  if (!Object.hasOwn(flagsByCommand, cmd)) throw invalid(`Unknown command: ${cmd}`);
  const pageScoped = sessionCommands.has(cmd) || hostCommands.has(cmd) || cmd === 'status' && flags.page !== undefined;
  const session = sessionCommands.has(cmd) || cmd === 'status' && flags.page !== undefined;
  const allowed = new Set(['pretty', 'timeout', ...(workspaceFree.has(cmd) ? [] : ['workspace']),
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
    if (!process.stdout.write(JSON.stringify(value, null, flags.pretty ? 2 : undefined) + '\n')) await once(process.stdout, 'drain', { signal: lifetime.signal });
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
        console.error(JSON.stringify({ watch: completedResult }));
      } else await withSession(openPage(flags.page), async owned => {
        if (cmd === 'watch') completedResult = await watchSession(owned, emit, { ...watchOptions, signal: lifetime.signal });
        else if (cmd === 'logs') completedResult = await watchSignals(owned, emit, {
          ...(flags.topics === undefined ? {} : { topics: jsonInput(flags.topics, 'topic array JSON') }),
          mode: flags.latest ? 'latest' : 'all', signal: lifetime.signal,
        });
        else completedResult = await runSessionCommand(owned, cmd === 'status' ? 'status' : cmd, args, flags, { signal: lifetime.signal });
      }, { signal: lifetime.signal });
      if (cmd === 'watch' && !combined) console.error(JSON.stringify({ watch: completedResult }));
      else if (cmd === 'logs') console.error(JSON.stringify({ logs: completedResult }));
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
    console.error(JSON.stringify({ error: { code: error.code ?? 'command_failed', message: error.message },
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
