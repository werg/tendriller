// Optional MCP adapter on the same native participant; no second app or backend.
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createApplicationTools } from '@chronolog/peer-session';
import { createAssistantKey, proposeApplicationAssistant, connectApplicationAssistant, forwardApplicationEvents } from '@tendriller/core/assistant';
import { project, privateDirectory, readPrivate, savePrivate } from './local.mjs';
import { openSession } from './session.mjs';

export async function prepareAssistant() {
  const { handle } = await project();
  const key = await readPrivate('assistant-key.json', true) ?? await savePrivate('assistant-key.json', createAssistantKey());
  const options = { api: handle.api, token: handle.token, key, label: 'Shared notes',
    queries: ['notes'], commands: ['addNote'],
    events: [{ name: 'note.added', description: 'A note was added. Only its original operation ID is exposed.' }] };
  return { options, review: await proposeApplicationAssistant(options) };
}
async function checkpoint(cursor) {
  const file = new URL('assistant-event-cursor.json', privateDirectory), temporary = new URL('assistant-cursor-' + randomUUID(), privateDirectory);
  await writeFile(temporary, JSON.stringify(cursor), { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, file);
}
export async function runAssistant({ signal } = {}) {
  const { options, review } = await prepareAssistant();
  console.log(JSON.stringify({ reviewUrl: review.reviewUrl, next: 'The owner opens the published page and reviews these permissions; no claimed reply is needed.' }));
  const owned = await openSession({ signal });
  const assistant = connectApplicationAssistant({ ...options, session: owned.session,
    tools: createApplicationTools(owned.session), signal,
    onStatus: status => console.log(JSON.stringify({ assistant: status })) });
  try {
    await forwardApplicationEvents({ session: owned.session, assistant, topics: ['note'], signal,
      checkpoint: { load: async () => {
        try { return JSON.parse(await readFile(new URL('assistant-event-cursor.json', privateDirectory), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      }, save: checkpoint },
      project: event => ({ name: 'note.added', payload: { operationId: event.operationId } }),
    });
  } finally { await assistant.close(); await owned.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => stop.abort());
  try {
    if (process.argv[2] === 'prepare') console.log(JSON.stringify((await prepareAssistant()).review));
    else await runAssistant({ signal: stop.signal });
  } catch (error) { if (!stop.signal.aborted) { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; } }
}
