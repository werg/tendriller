# Build a Tendriller application

**The deliverable is a running hosted application connected to the user's work.**
Check the selected service's `/api/readiness` before installing or provisioning.
Continue new-app setup only when creation is available; otherwise report the
same-origin next action. Initiate provisioning, configure the session, publish
the first signed UI and
start the participant before asking the owner to sign in. Read
[delivery and process lifetime](docs/AGENT_DELIVERY.md); source files alone do not
establish the requested result.

**Start with [Build an app](docs/BUILD_AN_APP.md)** and the
[capability map](docs/CAPABILITIES.md). The guide takes you from a service
domain to a small application with durable state, a native session, an enrolled
browser Worker and a signed publication. Use its complete files first, then adapt
the commands and UI to the user's task. The [session bootstrap](docs/SESSION_BOOTSTRAP.md)
explains the setup code. This page is the concise workflow and contract reference.

For several views or agents, use [multi-participant composition](docs/MULTIPARTICIPANT.md)
and [scoped agent bindings](docs/AGENT_BINDINGS.md). Browser pages attach to one
retained owner; native tools attach or deliberately choose a separately enrolled
profile. Shared observation does not assign work: use explicit recipients and
guarded claims. Keep per-view drafts and full original operation references.

## If you arrived through MCP

Call `tendril_guide` with `topic: "start"` for the same-origin
[MCP app-building and connection route](docs/MCP_AGENT_GUIDE.md). The tool returns
maintained documentation without requiring browsing. An empty `list_tendrils`
means no assistant-connected apps for this account, not a missing plugin. For a
new app, use the build guide and HTTP creation route below; check the native
execution environment and actual process lifetime. For an existing app, connect
its existing participant. The account-linked MCP does not execute a newly
created application's code by itself.

## If the user gave you only a domain

1. Read that origin's `/api/service` for its contract/release and
   `/.well-known/tendriller.json` for the first-app guide and machine-readable route.
   Before downloading or installing packages, require matching-origin open
   creation readiness from `/api/readiness`; stop on a pause, unavailable or
   unsupported readiness. The build guide verifies the immutable
   `firstApp.release` kit and its local packages against this host's identity.
   `/llms.txt` is the ordered index; `/llms-full.txt` is the combined onboarding text.
   Search `/.well-known/tendriller-capabilities.json` for the task's state, refresh,
   media, voice and preview needs before implementing equivalent plumbing.
2. Follow **create → define state → configure authority and the first
   generation → publish → owner sign-in → connect devices → verify** in the build guide.
3. With an account-linked MCP connection, run `setup:prepare`, call
   `prepare_tendril_setup` with its public arguments, and use `setup:finish`
   to reconstruct the private handle from the exact ready result. The server
   derives the verified owner; preserve the private original intent and call
   `inspect_tendril_setup` after a lost reply. The direct-domain route without account-linked creation
   asks for the actual owner's verified email. Create the real page early,
   initialize and publish its first version, start the participant, and
   prepare any assistant-access proposal before giving the owner the ready URL.
   Do not wait for claim or ask for a "claimed" reply. The owner opens the ready
   page and signs in; explicit browser enrollment and assistant consent follow.
   Use the browser's retained-key pairing request and the same running native
   owner. Its bounded helper pauses ordering and stages the exact signed
   proposal before owner review. Preserve uncertain requests and their durable
   pause across restart; approve only the complete displayed proposal.
   Do the setup in the agent's
   supported runtime and preserve it so later invocations can resume.
4. Finish only after a browser command is visible in a native read, a native
   command reaches the browser, reload retains state, and the selected signed
   publication matches the built UI. Lead the handoff with the working page,
   receipt and running process/resume details. Report any part you could not verify.

## Reuse the supplied implementation

Start from the verified first-app kit and actually import or adapt its session,
reactive-view, operation-view, reviewed-input, camera and voice modules. The
[pattern guide](docs/APP_PATTERNS.md) and [media/inference example](docs/AI_INPUT.md)
identify those files. Record which current implementations you used; reading
contrib cookbooks without applying their public APIs is not integration evidence.

Use `tendril-preview ./page` as soon as the authored UI exists. Static preview
checks layout. Live preview needs an actual authored bootstrap and real enrolled
session; see [Preview](docs/tools/PREVIEW.md). Verify the tutorial's connected
behavior on its published page, whose authentication and device origin are real.
Neither a static preview nor an independent local database qualifies the hosted app.

Use the supplied service origin throughout. Examples using `https://tendriller.dev`
must target the requested host when working on staging or a self-hosted instance.
The public SDK and session packages are prerelease artifacts: follow the build
guide's acquisition and version checks instead of assuming npm package names
alone identify an installable compatible release.

## Choose the native application path

For a shared checklist, notebook, dashboard or agent interface, define state and
commands in Chronolog and build the browser UI around that same application.
Tendriller supplies authenticated hosting and control/discovery; Chronolog supplies
application persistence and peer exchange. Evaluate that path before choosing a
separate database or backend. If an external service is needed for a specific
capability, explain the requirement and keep application state ownership explicit.

A page URL, a host token, an application ID and a device signing identity are
different things. Creating the page does not create its command implementation,
device grants, first generation, connected session or selected code release.

The agent needs an environment that can run the native session. The browser needs
its own Worker and authorized device. The Tendriller host does not run an
always-running agent; its account-linked MCP supplies build/setup guides and
routes approved application tools to enrolled participants. For explicit supported
event subscriptions, a mounted assistance card or a separate Workspace Agent
route, use the optional
[ChatGPT integration](docs/CHATGPT_INTEGRATION.md#agent-walkthrough). Check for a
shared plugin first, then guide the person through workspace setup and their own
account link. Attach `@tendriller/core/assistant` to the existing application
participant and give the owner the real consent URL. Keep that participant
available for remote calls. It cannot wake an
arbitrary ordinary chat. Keep the selected participant/agent processes running
and report their restart state. If that environment is unavailable, choose the
guide's native-tool or manual-handoff fallback and name the exact prerequisite.

Use [troubleshooting](docs/TROUBLESHOOTING.md) at the failing stage. In particular,
`peer_application_unconfigured` means configuration is missing; an unavailable
browser backend means its session bootstrap has not completed. Neither is evidence
that the platform needs a parallel persistence layer.

## Platform responsibilities

Tendriller hosts the page and joins its Chronolog protocol as a light control participant. Open one Chronolog application session for application work. The host receives only the control, publication and introduction updates allowed by its transport policy.

## Create and claim the page

Read `/api/service` to check the host contract and limits. Create a page with `POST /api/tendrils` and an owner email:

```json
{"owner":"owner@example.com","name":"Shared work"}
```

The result includes `page_url`, the agent `api` and token, and `application:{id}`. The generated application ID is a stable 32-byte lowercase hex identity, independent of the page ID. Supply `application:{id}` explicitly when binding a known application. There is no backend or profile selector.

Use the private setup handle to initialize and publish before claim. Then give
`page_url` to the human owner; they sign in to open the already-published page. Agent credentials cannot claim a page for them. An unclaimed page expires after 24 hours. After claim, explicit host lifecycle operations may make it resident; residency retains control and code without a continuously running application process.

## Configure authority and open the application

Use the public SDK's `createClient(handle, {applicationId: handle.application.id})`. The host SDK has `peers`, `request`, `info` and `service`. Its construction starts no traffic.

Configure the initial descriptor through `host.peers.configureApplication`. Provide the immutable public application definition, execution-manifest digest, schema administrator, initial epoch/key digest, and enrolled device grants. SQL applications also provide their signed schema. The host validates the definition/schema bindings and retains the signed authority. Application identity exists before configuration; reading unconfigured authority reports that state explicitly.

**Select the first generation before opening the application.** Configuration
returns the descriptor and initial control revision with no selected generation.
The bootstrap prepares and durably saves an authorized signed transition with
`reason: 'create'` and `expectedGeneration: null`, then submits that exact request
through `host.peers.selectGeneration`. Refresh and verify the returned authority.
Do not recreate keys, identity or transition IDs when resuming a partial setup.
The complete [bootstrap](docs/SESSION_BOOTSTRAP.md) covers this missing connection
between configuration and session opening.

For ordinary browser enrollment, use the starter's challenge/proof, native
preparation, service-origin owner review and exact signed commitment. The
browser retains its own key; account sign-in grants no device rights. For a
deliberate manual enrollment, the authenticated agent's `host.info()` includes
`owner_account_id` (`null` until claimed). Use it as an explicit account binding
only for a separately verified device belonging to that owner.

Chronolog owns the device signer, local byte store, database, operation journal, peer connections and replication. Use its native or browser Worker session entry for your environment. Bootstrap from the host's public definition and authority, pin the descriptor, and verify all signed evidence through Chronolog. Keep browser execution and replication in the owned Worker.

Connect the host to the session through the common participant transport:

```js
const control = session.connectControlParticipant({
  exchange: (message, options) => host.peers.exchange(message, options),
});
```

Install the session's one participation controller with the host introduction adapter:

```js
import { createPeerIntroductions } from '@tendriller/core/peers';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
const participation = await session.participate({
  control,
  ...createPeerIntroductions({
    peers: host.peers,
    identity: session.deviceId,
    openDirectConnection, // The native or owned Worker raw RTC opener.
    openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
  }),
});
```

The session owns discovery, connection retries, authentication, reconnect grace, candidate policy and recovery. Each host-adapter attempt tries direct RTC, then the opaque WebSocket relay after direct failure or its five-second budget. Both use the same authenticated encrypted peer channels and application session. Use the controller's status to show connection progress and any exact recovery proposal requiring approval. Do not add application-level election or retry loops. See [peer participation](docs/PEER_CONNECTIONS.md) for the environment openers and lifecycle.

Ordinary commands, queries, signals and replication require no host control call. Direct traffic bypasses the host; relay traffic consumes host bandwidth and requires the relay to remain available. Coarse availability-lease renewal is separate lifecycle traffic, independent of application edits.

## Compose the browser runtime

The default entry supplies `window.tendril`. Install the one matching application backend and the session's live signals:

```js
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';

const backend = createApplicationBackend({
  id: session.applicationId,
  session,
});
tendril.application.install(backend);
tendril.signals.install(session.signals);
```

The optional `eventCommand` setting is only for an event-publication command
actually declared by your domain. Shared Notes does not declare `publishEvent`;
adding that name to its adapter would fail with `APPLICATION_EVENT_COMMAND_UNKNOWN`.

`ready()` and `available` on the application binding describe installation. Use `session.status` and its subscriptions for actual connection, generation and recovery state. The session's `deviceId` is the signing identity; the page runtime creates no additional device credential.

A separately composed page may call `startRuntime(configuration, {application: backend, signals: session.signals})` from `@tendriller/runtime/kernel`. That kernel mounts no UI and starts no transport. Both compositions use the same application contract.

## Commands, live signals and recovery

Use the least durable mechanism that fits the task:

| Need | Mechanism |
| --- | --- |
| Local drafts, focus, scroll | Page-local state |
| Live presence, previews, progress | `session.signals` or the installed signal binding |
| A retained change and emitted facts | A declared application command |
| A coherent query/event read | A captured applied read view, released after use |
| Operation progress | Original operation identity and operation-state inspection |
| Recovery after unavailable data | Explicit selected-generation recovery and loss reporting |
| External side effects | A declared policy, protected prerequisites where needed, and provider reconciliation |

Preserve the caller's operation ID and exact signed attempt on uncertain replies. `saved` means locally durable work; `applied` identifies an outcome in a selected generation. `shared` reports retained coverage separately. Recovery can abandon a recent suffix. Show `abandoned` and `needsReapply` explicitly; reapplication uses a fresh reviewed attempt with current guards. Never silently merge an abandoned branch or reinterpret a read view as finality.

## Publish code through Chronolog

Prepare a complete manifest with canonical sorted file paths, content hashes, sizes and media types. The entry is an authored HTML file. The session's control participant saves the signed intent before returning it:

```js
const signed = await control.preparePublication({
  operationId: 'release-2026-11-17-a',
  entry: 'index.html',
  files,
});
const receipt = await control.publish(signed, assets);
```

Each asset is `{hash, bytes}`, with canonical base64 bytes. The signed manifest binds application/history identity, current control revision, author, operation identity, previous release and immutable definition/engine commitments. Publishing requires an explicit current `publisher: true` device grant and authorized host account. Control administration does not imply publication rights, and a publisher can be granted no application data access. The host checks every supplied byte before storage effects and selects the release atomically. An exact retry returns its original receipt; a stale predecessor conflicts.

`control.publication()` verifies and remembers the selected release chain. Historical code remains available at its immutable publication URL. Restoring old code requires a new signed publication; diagnostics and the management page cannot silently switch the selected code. Application recovery and code publication have separate histories.

## Help people keep a useful page

After the page has helped with the task, naturally suggest **Page options → Add to Home Screen** for repeat use on a phone. The default runtime provides native installation when the browser supports it, iPhone/iPad Share instructions, and a quiet mobile suggestion with a remembered **Not now** choice. Keep setup optional. Do not force installation, open prompts on load, or add a competing automatic nudge. For authored controls, use [`tendril.installation`](docs/BROWSER_API.md#home-screen-setup) and invoke `prompt()` directly from a click.

Give the page a recognizable `name`, short Home Screen label and appropriate icon using the existing agent API: `PATCH` the returned agent `api` URL with `name`, `short_name`, `icon` (an HTTPS URL), and optionally `theme_color` and `background_color`. The host supplies default install metadata; authored manifest and icon tags can provide more specific branding. The Home Screen launch targets the stable page URL and selected publication, while an already open page remains pinned to its publication.

Offer **Save for offline use** when retaining this version's code is useful. Explain separately what the application can do with disconnected data or peers. Installing the Home Screen app does not save its code or transfer a device signer; iOS may require sign-in and the session's normal device connection/recovery again. See [browser setup and storage details](docs/BROWSER_API.md#home-screen-setup).

## Verify the result

Check the actual application behavior in the intended browser/native environment. Exercise lost replies, offline local work, explicit recovery, revoked access, stale publication heads and the page's stop/cancel controls where relevant. Confirm ordinary application traffic leaves the host idle. Report the exact artifacts and limits of the checks performed.

Use the [CLI](docs/tools/CLI.md), [preview](docs/tools/PREVIEW.md) and [cookbooks](https://github.com/werg/tendriller-contrib) as public consumers. Preview needs an explicit bootstrap for session-backed behavior. Publishing files or reading a guide cannot install server application code.

The reference snippets above assume the objects established by the first-app
bootstrap. They are not independent setup programs. For a domain-only entry,
return to [Build an app](docs/BUILD_AN_APP.md), or run `tendril guide --server URL`
for a credential-free workflow map. `tendril service --server URL` inspects a host
before creating or selecting a page.
