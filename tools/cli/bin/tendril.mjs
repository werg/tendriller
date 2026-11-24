#!/usr/bin/env node
import { once } from 'node:events';
import { parseArgs, intFlag } from '../lib/args.mjs';
import { resolveConfig, saveConfig, removeConfig, serverBase } from '../lib/config.mjs';
import { request, client } from '../lib/api.mjs';
import { jsonInput, runSessionCommand, watchSession, withSession } from '../lib/session.mjs';
import { onboardingGuide, publicServiceOrigin } from '../lib/guide.mjs';
import { diagnosticFinding } from '@tendriller/core/diagnostics';
import { describeReadiness, requireCreationReady, createPage } from '@tendriller/core';
import { probeCapabilities } from '@tendriller/core/probe';
import { checkService } from '../lib/service.mjs';
import { serveStdioMcp } from '../lib/mcp-stdio.mjs';
import { exportSourceHandoff, exportNativeCheckpoint, restoreNativeCheckpoint } from '../lib/handoff.mjs';

const usage = `Usage: tendril <command> [options]

Start with a service domain (no saved handle or session required):
  guide [--server URL]                  Print the application-building workflow; no network access
  probe [--server URL] [--check-network] [--project DIR]  Inspect local runtime, storage, IPC and network capabilities
  service [--server URL]                Read the public host contract and limits
  readiness --server URL               Check current creation availability before setup
  handoff source <out.tgz> [--project DIR]  Pack non-secret source files for another sandbox
  checkpoint export|restore <file> --device <path> [--secret-env VAR] [--project DIR]

Application session (--session /absolute/application.mjs):
  --mode attach | own | independent [--profile NAME] [--run RUN_ID]
  self | endpoints | doctor | describe | status | query <name> [json] | mcp-stdio
  command <name> <json> --operation ID [--based-on JSON] [--saved | --shared]
  command-batch <json-array> [--saved]
  operation <id> | retry <id> [--saved]
  reapply <old-id> <name> <json> --operation NEW_ID --based-on JSON
  events [--cursor CURSOR] [--topics JSON] [--limit N]
  watch [--events [--cursor CURSOR] [--topics JSON] [--limit N]]
  signal <topic> <json> [--ttl MILLISECONDS]
  recovery inspect | takeover --transition ID | handover <device> --transition ID
  definition | publication | publication-operation <id>
  publish <directory> --operation ID [--entry index.html]

Host lifecycle (--tendril NAME, or TENDRIL_API and TENDRIL_TOKEN):
  new [name] --owner VERIFIED_EMAIL --server URL [--as NAME]
  info [--show-url] | service --tendril NAME | meta <json> | release
  link list | create <json> | rotate <id> | remove <id>
  token list | create <name> [--scopes JSON] | rotate <name> | remove <name>
  activity [--after N] | remove --yes

--timeout SECONDS bounds an invocation (default 30; watch waits until interrupted).
watch --events emits retained batches with replay cursors. Owner loss exits nonzero;
a running watch's timeout or interrupt exits 0 with progress on stderr.
--pretty formats JSON. The session module may export attachSession({signal,profile,
context}) returning {session,detach}; it is the default when available. Otherwise
openSession({signal,mode,profile}) owns the retained profile and returns
{session,control?,close?}. Attach failure never opens a second signer. Independent
mode requires an explicitly provisioned --profile. Exiting an attachment only
detaches that client. control is session.connectControlParticipant(...).
Start with guide if you have a page handle but no application session. Page
creation and owner sign-in do not themselves configure or connect that session.
Chronolog owns signing, exact retry, durable identity and recovery. No host data
API or extra delivery queue is installed. A timed out waiter leaves its saved
operation available under the original identity.`;
const applicationCommands = new Set(['self', 'endpoints', 'doctor', 'describe', 'status', 'query', 'command', 'command-batch', 'operation', 'retry', 'reapply',
  'events', 'watch', 'signal', 'recovery', 'definition', 'publication', 'publication-operation', 'publish', 'mcp-stdio']);
const flagsByCommand = {
  self: [], endpoints: [], doctor: [], describe: [], status: [], query: [], command: ['operation', 'based-on', 'saved', 'shared'],
  'command-batch': ['saved'], 'mcp-stdio': [], operation: [],
  retry: ['saved'], reapply: ['operation', 'based-on', 'saved', 'shared'], events: ['cursor', 'topics', 'limit'], watch: ['events', 'cursor', 'topics', 'limit'],
  signal: ['ttl'], recovery: ['transition'], definition: [], publication: [], 'publication-operation': [], publish: ['operation', 'entry'],
  guide: ['server'], probe: ['server', 'check-network', 'project'],
  handoff: ['project'], checkpoint: ['device', 'secret-env', 'project'],
  readiness: ['server'], new: ['owner', 'server', 'as'], info: ['show-url'], service: ['server'], meta: [], release: [], link: [], token: ['scopes'],
  activity: ['after'], remove: ['yes'],
};
const arity = { self: [0, 0], endpoints: [0, 0], doctor: [0, 0], describe: [0, 0], status: [0, 0], query: [1, 2], command: [2, 2],
  'command-batch': [1, 1], 'mcp-stdio': [0, 0], operation: [1, 1], retry: [1, 1],
  reapply: [3, 3], events: [0, 0], watch: [0, 0], signal: [2, 2], recovery: [1, 2], definition: [0, 0], publication: [0, 0],
  'publication-operation': [1, 1], publish: [1, 1], guide: [0, 0], probe: [0, 0], handoff: [2, 2], checkpoint: [2, 2],
  readiness: [0, 0], new: [0, 1], info: [0, 0], service: [0, 0], meta: [1, 1], release: [0, 0],
  link: [1, 2], token: [1, 2], activity: [0, 0], remove: [0, 0] };
const invalid = message => Object.assign(Error(message), { exit: 64 });
const checkedName = value => { if (!value) throw invalid('Supply an identity'); return encodeURIComponent(value); };

async function hostCommand(command, args, flags, signal) {
  if (command === 'guide') return onboardingGuide(flags);
  if (command === 'probe') {
    const server = flags.server || process.env.TENDRIL_SERVER;
    return probeCapabilities({
      projectPath: flags.project ?? process.cwd(),
      ...(server ? { serviceOrigin: publicServiceOrigin(server) } : {}),
      checkNetwork: Boolean(flags['check-network']),
      signal,
    });
  }
  if (command === 'handoff') {
    if (args[0] !== 'source') throw invalid('Use: tendril handoff source <output.tgz> [--project DIR]');
    return exportSourceHandoff(flags.project ?? process.cwd(), args[1]);
  }
  if (command === 'checkpoint') {
    const secretVar = flags['secret-env'] ?? 'TENDRILLER_CHECKPOINT_SECRET';
    const secret = process.env[secretVar];
    if (!secret) throw invalid(`Set environment variable ${secretVar} (64-hex key or >=12-char passphrase).`);
    if (!flags.device) throw invalid('Supply --device <path/to/device.sqlite>');
    if (args[0] === 'export') {
      return exportNativeCheckpoint({ devicePath: flags.device, outputPath: args[1], secret, projectDir: flags.project ?? process.cwd() });
    }
    if (args[0] === 'restore') {
      return restoreNativeCheckpoint({ inputPath: args[1], devicePath: flags.device, secret, projectDir: flags.project ?? process.cwd() });
    }
    throw invalid('Use: tendril checkpoint export|restore <file> --device <path>');
  }
  if (command === 'readiness') {
    if (!flags.server && !process.env.TENDRIL_SERVER) throw invalid('readiness requires --server or TENDRIL_SERVER with the selected connector service origin');
    return describeReadiness(publicServiceOrigin(serverBase(process.env, flags)), { signal });
  }
  if (command === 'service' && (flags.server !== undefined ||
      !(flags.tendril || process.env.TENDRIL_NAME || process.env.TENDRIL_API && process.env.TENDRIL_TOKEN))) {
    const server = publicServiceOrigin(serverBase(process.env, flags));
    return request(`${server}/api/service`, { signal });
  }
  if (command === 'new') {
    const owner = String(flags.owner ?? process.env.TENDRIL_OWNER ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(owner) || owner.length > 254) throw invalid('new requires --owner VERIFIED_EMAIL');
    if (!flags.server && !process.env.TENDRIL_SERVER) throw invalid('new requires --server or TENDRIL_SERVER with the selected connector service origin; creation never defaults to production');
    const server = publicServiceOrigin(serverBase(process.env, flags));
    requireCreationReady(await describeReadiness(server, { signal }), { service: server });
    await checkService(server);
    const handle = await createPage(server, { ...(args[0] ? { name: args[0] } : {}), owner, lifetime: 'ad_hoc' },
      { fetch: (url, options) => fetch(url, { ...options, signal }) });
    const saved = saveConfig(handle, flags.as ?? args[0], process.env, server);
    return { ...handle, config: saved.name, config_file: saved.path };
  }
  const config = resolveConfig(flags), api = client(config), options = { signal };
  if (command === 'info') {
    const result = await api.get('', options);
    return { ...result, ...(result.page_url && !flags['show-url'] ? { page_url: '[REDACTED; use --show-url privately]' } : {}) };
  }
  if (command === 'service') return api.get('/service', options);
  if (command === 'meta') return api.patch('', jsonInput(args[0]), options);
  if (command === 'release') return api.post('/release', {}, options);
  if (command === 'activity') return api.get(`/activity${flags.after === undefined ? '' : `?after=${checkedName(flags.after)}`}`, options);
  if (command === 'remove') {
    if (!flags.yes) throw invalid('remove deletes hosted control and publication state; supply --yes');
    await api.del('', options); removeConfig(config); return { deleted: config.id };
  }
  const [action, input] = args;
  const path = command === 'link' ? '/links' : '/tokens';
  if (action === 'list' && args.length === 1) return api.get(path, options);
  if (action === 'create' && args.length === 2) return api.post(path, command === 'link' ? jsonInput(input) : { name: input,
    ...(flags.scopes === undefined ? {} : { scopes: jsonInput(flags.scopes, 'host scope array JSON') }) }, options);
  if (action === 'remove' && args.length === 2) { await api.del(`${path}/${checkedName(input)}`, options); return { removed: input }; }
  if (action === 'rotate' && args.length === 2) return api.post(`${path}/${checkedName(input)}/rotate`, {}, options);
  throw invalid(`Unknown ${command} action; see --help`);
}

async function main() {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === 'help' || cmd === undefined) { console.log(usage); return; }
  if (!Object.hasOwn(flagsByCommand, cmd)) throw invalid(`Unknown command: ${cmd}`);
  const application = applicationCommands.has(cmd);
  const allowed = new Set(['pretty', 'timeout', ...(['guide', 'probe', 'handoff', 'checkpoint', 'readiness', 'new'].includes(cmd) ? [] : application ? ['session', 'mode', 'profile', 'run'] : ['tendril']), ...flagsByCommand[cmd]]);
  for (const name of Object.keys(flags)) if (!allowed.has(name)) throw invalid(`${cmd} does not accept --${name}`);
  const [min, max] = arity[cmd];
  if (args.length < min || args.length > max) throw invalid(`Invalid arguments for ${cmd}; see --help`);
  if (cmd === 'service' && flags.server !== undefined && flags.tendril !== undefined)
    throw invalid('Choose public service --server URL or page-scoped service --tendril NAME');
  if (flags.saved && flags.shared) throw invalid('Choose --saved or --shared');
  if (application && flags.mode !== undefined && !['attach', 'own', 'independent'].includes(flags.mode)) throw invalid('Use --mode attach, own, or independent');
  if (application && flags.mode === 'independent' && !flags.profile) throw invalid('--mode independent requires --profile');
  if (cmd === 'token' && flags.scopes !== undefined && args[0] !== 'create') throw invalid('--scopes applies only to token create');
  if (cmd === 'reapply' && flags['based-on'] === undefined) throw invalid('reapply requires --based-on with the reviewed current revision');
  if (cmd === 'watch' && !flags.events && ['cursor', 'topics', 'limit'].some(name => flags[name] !== undefined))
    throw invalid('watch --cursor, --topics and --limit require --events');
  const watchOptions = cmd === 'watch' ? { events: Boolean(flags.events),
    ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
    ...(flags.topics === undefined ? {} : { topics: jsonInput(flags.topics, 'topic array JSON') }),
    ...(flags.limit === undefined ? {} : { limit: intFlag(flags.limit, 'limit') }) } : undefined;
  if (watchOptions?.topics !== undefined && (!Array.isArray(watchOptions.topics) || watchOptions.topics.length > 128 ||
      watchOptions.topics.some(topic => typeof topic !== 'string' || topic.length > 128))) throw invalid('Use --topics with an array of at most 128 bounded topic names');
  if (watchOptions?.limit !== undefined && (watchOptions.limit < 1 || watchOptions.limit > 1024)) throw invalid('--limit must be between 1 and 1024');
  const seconds = intFlag(flags.timeout, 'timeout', (cmd === 'watch' || cmd === 'mcp-stdio') ? 0 : 30);
  if (seconds < 0 || seconds > 3600) throw invalid('--timeout must be between 0 and 3600 seconds');
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(Object.assign(Error('Invocation interrupted; inspect the original operation before retrying'), { code: 'invocation_interrupted' }));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const timer = seconds ? setTimeout(() => lifetime.abort(Object.assign(Error('Invocation timed out; inspect or retry the original operation'), { code: 'invocation_timeout' })), seconds * 1000) : undefined;
  const emit = async value => {
    if (!process.stdout.write(JSON.stringify(value, null, flags.pretty ? 2 : undefined) + '\n')) await once(process.stdout, 'drain', { signal: lifetime.signal });
  };
  let completedResult;
  try {
    if (application) {
      await withSession(flags.session, async owned => {
        if (cmd === 'watch') completedResult = await watchSession(owned, emit, { ...watchOptions, signal: lifetime.signal });
        else if (cmd === 'mcp-stdio') await serveStdioMcp(owned, { signal: lifetime.signal });
        else completedResult = await runSessionCommand(owned, cmd, args, flags, { signal: lifetime.signal });
      }, { signal: lifetime.signal, mode: flags.mode, profile: flags.profile, runId: flags.run });
      if (cmd === 'watch') console.error(JSON.stringify({ watch: completedResult }));
      else if (cmd !== 'mcp-stdio') await emit(completedResult);
    }
    else await emit(await hostCommand(cmd, args, flags, lifetime.signal));
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
// Only this executable owns process lifetime. Session libraries must finish
// their cleanup before we dispose lingering transport handles. In particular,
// watch does not settle main() until its awaited change loop has stopped.
let outputFailed = false;
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => { outputFailed = true; });
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
main().catch(error => {
  const exit = error?.exit;
  process.exitCode = Number.isInteger(exit) && exit >= 1 && exit <= 255 ? exit : 1;
  console.error(JSON.stringify({ error: { code: error.code ?? 'command_failed', message: error.message },
    diagnostic: diagnosticFinding(error, { scope: error.scope ?? {} }),
    ...(Number.isInteger(error.status) ? { status: error.status } : {}), ...(error.operation ? { operation: error.operation } : {}),
    ...(error.publication ? { publication: error.publication } : {}),
    ...(error.watch ? { watch: error.watch } : {}),
    ...(error.cleanupError ? { cleanup: { code: error.cleanupError.code ?? 'cleanup_failed', message: error.cleanupError.message } } : {}) }));
}).finally(async () => {
  const flushed = await Promise.all([process.stdout, process.stderr].map(flushOutput));
  if ((outputFailed || flushed.includes(false)) && !process.exitCode) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
});
