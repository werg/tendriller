import { defineApplication, eventExecutionManifest } from '@chronolog/peer-session';
import { agentRequestCommands, agentRequestQueries } from '../../shared/helpers/agent-requests.mjs';
import { callCommands, callQueries } from '../../shared/helpers/call-domain.mjs';

export const definition = defineApplication({
  id: 'tendriller.call-room',
  version: '1',
  executionManifest: eventExecutionManifest(),
  commands: {
    ...callCommands,
    ...agentRequestCommands,
  },
  queries: {
    ...callQueries,
    ...agentRequestQueries,
  },
});
