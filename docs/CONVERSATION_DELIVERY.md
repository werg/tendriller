# Connect requests to the same agent conversation

Use this guide when a user asks one existing conversation to handle requests
from one or several Tendriller pages during and after its current turn. Read it during
setup through `tendril_guide` with `topic: "conversation"`. A connected native
participant, forwarded event, webhook receipt or terminal line does not establish
that the intended conversation can receive another turn.

Keep three lifetimes separate:

| Component | Responsibility | Evidence |
| --- | --- | --- |
| Workspace agent program / page owner | Retain the signer, page sessions, transport and declared application tools | Correct application/history and a successful declared query |
| Request worker | Read messages this agent should answer on its channels, acknowledge work and retain replies | Worker-owned live presence plus a durable receipt and `inReplyTo` reply on the original message |
| Conversation receiver | Ask the host to admit input to the selected current turn or start another turn in that thread | Active-turn input and repeated completed turns in the same thread |

The workspace still uses one agent identity and one page owner per application.
An additional agent per page does not satisfy a request to continue the existing
point-person conversation. A receiver can serve all approved pages, with separate
checkpoints for each application/history and unchanged event filters.

## Qualify the host during setup

Inspect the tools and execution surface available in the **current host**, along
with authentication, owner-approved application events and the intended thread.
Report the selected route before presenting an unattended assistant as ready.
The public setup response's `conversationWake: "not-established"` is a boundary
notice: the server cannot discover or attest a surrounding host's thread delivery
from an OAuth grant. Its `conversationGuide` points here on the selected service
origin.

| Actual host capability | Route | Same-conversation claim |
| --- | --- | --- |
| Supported ChatGPT Work host exposes an event-subscription tool | Subscribe to approved `application.event` entries for the selected applications; retain and inspect delivery receipts | Conditional on subscription success and the two-request rehearsal below |
| Codex exposes App Server steering, the documented `codex queue` command and the intended thread on its daemon | Use the bundled multi-page bridge with the exact thread UUID and explicit remote endpoint | Steer an observed active turn; queue idle work; qualify both active injection and repeated same-thread execution as below |
| Antigravity (`agy` CLI or Antigravity App) exposes `agentapi` (`get-conversation-metadata` / `send-message`) and the intended conversation UUID | Use `consumers/antigravity-bridge.mjs --mode agentapi` (or an Antigravity App Sidecar for restart persistence) with exact conversation UUID and workspace verification | Delivers `MESSAGE_PRIORITY_HIGH` messages to active and idle turns while the Antigravity Language Server stays alive; qualify repeated same-thread execution as below |
| Antigravity exposes reactive background-task wakeup (`run_command`, `IsDaemon: false`) without `agentapi` | Use `consumers/antigravity-bridge.mjs --mode wait` as a non-daemon task and re-arm after each handled wake | Wakes the calling conversation once per armed run while the session remains open; not restart-persistent |
| A host exposes another existing-thread execution API | A supervised receiver admits work to that exact thread and waits for the resulting turn/outcome | Qualify thread identity, concurrent-turn policy and restart handling before selecting this route |
| Only `read_application_events` is available | Catch up during a turn initiated by the user or an independently supported host mechanism | No unattended wake established |
| Only `tendril watch`, `events`, or a one-shot terminal waiter is running | Observe or replay retained application events for a real worker | No conversation admission mechanism established |
| An independently published Workspace Agent or another worker owns its execution loop | Route work to that separately identified worker with the owner's chosen policy | Does not establish continuation of an existing Codex/ChatGPT thread |

Do not infer support from a product name, plugin installation or successful
account linking. A tool absent from this session is unavailable here even if a
different environment supports it. Treat reauthentication, refused subscription,
missing callback admission and unknown thread identity as separate setup stages.
Finish the available page/session work and retain requests while resolving them.
Use [ChatGPT setup](CHATGPT_INTEGRATION.md) for that host's concrete event route.

## Codex mechanisms and the supplied conversation bridge

The supplied `consumers/codex-queue.mjs` bridge selects the admission route from
the actual thread state. When the selected conversation is running, it sends the
retained notice to that **current turn** with App Server `turn/steer`. Accepted
input becomes available at the next applicable continuation boundary; it does
not cancel an already running tool or promise immediate interruption of an
emitted response. When the conversation is idle or unloaded, the bridge uses
`codex queue` and, where appropriate, `--resume`.

Plain `codex queue` by itself waits for a running turn to become eligible; it
does not inject into that active turn. The bridge adds steering explicitly.
Admission still differs from the model reading the request, acknowledging work,
or saving an answer.

Primary sources for the installed `0.172.0` protocol include the
[App Server reference](https://developers.openai.com/codex/app-server),
[turn steering implementation](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/app-server/src/request_processors/turn_processor.rs),
[atomic active-turn admission](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/session/turn_input.rs),
[turn metadata schema](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTurnsListParams.ts),
[Codex CLI reference](https://developers.openai.com/codex/cli/reference),
[queue implementation](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/tui/src/session_queue_commands.rs)
and [queue lifecycle tests](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/app-server/tests/suite/v2/thread_queue.rs).
Inspect `codex --version`, `codex queue --help` and
`codex app-server daemon version` in the actual execution environment; capabilities
may differ by version or selected host.

With the workspace's native owner already running and both selected pages
declaring the request pattern:

```sh
node consumers/codex-queue.mjs --workspace /absolute/workspace \
  --pages requests,second --thread EXACT_THREAD_UUID --topics chat,agents \
  --remote unix:// --state-dir /private/codex-queue
```

Select the exact UUID of the **intended existing Codex thread**, and verify that
its UI uses the same daemon and retained thread store. The bridge also checks
that the thread's recorded working directory matches the configured workspace
(or an explicit parent `--thread-cwd` when the Tendriller workspace lives in a
subdirectory of the conversation's root directory, e.g. `/home/user/agent/v2`
under `--thread-cwd /home/user/agent`). Unrelated `--thread-cwd` paths are
rejected; `--workspace` still governs page attachments and the workspace path
included in message notices. At startup, the bridge preflights the actual
conversation route (`thread/read` + `thread/turns/list`) and emits
`conversation_route_ready` — or fails immediately with `conversation_route_failed`
and `CODEX_QUEUE_THREAD_UNAVAILABLE` — rather than reporting only
`request_protocol_ready` and failing on the first incoming message.
Do not choose `--last`, an ambiguous name or a newly created thread. A cloud
ChatGPT conversation ID is not a Codex thread UUID or proof of access to this
local daemon.

For `unix://`, the bridge discovers the running daemon's absolute socket path
with the bounded read-only `codex app-server daemon version` command. An explicit
`unix:///absolute/socket` selects that socket directly. The bridge's explicit
`ws` dependency performs a WebSocket handshake over the Unix socket at `/rpc`,
matching Codex's
[remote client](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/app-server-client/src/remote.rs).
It never starts a separate daemon. The raw `codex app-server proxy` copies bytes;
it does not translate JSON lines into WebSocket messages. For `ws://` or
`wss://`, the bridge connects to that same configured endpoint. `--remote-auth-token-env ENV_NAME` supplies a bearer token
from the environment for authenticated remote endpoints. Tokens require TLS or
a loopback WebSocket address, matching Codex's transport policy. Unix sockets
use local socket authority and reject the bearer-token option. The CLI queue
path uses the same endpoint and credential-variable name. Server-initiated
approval/tool requests on this admission-only connection stop it; the bridge
cannot grant approvals on the user's behalf.

One bridge serves every page listed in `--pages` and one thread. It serializes
metadata reads and admission through connection cleanup across its pages, and
checks cancellation before the next admission. It attaches to
the existing owner, selects `agentMessage` events on the chosen channels that this
agent should answer under the page roster (`shouldAgentRespond`), and keeps a
bounded private outbox/checkpoint per page. Its default state lives under
`.tendriller/consumers/codex-queue/THREAD_UUID` in the workspace. The notice
contains message references and instructions to read the declared feed, rather
than copying private message text. The conversation reads `agentFeed`,
acknowledges actual work with an `agentReceipt`, performs its authorized work and
replies with an `agentMessage` whose `inReplyTo` names the original message. Messages
this agent already replied to are skipped. The bridge itself neither announces
assistant presence nor writes a receipt or reply.

### Active-turn steering and race handling

Before admission, the bridge reads `thread/read` with `includeTurns:false`,
then `thread/turns/list` with `limit:1`, `sortDirection:"desc"` and
`itemsView:"notLoaded"`. The latter includes the live current-turn header
without loading conversation items. A loaded `inProgress` turn is steered with
its exact `expectedTurnId`, the retained `clientUserMessageId`, and the original
retained notice. The server checks the expected identity atomically before
appending input. The bridge requires the acknowledged `turnId` to match.

A turn can finish or change between the read and the steering call. Only the
qualified `NotSubmitted` rejections—exact `-32600` no-active-turn or
expected-turn-mismatch responses without additional error data—allow a fresh
route decision. A generic invalid-request error is insufficient. The bridge
re-reads metadata: it gives a genuinely new active turn one additional steering
attempt, or queues if the conversation is now idle/unloaded. Continuous turn
churn stops with a retained `steer-rejected` record for review. A same-turn
no-active rejection can indicate a pending stop; the bridge queues without
requesting resume in that case.

A timeout, disconnect, malformed acknowledgement, or unqualified steering
rejection leaves an `uncertain` admission and stops. It never causes an automatic
queue fallback. The retained original input, client identity and observed turn
identity remain available for reconciliation. A client message ID helps identify
input; it is not an exactly-once execution guarantee.

### Idle queueing and preserved interruption

The idle route invokes this documented CLI shape with argument boundaries
preserved:

```sh
codex queue --thread EXACT_THREAD_UUID --message SAFE_PENDING_NOTICE \
  --resume --remote unix://
```

The explicit remote avoids an embedded-server fallback. If the latest turn is
interrupted, the bridge omits `--resume`, including for an unloaded thread.
It does not invoke `thread/queue/start` or override a user stop. A new turn can
begin after the metadata read; queue admission remains safe in that race and
the queue waits for eligibility. Thread state and subsequent turn execution
must therefore be observed during host qualification.

The CLI generates a fresh queued-message identity on every invocation, so blind
retries can duplicate admission. The bridge durably records `invoking` before
either steering or queueing. A successful queue command can still include a
resume warning, which is retained as `resume-unconfirmed` and stops. Inspect the
intended thread's queue/history and reconcile the existing admission before any
deliberate retry.

JSON status output distinguishes `steered` with `source:"turn/steer"` and its
turn/client identity from `queued` with `source:"thread/queue/add"` and its queue
identity. Both explicitly report `workerReceipt:false` and
`wakeVerified:false`. Neither admission status is a handled checkpoint or
proof of a completed model turn.

The exclusive lock, scoped checkpoints and verification of retained request
references prevent concurrent outbox owners and silent reuse of a checkpoint after
the effective events changed. An event cursor binds to one materialized
revision, so any later revision makes it stale; the bridge then derives the page's
events again and skips requests that are already answered or already delivered
(a bounded set of delivered, unanswered request keys in its checkpoint).

### Safe reboot/crash recovery and startup supervision

Checkpoint locks record host, Linux boot identity (`/proc/sys/kernel/random/boot_id`),
PID, and process start time (`/proc/<pid>/stat` field 22). After a normal reboot,
abrupt kill (`SIGKILL`), or OS PID reuse, `openConsumerCheckpoint` proves the
previous owner is dead, atomically renames the stale `.lock` directory out of the
way (so racing contenders cannot steal a live lock), and preserves the checkpoint
`.json` file untouched. Any retained `invoking` or `uncertain` admission still stops
with `CODEX_QUEUE_REVIEW_REQUIRED` for explicit reconciliation — stale-lock recovery
never blindly resends uncertain deliveries. If a live owner or unverifiable lock
(e.g., different host or damaged `owner.json`) is present, startup fails closed with
`AGENT_CONSUMER_LOCKED`.

At boot, `consumers/codex-queue.mjs` also waits with bounded retries when
`tendril agent run` is still opening pages (`OWNER_UNREACHABLE` /
`SUPERVISOR_PAGE_UNAVAILABLE`) before failing. Under systemd, order the bridge
`After=tendriller-agent.service` with `Restart=on-failure` and `RestartSec=5`.

### Platform broadcast wake (same conversation)

By default (`--no-broadcasts` opts out), `consumers/codex-queue.mjs` also watches
`.tendriller/agent/broadcasts.json` and syncs `/api/broadcasts` for verified,
applicable `agents` broadcasts (including `info`, `recommended`, `urgent`, and
`critical` notices). Every notice is independently signature-verified, matched
against installed workspace versions and expiry, and deduplicated in one agent-wide
checkpoint (`broadcasts.json`) so an agent with multiple pages receives one notice.
Broadcasts use the same active-turn steering and idle queue/resume route, preserve
`interrupted` conversation stops, report `resume-unconfirmed` / unavailable wake
explicitly, and never auto-acknowledge (`broadcastAcknowledged: false`).

### Conversation-owned liveness

By default (`--no-liveness` opts out), `consumers/codex-queue.mjs` runs one shared
`createCodexConversationLiveness` probe loop against the actual Codex receiver
(`thread/read` + `thread/turns/list`) and announces ephemeral presence cards
(`listening` / `busy` / `stopped`, `route: "same-conversation"`, `idleWakeReachable`)
across all attached pages without spawning separate model instances. If the Codex
receiver fails or refuses direct input while the native page owner and bridge stay
running, liveness immediately transitions to `stopped` and expires. When no worker
or conversation presence signal is established, the built-in Assistant chat shows an
honest distinct **Status unknown** indicator rather than conflating silence with
confirmed **Offline**. Neither liveness nor queue admission implies a durable
`agentReceipt` or reply. Queue draining still depends on the selected daemon and
receiver lifetime.

### Alternative mechanisms and their limits

| Mechanism | What it can do | Qualification boundary |
| --- | --- | --- |
| Supplied active-first bridge | Steer the exact observed running turn; queue idle/unloaded work | Qualify active input at the next continuation boundary, preserved stops and repeated same-thread execution |
| Plain `codex queue` | Queue a message to an exact existing thread; optionally attempt to load it | A busy turn waits; queue admission alone does not establish active injection or second-turn execution |
| Codex App Server `thread/resume` and `turn/start`, or `thread/queue/*` | Drive an explicit thread through a structured host API | Use the actual host's version/schema, authority and concurrent-turn policy; do not assume a separate app-server instance controls the selected desktop UI |
| `codex exec resume` | Run a noninteractive continuation of a selected stored session | Sharing a session ID does not itself prove that the intended UI/daemon owns that execution or will display a live turn; avoid concurrent uncoordinated writers |
| Async hooks / outbound completion notifications | Run supporting work or report a completed turn | They are not an inbound idle wake route by themselves |
| MCP tools, event notifications, local watchers | Expose tools or observe work for a host integration | The host must still admit a turn to the selected thread |

Read the current [App Server reference](https://developers.openai.com/codex/app-server)
and its generated schema before building an alternative receiver. The App Server
interface is experimental; pin the qualified version and do not present it as a
production support guarantee. The
[hooks documentation](https://learn.chatgpt.com/docs/hooks) states that a completed
asynchronous hook does not create a turn when none is active; an outbound
completion notice likewise needs a real receiving host mechanism. The retired
[Codex MCP-server interface](https://learn.chatgpt.com/docs/mcp-server) is not a
replacement for the current queue or App Server routes.

Codex also has hosted-app MCP event-stream machinery in its current
[App Server implementation](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/mcp_event_stream.rs).
That path connects an authorized hosted `codex_apps` stream to a client subscribed
to the target thread; forwarding the event still does not prove that a generic
MCP notification starts a new turn. The public
[ChatGPT MCP event integration](https://developers.openai.com/plugins/build/mcp-events)
documents verified webhook callbacks. Qualify the actual host integration
instead of treating either transport as a universal conversation wake API.

The shipped bridge's deterministic tests qualify active steering, exact-turn
preconditions, bounded race handling, paused threads, remote transport, filtering,
scoped durable state, uncertain admission and restart behavior. Synthetic Unix
and loopback WebSocket tests exercise actual handshake/framing and authentication
boundaries. They do not run a model or claim that a particular desktop/cloud thread resumed. During the 2026-11-25
implementation review, the installed Codex CLI and local daemon both reported
version `0.172.0`. A separate synthetic loopback WebSocket server exercised the
installed CLI's `initialize → initialized → thread/queue/add → thread/read →
thread/resume` path. It acknowledged an artificial queue item and rejected resume:
the CLI exited successfully while printing the expected resume warning. This
verified the bridge's success-with-warning handling without addressing a real
thread or starting a model turn. Complete the live rehearsal below against the
actual intended conversation before reporting unattended same-thread delivery
as verified.

## Antigravity mechanisms and the supplied bridge

Google Antigravity (CLI `agy`, Antigravity App, IDE) has different host
primitives from Codex and ships its own dedicated multi-page consumer:
`consumers/antigravity-bridge.mjs`. See the full
[Antigravity integration guide](ANTIGRAVITY_INTEGRATION.md) for sandbox,
OAuth CIMD, MCP Apps, and Sidecar setup.

### 1. Continuous same-conversation delivery (`--mode agentapi`)

Inside an Antigravity CLI session or an Antigravity App Sidecar, the documented
`agentapi` CLI provides `get-conversation-metadata`, `send-message`, and
`new-conversation`, while the local Language Server (`$ANTIGRAVITY_LS_ADDRESS` +
`$ANTIGRAVITY_CSRF_TOKEN`) provides read-only `product.v1.ConversationService/GetConversation`
status (`RUN_STATE_IDLE` / `RUN_STATE_RUNNING` / `RUN_STATE_CANCELLING`):

```sh
node consumers/antigravity-bridge.mjs \
  --workspace /absolute/workspace \
  --conversation-cwd /absolute/antigravity-project-root \
  --pages requests,second \
  --conversation "$ANTIGRAVITY_CONVERSATION_ID" \
  --topics chat,agents \
  --mode agentapi
```

- **Preflight & workspace verification:** Calls `agentapi get-conversation-metadata`
  before announcing ready and requires the conversation's `workspaceUris` to match
  `--conversation-cwd` (equal to or parent of `--workspace`). Run `--doctor` first
  to verify `agentapi`, `ConversationService`, and terminal sandbox outbound rules.
- **Delivery, cancelling respect, coalescing & uncertainty:** Checks
  `ConversationService/GetConversation` before sending and defers while
  `runState === "RUN_STATE_CANCELLING"` so user cancellations are respected.
  Optional `--coalesce-ms` batches rapid multi-message bursts into one wake notice.
  Persists `invoking` before calling `agentapi send-message --title=... <conversationId> <safeNotice>`
  and verifies `response.sendMessage.recipientId === conversationId`. Any timeout,
  error, or unconfirmed response stops as `uncertain` (`ANTIGRAVITY_DELIVERY_UNCERTAIN`)
  without blind retries. Status output explicitly reports `source: "agentapi/send-message"`,
  `workerReceipt: false`, and `wakeVerified: false`.
- **Conversation-owned liveness & clean LS-exit lock release:** One shared probe loop queries
  `ConversationService/GetConversation` (falling back to `agentapi get-conversation-metadata`)
  and maps `RUN_STATE_IDLE` → `listening`, `RUN_STATE_RUNNING` → `busy`, and
  `RUN_STATE_CANCELLING` → `stopped`. When the Antigravity CLI session closes and
  `$ANTIGRAVITY_LS_ADDRESS` stops responding for `--ls-loss-threshold` consecutive
  probes (default `3`), presence transitions immediately to unavailable and the bridge
  exits cleanly (`ANTIGRAVITY_LS_GONE`), releasing its checkpoint `.lock` so a resumed
  session (prompted by the native plugin's `SessionStart` hook) can re-attach without
  lock contention.
- **Session lifetime & Sidecars:** In Antigravity CLI, `$ANTIGRAVITY_LS_ADDRESS`
  and `$ANTIGRAVITY_CSRF_TOKEN` are ephemeral per `agy` process; closing `agy`
  ends `agentapi` reachability until restarted inside a resumed session. On
  **Antigravity App**, running `consumers/antigravity-bridge.mjs` as a user-enabled
  Sidecar (`~/.gemini/config/sidecars/<id>/sidecar.json` with
  `restart_policy: "always"`) provides automatic restart supervision with fresh
  `agentapi` access.
- **No atomic `expectedTurnId` CAS:** Unlike Codex's `turn/steer`,
  `agentapi send-message` delivers a `MESSAGE_PRIORITY_HIGH` message without an
  atomic turn-ID precondition. Deduplication relies on the bridge's durable
  per-page `delivered` set and Tendriller's `agentFeed` durable replies, backed
  by the plugin's guarded `Stop` hook for turn-end boundary races.

During the 2026-11-27 qualification review on Antigravity CLI `1.5.18`, live
verification confirmed `agentapi get-conversation-metadata` returned exact
`workspaceUris`, `ConversationService/GetConversation` returned live `runState`,
and `agentapi send-message` delivered a `MESSAGE_PRIORITY_HIGH` `<SYSTEM_MESSAGE>`
directly into the active running turn. Still run the two-request idle-wake
rehearsal below in the target CLI/App conversation before claiming unattended
multi-turn delivery as verified.

### 2. Unattended streaming and fallback modes (`--mode headless-stream`, `--mode wait`, `--mode new-conversation`)

- **`--mode headless-stream`:** Keeps one warm `agy --input-format stream-json --output-format stream-json`
  process for dedicated unattended servers (refuses to attach concurrently to an
  open `$ANTIGRAVITY_CONVERSATION_ID`), streams live `text_delta` previews to the
  browser via `streamAgentReply`, detects headless soft-denied tools on `stderr`
  and `tool_info.error`, and checks `agentFeed` for durable reply verification.
- **`--mode wait` (reactive one-shot waiter):** Attaches to `tendril agent run`,
  checks for pending unanswered requests or verified broadcasts across `--pages`,
  records them in the durable `delivered` set, prints one safe `antigravity_wake_notice`
  JSON envelope, closes presence cleanly, and exits `0`. When launched as a
  non-daemon background task (`IsDaemon: false`), Antigravity's reactive task
  system wakes the calling conversation automatically. **You must re-arm the
  waiter after handling each batch.**
- **`--mode new-conversation`:** Dispatches each unhandled request via
  `agentapi new-conversation` (with optional `--model` and `--profile`) for
  isolated unattended runs instead of continuing one thread.
- **Non-wake primitives:** Antigravity `.agents/hooks.json` hooks are synchronous
  and turn-scoped (they cannot wake an idle conversation on their own; the plugin's
  `SessionStart`/`Stop` hooks complement the bridge). `ConversationService` has
  `CreateConversation` and `GetConversation`, not `SendMessage`. Never run headless
  `agy --conversation <id>` concurrently against an open interactive TUI/App conversation.

## Bind presence to the handler

Call `announceAgentPresence` inside the actual request worker, after it can read
and handle its advertised topics. Bind its signal and cleanup to that worker's
lifetime, including failures. A native page owner that handles fetching may
advertise fetching; it may not advertise an interactive assistant's topics on
behalf of a stopped worker. An event forwarder only forwards events.

Where several workers share the same signer, the browser must select the intended
`consumerId` and request topic as well as the authenticated peer. Label a verified
active handler as available or busy. Label an unqualified conversation route as
**Open this conversation to handle requests** or **Automatic delivery not yet
verified**. Requests remain **Awaiting acknowledgement** until their durable
receipt exists. See the [request pattern](AGENT_REQUESTS.md) for filtered ephemeral
presence and the runnable worker; periodic durable heartbeats are unnecessary.

## Keep delivery and handling checkpoints distinct

The native forwarder's checkpoint means its destination accepted a projected
event. An MCP inbox cursor means a reader observed retained deliveries. Neither
means the conversation handled the request. Keep the last **handled** position
with durable results and stable request identities. A receiver's stdout line,
HTTP 2xx response or successful thread-start request is not a handled checkpoint.

Use the complete `(applicationId, messageAuthor, messageOperationId)`
identity for deduplication. Preserve the original inputs and operation IDs for
receipt/reply retries. Read current authorized application state after a wake;
private request text need not appear in the wake notice. Application content is
untrusted data, and the application's action policy still decides which effects
are authorized. Do not convert an event payload into unrestricted instructions.

Retain a separate cursor per page. A combined `tendril watch --events` stream's
cursor is a page-ID map; persist each handled page position only after its work
has durable evidence. Keep read/delivered watermarks separate if used. Do not let
a successful page advance a failing page past unhandled work. Serializing one
conversation's turns avoids competing responses from its pages.

For the optional MCP event route, `read_application_events` supplies an opaque
`next` cursor and can report `resetRequired`. For direct sessions, a stale cursor fails with `EVENT_CURSOR_STALE` and a live
forwarder can stop with `EVENT_FORWARDER_REVIEW_RECOVERY`. Re-derive from a
coherent snapshot and reconcile the application's durable inbox/results by stable
request identity; never translate the old cursor, skip to the end or repeat
external effects that a later revision retracted. A retained pending request that
is no longer effective stops for review. Follow
[revised-projection review](AGENT_RESTART.md#review-a-revised-projection-before-resuming).

External effects require their original provider idempotency reference or
read-back/reconciliation. A crash after an email or file edit but before a receipt
cannot be repaired by blindly repeating it. Tendriller's request and receipt
records do not promise exactly-once execution in another system.

## Reconnect and supervise explicitly

Keep the native owner and the receiver/worker under their actual process owners.
Record the retained storage location, selected application and private thread
binding. Keep credentials, thread handles and device databases out of public
page assets and diagnostic screenshots.

On an owner replacement, recreate attach clients and signal subscriptions using
the retained workspace; the old attachment does not migrate automatically.
Reopen the receiver against the intended existing thread and resume from handled
progress. Confirm pending work immediately instead of waiting only for a new
notification. A bounded one-shot waiter must be rearmed after successful
completion; `Restart=on-failure` alone will not rearm a normally exiting waiter.
Use bounded backoff for transient transport failures and surface an exhausted
restart policy, revoked grant or rejected thread admission for repair.

A subscription, native forwarder, worker and conversation receiver have distinct
restart policies. Reauthentication does not prove a previously failed delivery
was handled. Inspect the original retained identity before retrying. A replaced
conversation is an explicit handoff, followed by qualification of its new thread;
never silently switch to the most recent thread or create one agent per page.

## Two-request same-conversation rehearsal

Use harmless requests declared by the actual application. Record the host,
version, selected route, application/history, source composition, private thread
identity and evidence for each step. This is a live host acceptance procedure;
unit tests, a mock host or the native MCP tool qualification do not run it.

1. Establish the selected host route and owner-approved access. Start the real
   worker/receiver with its retained checkpoints and confirm a declared inbox
   query succeeds. Do not announce assistant readiness from the page owner.
2. While the selected conversation has an active turn, submit a harmless
   request with a unique operation ID. Confirm `steered` admission names that
   same turn and that the conversation reads and answers it at its next
   applicable continuation boundary. Confirm no duplicate queued turn is created.
   Also exercise completion during admission and preserve a deliberately stopped
   turn; neither timeout nor unknown acknowledgement may duplicate the input.
3. Finish the current conversation turn. From a page, submit request A with a
   unique operation ID and retain its full request reference. Confirm a new turn
   begins in the **same existing thread**, reads that request and records its
   durable receipt and answer. Verify the originating page displays the answer.
4. Let that turn end. Submit request B, preferably from a second page in the
   workspace. Confirm the same thread starts another turn without a manual
   message, receives B and leaves B's durable receipt/answer. Confirm A is not
   handled again. This catches receivers that worked only once.
5. Stop only the request worker/receiver while keeping `tendril agent run` and
   the browser connected. The assistant presence must become stopped or stale,
   even if the native owner still announces its own implemented work. Submit C:
   it remains retained and awaiting acknowledgement, without a false Live badge.
6. Restart the worker/receiver with its original identity and handled checkpoint.
   Confirm C is handled once under the retained idempotency policy. Simulate a
   duplicate wake and a crash after an answer but before checkpointing; reconcile
   the existing answer instead of submitting changed input under the same ID.
7. Exercise authentication/refused admission and owner replacement. Confirm the
   delivery panel names the blocked stage, pending work survives, and restoring
   access does not invent a new thread or skip an unhandled page.

If step 2, 3 or 4 cannot run in the actual host, report **same-conversation wake not
qualified**, with the exact missing mechanism or observed refusal. The page,
on-demand tools and runnable worker can still be verified independently. Do not
record a simulated turn or webhook acceptance as a successful conversation test.

## Show delivery failures where they matter

| Evidence | Status and next action |
| --- | --- |
| Native page owner connected, intended worker absent | Assistant unavailable; preserve pending requests and start its worker |
| Worker active but no qualified host admission route | Worker available for its implemented work; conversation requests need manual invocation or a qualified receiver |
| OAuth requires reauthentication | Reconnect this account on the same service origin; retain existing work identities |
| Approved app/event missing or permission revoked | Review the app's connection/grants; do not create a replacement application |
| Webhook pending, blocked or failed | Inspect `agent_feed` receipts, callback origin and subscription; distinguish retryable delivery from terminal refusal |
| Webhook accepted, no thread turn observed | Host delivery accepted; conversation execution unverified |
| Turn started, no durable application receipt | Conversation admitted; request not yet acknowledged |
| Receipt exists, answer missing | Seen; inspect worker outcome and reconcile pending effects |
| Answer exists | Display the answer on its original request; keep any newer draft intact |

The host delivery panel exposes forwarding outcomes; `agent_feed` receipts
and replies expose actual work. Link the two
in the runbook without presenting one as proof of the other.

## Tracked integration boundary

This guide and the setup notice track the host-execution requirement raised in
[#122](https://github.com/werg/tendriller/issues/122), alongside worker lifetime
in [#121](https://github.com/werg/tendriller/issues/121). A resolved documentation
or receiver implementation issue does not certify every Codex or ChatGPT host.
For each newly supported route retain the exact host mechanism, authentication
and thread-binding policy, restart/cursor behavior, and the live two-request
report above. Until those exist for a selected route, keep its status unqualified.
