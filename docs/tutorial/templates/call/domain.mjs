import { defineApplication } from '@chronolog/peer-session/browser';
import { agentRequestCommands, agentRequestQueries, agentRequestTopics } from '../../shared/helpers/agent-requests.mjs';
import { callCommands, callQueries, callTopics } from '../../shared/helpers/call-domain.mjs';

export const reducerSource = `
export default {
  reduce(state, tx, ctx) {
    if (!ctx.query('$permissions', { check: 'writer', actor: tx.author })) {
      return { ok: false, code: 'writer_required' };
    }
    const eventTopic = ctx.config && typeof ctx.config.eventTopic === 'string' ? ctx.config.eventTopic : 'call/event';
    const count = (state && typeof state.count === 'number' ? state.count : 0) + 1;
    return {
      ok: true,
      state: { count, lastAuthor: tx.author },
      events: [{ topic: eventTopic, payload: tx.payload }],
    };
  },
  query(state) {
    return state || { count: 0 };
  },
};
`;

export const imports = Object.freeze({ 'app/call': reducerSource });
export const topics = Object.freeze(
  Object.fromEntries(
    [...callTopics, ...agentRequestTopics].map(name => [
      name,
      Object.freeze({ module: 'app/call', config: Object.freeze({ eventTopic: name }) }),
    ]),
  ),
);

export const definition = defineApplication({
  id: 'tendriller.call-room',
  version: '2',
  commands: {
    ...callCommands,
    ...agentRequestCommands,
  },
  queries: {
    ...callQueries,
    ...agentRequestQueries,
  },
});
