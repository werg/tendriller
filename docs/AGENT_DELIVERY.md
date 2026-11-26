# Deliver a running application

A request to build an app includes setup, signed publication, real device-owned data, offline use and verification. Source files, an installed adapter, a native process alone, or an HTML preview do not complete it. Begin at [Build an app](BUILD_AN_APP.md); select existing [capabilities](CAPABILITIES.md) and [patterns](APP_PATTERNS.md).

## Start provisioning early

Read the exact service's `/api/service`, discovery and `/api/readiness` before package acquisition. Continue only with open creation readiness; stop on a pause or unavailable readiness and keep the same origin. Register the workspace agent once (`tendril workspace init` with the owner's verified email, `workspace join` with a dashboard code, or MCP `register_agent` plus `workspace adopt`; see [Build an app](BUILD_AN_APP.md)). The workspace holds one agent credential, one signing key and one wrap key for every page. Create each page with `npm run page:new` (the creating agent is granted it automatically); an existing page needs the owner's explicit per-agent grant (dashboard checkbox or the page's **Add people & devices → An agent**). Retain the private workspace (`.tendriller/`) across lost replies. The host derives the verified owner.

Choose finality/availability semantics explicitly (`none` by default), prepare the publisher policy (signed by the workspace's one shared signer, an independent right from data access) create the page keys as the agent (`npm run init`), and publish the complete signed UI before owner sign-in. Start `npm run agent`, then give the human the ready page URL without asking for a claimed reply. They perform their own sign-in; the host attests the browser's keys for their account and the agent admits it and wraps its keys. Additional devices, strict-mode approval and invites use the same admission; see [membership](MEMBERSHIP.md#admission).

## Browser and optional process lifetime

The browser's owned signer/store can durably author with no peer, agent program or finalizer. Cached local authority/identity/data open before remote refresh/discovery. Live synchronization requires participating devices/routing to be available, and admitting a new device requires one online member holding the keys (the agent program, or an admitted device); stopping them does not revoke an admitted browser's local Save capability.

The workspace's optional local program is:

```sh
npm run agent        # tendril agent run
```

It holds one hub connection to the host for every page's control traffic (setup notices, discovery, invitations, rendezvous, assistant adapter) and opens one Chronolog session per initialized page, each with its own device store, the agent's shared signing key and wrap key, and an admission controller that admits the owner's browsers and keeps keys wrapped. Page sync data (WebRTC, relay) keeps per-page connections and never uses the hub. Start it in the supported execution environment and retain enough process information to monitor, stop and restart it; the private workspace must survive future invocations. CLI queries, commands and publication attach to it with `--page <slug|id>`; an unavailable program is `OWNER_UNREACHABLE`, never a reason to open a second signer. UI publication attaches through an explicitly authorized [publication binding](tools/CLI.md#publication-capability-and-retained-bindings). For an agent integration, connect the session's public application tools and changes (`createApplicationTools`, `serveApplicationToolLines` from `@chronolog/peer-session`) to the agent's actual execution loop; merely printing changes does not make an LLM respond.

Report the program's PID/process manager, start command, retained state location and stop/resume behavior only when actually established. A detached child may die when the execution environment ends. Do not call it permanent, resident or resumable merely because an adapter is installed. Root locks protect one physical profile, not global data order.

A configured finalizer can be browser/native/host placed under the same proof contract. Report actual tested provider availability separately from policy configuration. Its absence may delay finality, never local authoring/provisional reads. Explain sealed-time exclusion of unseen offline work and preserve excluded original intents visibly.

The page owner, request worker and conversation receiver have separate lifetimes,
even when they share a machine or signer. Bind `announceAgentPresence` and any
optional startup/stop checkpoints to the actual worker and only its implemented
topics. An owner that syncs data or fetches mail cannot advertise a stopped
interactive assistant. Match `consumerId` and request topic as well as the peer
in the browser. Use the [runnable request worker](AGENT_REQUESTS.md#run-a-supervised-consumer-with-a-handled-checkpoint)
for a supervised loop with durable handling/checkpoint evidence.

## An existing conversation

Read [same-conversation delivery](CONVERSATION_DELIVERY.md), available through
`tendril_guide` with `topic: "conversation"`, during setup. It maps actual host
mechanisms, per-page handled checkpoints, authentication and failure visibility.
For Codex, first qualify a real request arriving during a running turn: it must
reach that same active turn through `turn/steer`, without waiting for completion.
Steering adds input for the next applicable continuation boundary; it does not
preempt a running tool or bypass approval.
Then qualify idle wake with a real request after the turn ends and another after
the answering turn ends. The receiver uses queue/resume only when the thread is
idle or unloaded; plain `codex queue` alone waits while a turn is running.
A one-shot waiter or accepted steer/queue/webhook does not establish actual
handling. Preserve explicit interruption and report admission failures.

Page residency, a durable operation set, an optional MCP gateway, hibernating sockets and retained inboxes do not establish supported future wake or handoff to an existing ChatGPT/other assistant conversation. Say which actively running process observes work. Do not imply conversation execution after it ends.

## Evidence in the final handoff

Provide the ready page URL and concise evidence:

- Actual page URL, application identity, owner claim status and the workspace agent (one credential, one signing key, one wrap key) that maintains it.
- Verified signed publication ID/receipt and exact package/source composition tested.
- Page keys created by `npm run init`; the owner's first browser admitted by the running agent after sign-in (or, on a `--browser-first` page, created by that browser).
- A real command acknowledged **stored locally**, then its coherent **materialized locally** result (revisable).
- Offline graph acknowledgment, disconnect, offline CRUD and reload retaining identity/drafts/operations.
- A second genuinely separate profile/device shown waiting, then admitted with a **New device signed in** notice on the first; both replicas converge from authenticated operations. Remove device stops it receiving new changes under the rotated key.
- Authenticated peer retention evidence, separately from execution. Configured finality is `none`, pending, verified finalized, or excluded as actually observed; never report fake finality.
- Late earlier state/schema/outcome revisions and preserved draft/focus/deep links.
- Actual browser and optional agent-program/provider lifetimes, private-state resume path and explicit untested boundaries.

No plaintext keys/private host handles enter authored assets, screenshots or shared reports. Production deployment is a separate action. When blocked, name the exact prerequisite and next action from [troubleshooting](TROUBLESHOOTING.md), complete safe setup already possible, and report the missing verification honestly.

## The user experience is part of the deliverable

### Run a separate second pass

The supported [local host](LOCAL_HOST.md) runs an exact sealed release with its matching packages, synthetic owner and separate development identity. Use the same application source and seed representative data through its real commands; production OAuth and owner sign-in do not block this connected UX pass. Record the tested release/publication and distinguish that development evidence from later production authorization and connectivity checks.

After the first working version, use this dedicated prompt:

> Act as a first-time user at desktop and 320px phone width in fresh browser profiles. Exercise every domain flow without reading implementation code. Find observed friction in local opening, sign-in/device admission, offline Save/reload, domain navigation/editing, revisable operation facts, schema changes and optional feature availability. Verify keyboard/focus, Back/deep links, long content and cancellation. Fix concrete observed problems and retain before/after screenshots. Do not replace domain views with storage forms or treat transport tests as UX completion.

| Flow | Required observation |
| --- | --- |
| Fresh owner | Signed UI already published; with the agent program running, sign-in is admitted automatically, showing only a short waiting state (no approval screen or pasted data); a reload and a second tab reopen locally; no extra ordering approval |
| New second profile | Waiting state honest while no member is online; admitted and keyed automatically; New device notice on existing devices; strict mode holds it for Approve; Remove device ends its access |
| Invites | Email/single-use/public link created, copied once, redeemed in another account; revoke and expiry honest |
| Local Save | Enabled by local signer/store prerequisites even with zero peers, stale view, unavailable agent/finalizer |
| Offline reload | Complete immutable graph saved; identity/keys/data and separate unsent drafts remain |
| CRUD/list/detail | Stable entities update/move/disappear; derived counts/detail recompute; selection and local editor remain distinct |
| Concurrent/late earlier work | Current success/rejection/events revise; original intent remains inspectable; no silent retimestamp/new ID |
| SQL DDL/permissions | Ordinary authorized CREATE/ALTER/DROP and grants; schema-only invalidation; missing query labels last snapshot not current; unrelated authoring survives |
| Operation inspector | Stored/materialized/retained/finalized/excluded separate; exact original retry; no ambiguous success label |
| Optional features | Agent-only tools/analysis unavailable locally without disabling edits; explicit media consent/cancellation |
| Optional finality | None/pending/certified/excluded honest; browser provider tested without native; closure warning and complete proof/dependency boundary |
| Navigation/accessibility | Deep links, Back, keyboard, focus, scroll and long text at desktop/320px; no horizontal page overflow |
| Lifecycle/errors | Loading/empty/stale/error states; abrupt owner/process restart, uncertain reply and same-intent retry; device locks retained |

Capture before/after screenshots for fixed friction and name the exact flows/viewports exercised. Static previews, source-only tests and deterministic provider fixtures do not establish live OAuth, Internet NAT, physical mobile execution or real inference-provider behavior.

## Verify consumers after a release or restart

Re-run public-package Workerd, browser, RTC/relay, SQL native/WASM and first-app composition gates against the exact new graph. Historical successful receipts do not qualify this protocol. Do not keep an old ordering path, compatibility reader or migration layer to satisfy old tests. State exact commands run and their limits. Preserve existing private device state; an artifact mismatch never authorizes deletion or an unrequested production rollout.

Follow the [re-arm checklist](AGENT_RESTART.md) after republishing or replacing the
native participant. For apps with a request consumer, verify its actual worker
presence and request/receipt/answer flow using declared capabilities; report missing
liveness/receipt support rather than inventing commands. Stop the worker while the
native participant stays connected and confirm its assistant indicator becomes
stopped or stale; pending requests remain visible. An unrelated fetch worker must
not refresh that indicator. `applied` and peer connectivity alone do not establish
that an agent read work. Use the [request lifecycle pattern](AGENT_REQUESTS.md) when
a new domain needs worker-owned ephemeral presence and durable addressed answers.
