# Multi-agent chat, backchannel & ephemeral RPC (`agent-requests.mjs`)

The starter kit includes `shared/helpers/agent-requests.mjs`, an importable
multi-agent Chronolog communication pipe with two durable commands (`agentMessage`,
`agentReceipt`), one coherent query (`agentFeed`), deterministic routing helpers
(`parseAddressing`, `shouldAgentRespond`, `evaluateFailover`), and ephemeral
signal helpers (`announceAgentPresence`, `watchAgentPresence`, `watchAgentsPresence`,
`streamAgentReply`, `watchAgentStreams`). A request is simply a message an agent
should answer; its answer is a reply message whose `inReplyTo` names the request.
`consumers/request-worker.mjs` and `consumers/codex-queue.mjs` consume this same
pipe with durable checkpoints.

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

### Keep the whole message reference

A receipt carries **both** `messageAuthor` and `messageOperationId`, and a reply's
`inReplyTo` carries both `author` and `operationId`, copied unchanged from the
feed or event. The schema permits 512 characters for an operation reference,
matching the public protocol bound. Do not truncate, slice a suffix or assume a
128-character identifier: different authors can use the same operation ID.

`messageDelivery` counts only receipts and replies authored by someone other than
the message's own signer. The displayed sender always comes from the signed event
author, never from a caller-provided claim. Messages are visible to every member of
the application, not a private mailbox; adapt the domain's permissions as needed.

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

Presence defaults to a 15-second announcement interval and a 30-second signed
lifetime, within the public session's default signal limit. Workers use distinct
signal streams, and observers respect the signed expiry as well as their local
freshness bound. A late retained frame never starts another full lifetime.
Streaming and presence never replace durable replies.

### Live presence belongs to the actual worker

Peer connectivity only says an enrolled participant is reachable. It does not say
whether its agent loop is actually handling messages. When the native page owner,
an event forwarder and the interactive worker are separate, **only the actual
handler announces its card and channels**. Start `announceAgentPresence` after the
worker's first successful read, bind its `signal` to that worker's lifetime, and
close it in the worker's `finally`; a stopped assistant's card must never be
refreshed by a page owner or by another worker under the same signer.

`watchAgentsPresence` aggregates every validated card on the page by signer (the
roster view). `watchAgentPresence({ peer, consumerId, requestTopic })` observes one
worker and channel; its `available`, `busy`, `stale` and `stopped` values are
liveness hints, not acknowledgements. A graceful exit publishes stopped; a crash
ages to stale while the native peer remains connected. Test this split-process
failure explicitly.

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

## 6. Run a supervised worker with a handled checkpoint

The starter ships `consumers/request-worker.mjs` and
`shared/helpers/agent-consumer.mjs`. The worker attaches to the existing page owner,
reads the page roster from the host, and handles `agentMessage` events on the
selected channels for which `shouldAgentRespond` says this agent should answer. It
records a `seen` receipt, runs the handler, then saves a reply `agentMessage` with
`inReplyTo` set to the full message identity. It never opens a second signer or
modifies an existing application's definition.

In a workspace whose page declares `agentMessage`, `agentReceipt` and `agentFeed`,
keep `npm run agent` running, then run:

```sh
node consumers/request-worker.mjs --workspace /absolute/workspace \
  --page requests --consumer assistant --topics '["chat"]' \
  --checkpoint /private/assistant.json --echo
```

`--echo` is a harmless runnable example: a message this agent should answer
receives a durable receipt and an echo reply. It verifies consumption and restart,
not LLM execution or conversation wake. For application work, replace `--echo`
with `--handler /absolute/handler.mjs`; that module exports
`handleRequest(message, { signal, idempotencyKey })` and returns a nonempty reply
string of at most 8,000 characters. Honor cancellation and use the retained key
and provider receipts to reconcile external effects. The worker persists a
`handling` marker before invoking the handler; a crash or failure there stops with
`AGENT_CONSUMER_REVIEW_REQUIRED` on resume rather than repeating a possibly
completed external effect. Neither a materialized message nor a receipt gives
exactly-once external execution.

Run one logical handler per agent and channel. The checkpoint lock protects one
file; it is not a distributed claim between workers using different files. Exact
prepared receipt/reply inputs and work results survive restarts; the handled cursor
advances only after durable handling. A stale event cursor (every later
materialized revision, including the worker's own receipt and reply) derives the
events again; this agent's durable replies, not the cursor, skip messages already
handled. A retained pending message that a revision made ineffective, and a
checkpoint for a different scope, stop for review. Never edit a cursor merely to
make pending work disappear. After an abrupt kill, verify the previous worker is
gone and reconcile pending work before removing a stale `.lock`.

Startup, handler, review-required and owner-loss failures exit nonzero.
SIGINT/SIGTERM performs normal cleanup; the native page owner remains running. Use
a bounded supervisor (for example `Restart=on-failure`, `RestartSec=3`,
`StartLimitIntervalSec=120`, `StartLimitBurst=6`) on the worker command, not on a
one-shot `events` reader. [Restart guidance](AGENT_RESTART.md) explains
reattachment and
[revised-projection review](AGENT_RESTART.md#review-a-revised-projection-before-resuming).

Verify a first message, stop only this worker with the native owner still
connected, and send a second message. The worker's card must become stopped or
stale and the second message remains `delivered`. Restart with the same checkpoint
and confirm its receipt and reply. For conversation delivery, also perform the
[host rehearsal](CONVERSATION_DELIVERY.md#two-request-same-conversation-rehearsal).
