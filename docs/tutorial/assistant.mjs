// Optional MCP adapter on the same native participant; no second app or backend.
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createApplicationTools } from '@chronolog/peer-session';
import { createAssistantKey, proposeApplicationAssistant, connectApplicationAssistant, forwardApplicationEvents } from '@tendriller/core/assistant';
import { project, privateDirectory, readPrivate, savePrivate } from './local.mjs';
import { openSession } from './session.mjs';
import { superviseParticipant } from './helpers/participant-lifecycle.mjs';

export async function prepareAssistant({ events = false, signal } = {}) {
  signal?.throwIfAborted();
  const { handle } = await project({ signal });
  const key = await readPrivate('assistant-key.json', true) ?? await savePrivate('assistant-key.json', createAssistantKey());
  const options = { api: handle.api, token: handle.token, key, label: 'Shared notes', signal,
    queries: ['notes'], commands: ['addNote'],
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
  tools = createApplicationTools, forward = forwardApplicationEvents, watch,
  report = value => console.log(JSON.stringify(value)),
} = {}) {
  signal?.throwIfAborted();
  let options, owned, lifecycle;
  try {
    // The native owner and its setup watcher must outlive optional proposal work.
    owned = await open({ signal });
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
      startAdapter: callbacks => connect({ ...options, session: owned.session, tools: tools(owned.session), ...callbacks }),
      onOnline: events ? (assistant, lifetime) => forward({ session: owned.session, assistant, topics: ['note'], signal: lifetime,
        checkpoint: { load: async () => {
          try { return JSON.parse(await readFile(new URL('assistant-event-cursor.json', privateDirectory), 'utf8')); }
          catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
        }, save: checkpoint },
        project: event => ({ name: 'note.added', payload: { operationId: event.operationId } }),
        onSkipped: () => report({ state: 'event_skipped', name: 'note.added', reason: 'event_not_approved',
          delivered: false, roundTripVerified: false, futureWakeVerified: false }),
      }) : undefined, report });
    await lifecycle.done;
  } finally {
    try { await lifecycle?.close(); } finally { await owned?.close(); }
    report({ state: 'stopped', connected: false, pid: process.pid });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => stop.abort());
  try {
    const args = process.argv.slice(2), events = args.includes('--events');
    const action = args.filter(arg => arg !== '--events');
    if (action.length > 1 || action.length && !['prepare', 'run'].includes(action[0])) throw Error('Use npm run assistant[:prepare] -- [--events]. Event forwarding is optional and does not configure future chat wake.');
    if (action[0] === 'prepare') console.log(JSON.stringify((await prepareAssistant({ events, signal: stop.signal })).review));
    else await runAssistant({ signal: stop.signal, events });
  } catch (error) { if (!stop.signal.aborted) { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; } }
}
