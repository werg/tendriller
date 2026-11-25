# Multi-agent chat, backchannel & ephemeral RPC (`agent-requests.mjs`)

The starter kit includes `shared/helpers/agent-requests.mjs`, an importable
multi-agent Chronolog communication pipe with two durable commands (`agentMessage`,
`agentReceipt`), one coherent query (`agentFeed`), deterministic routing helpers
(`parseAddressing`, `shouldAgentRespond`, `evaluateFailover`), and ephemeral
signal helpers (`announceAgentPresence`, `watchAgentsPresence`, `streamAgentReply`,
`watchAgentStreams`).

## 1. Wire the commands and query into `domain.mjs`

```js
import { defineApplication } from '@chronolog/peer-session';
import { agentRequestCommands, agentRequestQueries } from '../../shared/helpers/agent-requests.mjs';

export const definition = defineApplication({
  id: 'my-app',
  version: '1',
  commands: { ...agentRequestCommands /*, your domain commands */ },
  queries: { ...agentRequestQueries /*, your domain queries */ },
});
```

- Every durable message is authenticated by `event.author` (the cryptographic
  signing public key) — never by a self-claimed author field.
- `channel: 'chat'` renders in the user-facing chat timeline.
- `channel: 'agents'` renders in the collapsible **Agent activity** drawer for
  agent-to-agent delegation and coordination.
- `to` is an array of 64-hex signing public keys, `['*']` for `@all`, or `[]`
  for a general message handled by the page's primary agent.

## 2. Addressing & primary/secondary routing

```js
import { parseAddressing, shouldAgentRespond } from '../../shared/helpers/agent-requests.mjs';

const parsed = parseAddressing('@reviewer please check this', roster);
// -> { to: [reviewer.public_key], handles: ['reviewer'], explicit: true, broadcast: false }
```

Every native agent checks `shouldAgentRespond(message, { selfPublicKey, selfHandle, roster, maxHops: 5 })`:

- **Primary agent** responds to general `chat` messages (`to: []`), and steps
  back cleanly when the user explicitly addresses a secondary `@handle`.
- **Non-primary agents** stay silent on general messages (`to: []`) and respond
  only when directly addressed (`@handle`, `@all`, or delegated on `agents`).
- **Loop guardrails:** messages with `expectReply: false` or `hopCount >= 5`
  never trigger automatic replies. Delegated specialists can set
  `replyToUser: true` to post directly to `chat` or return results on `agents`
  for the primary agent to synthesize.

## 3. Ephemeral Agent Cards & streaming previews (zero durable heartbeats)

Never write periodic durable heartbeat records to Chronolog. Use ephemeral
signals instead:

```js
import { announceAgentPresence, streamAgentReply } from '../../shared/helpers/agent-requests.mjs';

const card = announceAgentPresence(session, {
  handle: context.agent.handle,
  bio: context.agent.bio,
  capabilities: ['chat', 'code'],
  isPrimary: context.roster.isPrimary,
});
context.roster.onChange(r => card.updateCard({ isPrimary: r.is_primary }));

// Stream partial replies ephemerally while working:
await streamAgentReply(session, {
  messageAuthor: msg.author,
  messageOperationId: msg.operationId,
  handle: context.agent.handle,
  text: partialText,
});
// Commit durable agentMessage reply, then clear the stream:
await streamAgentReply(session, {
  messageAuthor: msg.author,
  messageOperationId: msg.operationId,
  handle: context.agent.handle,
  text: '',
  done: true,
});
```

## 4. Handle-addressed ephemeral RPC (`signal-request.mjs`)

For up to 4 MiB chunked JSON request/reply between browser ↔ any agent or
agent ↔ agent without writing to the durable journal, use `createAgentRpc` and
`serveAgentRpc` from `shared/helpers/signal-request.mjs`.

## 5. Browser chat & failover UX (`chat-session.mjs`)

Use `mountConnectedAgentChat({ runtime: window.tendril, session, container })`
from `shared/ui/chat-session.mjs`. It connects automatically to `tendril.agents`,
renders per-agent `@handle` badges, `@handle` autocomplete, `To:` target chips,
collapsible **Agent activity**, queued TTS playback, and a non-blocking
failover banner when the primary agent is offline or stopped and another
enrolled agent is online.
