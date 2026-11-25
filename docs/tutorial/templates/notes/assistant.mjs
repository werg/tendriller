// Optional MCP adapter on this page's owner inside `tendril agent run`; no second app,
// process or backend. Prepare once with: npm run assistant:prepare -- <slug> [--events]
// The running agent connects the adapter after the owner approves the proposal.
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createScopedApplicationTools, forwardSessionEvents } from '@chronolog/peer-session';
import { createAssistantKey, proposeApplicationAssistant, connectApplicationAssistant, createAssistantEventDelivery } from '@tendriller/core/assistant';
import { definition } from './domain.mjs';

// Review this explicit subset when adapting the domain; new commands gain no authority.
const selected = { queries: ['notes'], commands: ['putNote'] };

export async function prepareAssistant(context, { events = false } = {}) {
  context.signal?.throwIfAborted();
  for (const kind of ['queries', 'commands']) for (const name of selected[kind]) {
    if (!Object.hasOwn(definition[kind], name))
      throw Error(`Assistant ${kind} includes undeclared ${name}. Review the explicit capability selection in assistant.mjs for this domain.`);
  }
  const key = await context.readPrivate('assistant-key.json', true) ?? await context.savePrivate('assistant-key.json', createAssistantKey());
  const options = { label: context.page.name ?? 'Shared notes', ...selected,
    events: events ? ['note.put','note.deleted'].map(name=>({name,description:'Revisable note observation; only its original operation identity is exposed.'})) : [] };
  const review = await proposeApplicationAssistant({ page: context.host, key, signal: context.signal, ...options });
  await context.savePrivate(`assistant-proposal-${review.proposed}.json`, { ...options, proposalId: review.proposed, forwardEvents: events });
  await replace(context, 'assistant.json', { proposalId: review.proposed });
  return { ...review, next: 'The owner opens the published page and reviews these permissions; the running agent connects after approval.' };
}

async function replace(context, name, value) {
  const path = context.privatePath(name), temporary = context.privatePath(`assistant-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, path);
}

/** Hooks for the page's participant lifecycle; absent until the assistant is prepared. */
export async function assistantIntegration({ context, session }) {
  const current = await context.readPrivate('assistant.json', true);
  if (!current) return {};
  const key = await context.readPrivate('assistant-key.json');
  const options = await context.readPrivate(`assistant-proposal-${current.proposalId}.json`);
  return {
    proposalId: current.proposalId,
    startAdapter: callbacks => connectApplicationAssistant({ page: context.host, key, session,
      tools: createScopedApplicationTools(session, { queries: options.queries, commands: options.commands }), ...callbacks }),
    onOnline: options.forwardEvents ? (assistant, lifetime) => forwardSessionEvents({ session, topics: ['note.put','note.deleted'], signal: lifetime,
      deliver: createAssistantEventDelivery({ assistant,
        onSkipped: ({name}) => context.report({ state: 'event_skipped', name, reason: 'event_not_approved', delivered: false }) }),
      checkpoint: {
        load: async () => {
          try { return JSON.parse(await readFile(context.privatePath('assistant-event-cursor.json'), 'utf8')); }
          catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
        },
        save: cursor => replace(context, 'assistant-event-cursor.json', cursor),
      },
      project: event => ({ name: event.topic, payload: { operationId: event.operationId } }),
    }) : undefined,
  };
}
