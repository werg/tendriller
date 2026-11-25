// Optional MCP adapter on the same native participant; no second app or backend.
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createScopedApplicationTools, forwardSessionEvents } from '@chronolog/peer-session';
import { createAssistantKey, proposeApplicationAssistant, connectApplicationAssistant, createAssistantEventDelivery } from '@tendriller/core/assistant';
import { project, privateDirectory, readPrivate, savePrivate } from './local.mjs';
import { openSession } from './session.mjs';
import { definition } from './domain.mjs';
import { createCliLifetime } from './helpers/cli-lifetime.mjs';
import { superviseParticipant } from './helpers/participant-lifecycle.mjs';

export async function prepareAssistant({ events = false, signal } = {}) {
  signal?.throwIfAborted();
  // Review this explicit subset when adapting the domain; new commands gain no authority.
  const selected = { queries: ['notes'], commands: ['addNote'] };
  for (const kind of ['queries', 'commands']) for (const name of selected[kind]) {
    if (!Object.hasOwn(definition[kind], name))
      throw Error(`Assistant ${kind} includes undeclared ${name}. Review the explicit capability selection in assistant.mjs for this domain.`);
  }
  const { handle } = await project({ signal });
  const key = await readPrivate('assistant-key.json', true) ?? await savePrivate('assistant-key.json', createAssistantKey());
  const options = { api: handle.api, token: handle.token, key, label: 'Shared notes', signal,
    ...selected,
    events: events ? [{ name: 'note.added', description: 'A note was added. Only its original operation ID is exposed.' }] : [] };
  signal?.throwIfAborted();
  return { options, review: await proposeApplicationAssistant(options) };
}
async function checkpoint(cursor) {
  const file = new URL('assistant-event-cursor.json', privateDirectory), temporary = new URL('assistant-cursor-' + randomUUID(), privateDirectory);
  await writeFile(temporary, JSON.stringify(cursor), { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, file);
}
// Dependency hooks qualify this lifecycle without real accounts or credentials.
export async function runAssistant({ signal, events = false } = {}, {
  prepare = prepareAssistant, open = openSession, connect = connectApplicationAssistant,
  tools = createScopedApplicationTools, forward = forwardSessionEvents, watch,
  onOwned, onClosed, report = value => console.log(JSON.stringify(value)),
} = {}) {
  signal?.throwIfAborted();
  let options, owned, lifecycle;
  try {
    // The native owner and its setup watcher must outlive optional proposal work.
    owned = await open({ signal }); onOwned?.();
    report({ state: 'participant_running', pid: process.pid, applicationId: owned.session.applicationId,
      processLifetime: 'Until this process or its execution environment stops; optional MCP connectivity has an independent lifetime.',
      checkpointDirectory: privateDirectory.pathname, futureWakeVerified: false });
    lifecycle = superviseParticipant({ owned, signal,
      watch: watch ?? owned.watchSetup,
      prepareAdapter: async ({ signal }) => {
        const prepared = await prepare({ events, signal });
        signal.throwIfAborted();
        options = prepared.options;
        report({ state: 'proposal_prepared', serviceOrigin: new URL(options.api).origin,
          reviewUrl: prepared.review.reviewUrl, connected: false, eventsForwarding: events,
          next: 'The owner opens the published page and reviews these permissions; no claimed reply is needed.' });
        return prepared.review.proposed;
      },
      startAdapter: callbacks => connect({ ...options, session: owned.session,
        tools: tools(owned.session, { queries: options.queries, commands: options.commands }), ...callbacks }),
      onOnline: events ? (assistant, lifetime) => forward({ session: owned.session, topics: ['note'], signal: lifetime,
        deliver: createAssistantEventDelivery({ assistant,
          onSkipped: () => report({ state: 'event_skipped', name: 'note.added', reason: 'event_not_approved',
            delivered: false, roundTripVerified: false, futureWakeVerified: false }),
        }),
        checkpoint: { load: async () => {
          try { return JSON.parse(await readFile(new URL('assistant-event-cursor.json', privateDirectory), 'utf8')); }
          catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
        }, save: checkpoint },
        project: event => ({ name: 'note.added', payload: { operationId: event.operationId } }),
      }) : undefined, report });
    await lifecycle.done;
  } finally {
    try { await lifecycle?.close(); } finally { await owned?.close(); }
    report({ state: 'stopped', connected: false, pid: process.pid });
    if (owned) onClosed?.();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = createCliLifetime();
  try {
    const args = process.argv.slice(2), events = args.includes('--events');
    const action = args.filter(arg => arg !== '--events');
    if (action.length > 1 || action.length && !['prepare', 'run'].includes(action[0])) throw Error('Use npm run assistant[:prepare] -- [--events]. Event forwarding is optional and does not configure future chat wake.');
    if (action[0] === 'prepare') console.log(JSON.stringify((await prepareAssistant({ events, signal: cli.signal })).review));
    else await runAssistant({ signal: cli.signal, events }, { onOwned: cli.opened, onClosed: cli.closed });
  } catch (error) { cli.fail(error); }
  // Only the standalone entry point owns disposal of this process. A completed
  // owner may leave Undici close handshakes behind; embedding never exits here.
  process.exit(await cli.finish());
}
