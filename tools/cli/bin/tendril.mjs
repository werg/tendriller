#!/usr/bin/env node
import { once } from 'node:events';
import { parseArgs, intFlag } from '../lib/args.mjs';
import { resolveConfig, saveConfig, removeConfig, serverBase } from '../lib/config.mjs';
import { request, client, ApiError } from '../lib/api.mjs';
import { jsonInput, runSessionCommand, watchSession, withSession } from '../lib/session.mjs';

const usage = `Usage: tendril <command> [options]

Owned application session (--session /absolute/application.mjs):
  describe | status | query <name> [json]
  command <name> <json> --operation ID [--based-on JSON] [--saved | --shared]
  operation <id> | retry <id> [--saved]
  reapply <old-id> <name> <json> --operation NEW_ID --based-on JSON
  events [--cursor CURSOR] [--topics JSON] [--limit N] | watch
  signal <topic> <json> [--ttl MILLISECONDS]
  recovery inspect | takeover --transition ID | handover <device> --transition ID
  definition | publication | publish <directory> --operation ID [--entry index.html]

Host lifecycle (--tendril NAME, or TENDRIL_API and TENDRIL_TOKEN):
  new [name] --owner VERIFIED_EMAIL [--server URL] [--as NAME]
  info [--show-url] | service | meta <json> | release
  link list | create <json> | rotate <id> | remove <id>
  token list | create <name> | remove <name>
  activity [--after N] | remove --yes

--timeout SECONDS bounds an invocation (default 30; watch waits until interrupted).
--pretty formats JSON. The session module exports openSession({signal}) and returns
{session, control?}; control is session.connectControlParticipant(...).
Chronolog owns signing, exact retry, durable identity and recovery. No host data
API or extra delivery queue is installed. A timed out waiter leaves its saved
operation available under the original identity.`;
const applicationCommands = new Set(['describe', 'status', 'query', 'command', 'operation', 'retry', 'reapply',
  'events', 'watch', 'signal', 'recovery', 'definition', 'publication', 'publish']);
const flagsByCommand = {
  describe: [], status: [], query: [], command: ['operation', 'based-on', 'saved', 'shared'], operation: [],
  retry: ['saved'], reapply: ['operation', 'based-on', 'saved', 'shared'], events: ['cursor', 'topics', 'limit'], watch: [],
  signal: ['ttl'], recovery: ['transition'], definition: [], publication: [], publish: ['operation', 'entry'],
  new: ['owner', 'server', 'as'], info: ['show-url'], service: [], meta: [], release: [], link: [], token: [],
  activity: ['after'], remove: ['yes'],
};
const arity = { describe: [0, 0], status: [0, 0], query: [1, 2], command: [2, 2], operation: [1, 1], retry: [1, 1],
  reapply: [3, 3], events: [0, 0], watch: [0, 0], signal: [2, 2], recovery: [1, 2], definition: [0, 0], publication: [0, 0],
  publish: [1, 1], new: [0, 1], info: [0, 0], service: [0, 0], meta: [1, 1], release: [0, 0],
  link: [1, 2], token: [1, 2], activity: [0, 0], remove: [0, 0] };
const invalid = message => Object.assign(Error(message), { exit: 64 });
const checkedName = value => { if (!value) throw invalid('Supply an identity'); return encodeURIComponent(value); };

async function hostCommand(command, args, flags, signal) {
  if (command === 'new') {
    const owner = String(flags.owner ?? process.env.TENDRIL_OWNER ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(owner) || owner.length > 254) throw invalid('new requires --owner VERIFIED_EMAIL');
    const server = serverBase(process.env, flags);
    const handle = await request(`${server}/api/tendrils`, { method: 'POST', signal,
      json: { ...(args[0] ? { name: args[0] } : {}), owner, lifetime: 'ad_hoc' } });
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
  if (action === 'create' && args.length === 2) return api.post(path, command === 'link' ? jsonInput(input) : { name: input }, options);
  if (action === 'remove' && args.length === 2) { await api.del(`${path}/${checkedName(input)}`, options); return { removed: input }; }
  if (command === 'link' && action === 'rotate' && args.length === 2) return api.post(`${path}/${checkedName(input)}/rotate`, {}, options);
  throw invalid(`Unknown ${command} action; see --help`);
}

async function main() {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === 'help' || cmd === undefined) { console.log(usage); return; }
  if (!Object.hasOwn(flagsByCommand, cmd)) throw invalid(`Unknown command: ${cmd}`);
  const application = applicationCommands.has(cmd);
  const allowed = new Set(['pretty', 'timeout', application ? 'session' : 'tendril', ...flagsByCommand[cmd]]);
  for (const name of Object.keys(flags)) if (!allowed.has(name)) throw invalid(`${cmd} does not accept --${name}`);
  const [min, max] = arity[cmd];
  if (args.length < min || args.length > max) throw invalid(`Invalid arguments for ${cmd}; see --help`);
  if (flags.saved && flags.shared) throw invalid('Choose --saved or --shared');
  if (cmd === 'reapply' && flags['based-on'] === undefined) throw invalid('reapply requires --based-on with the reviewed current revision');
  const seconds = intFlag(flags.timeout, 'timeout', cmd === 'watch' ? 0 : 30);
  if (seconds < 0 || seconds > 3600) throw invalid('--timeout must be between 0 and 3600 seconds');
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(Error('Invocation interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const timer = seconds ? setTimeout(() => lifetime.abort(Error('Invocation timed out; inspect or retry the original operation')), seconds * 1000) : undefined;
  const emit = async value => {
    if (!process.stdout.write(JSON.stringify(value, null, flags.pretty ? 2 : undefined) + '\n')) await once(process.stdout, 'drain', { signal: lifetime.signal });
  };
  try {
    if (application) await withSession(flags.session, async owned => {
      if (cmd === 'watch') await watchSession(owned, emit, { signal: lifetime.signal });
      else await emit(await runSessionCommand(owned, cmd, args, flags, { signal: lifetime.signal }));
    }, { signal: lifetime.signal });
    else await emit(await hostCommand(cmd, args, flags, lifetime.signal));
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}
main().catch(error => {
  console.error(JSON.stringify({ error: { code: error.code ?? 'command_failed', message: error.message },
    ...(error instanceof ApiError ? { status: error.status } : {}), ...(error.operation ? { operation: error.operation } : {}) }));
  process.exitCode = error.exit ?? 1;
});
