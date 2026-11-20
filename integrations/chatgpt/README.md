# Optional Tendriller ↔ ChatGPT integration

For the normal hosted service, use its existing `/mcp` endpoint and the
[Cloudflare assistant setup](../../docs/CLOUDFLARE_ASSISTANT.md). Start with
`tendril_guide` and the [MCP agent workflow](../../docs/MCP_AGENT_GUIDE.md) for
new applications, empty lists and existing-app connections. That route uses the
application's existing participant and needs no separately deployed Node server.
The rest of this README documents the optional external service/test harness.

This separately deployed Node 24 service connects an explicitly enrolled native
Chronolog application to remote MCP tools, consented MCP Events subscriptions,
an assistance widget, and optional published Workspace Agent/lifecycle adapters.
The [agent-facing route and failure guide](../../docs/CHATGPT_INTEGRATION.md)
explains which option to choose. The Tendriller host remains a filtered control,
publication and introduction participant; this directory is not imported into
the host or its browser runtime.

For a deployment using Tendriller's existing GitHub/Google account login, use
[the host account configuration](config.host-account.example.mjs) and the
[deployment tools](deploy/README.md). This supplies the issuer, live account
mapping, browser login handoff and permission-management UI. The optional
[host OAuth service](../../docs/INTEGRATION_OAUTH.md) must be enabled with its
additive account migration, registered client/bridge settings and signing key.
The external-provider configuration below remains available for other issuers.

## Start with a real application and dedicated device

Follow [Build an app](../../docs/BUILD_AN_APP.md) or the complete
[kitchen fixture](examples/kitchen/README.md). Retain the claimed page handle,
signed descriptor, initial generation, application definition and existing
coordinator. In the kitchen project, create and explicitly enroll its bridge
key with `npm run bridge:key` and `npm run enroll:bridge -- VERIFIED_PUBLIC_KEY`.
The bridge resumes `bridge-device.sqlite`; it never borrows the creator's or
browser's signer. Keep the creator peer available separately.

For another application, supply `openSession({signal})` returning the owned
`{session, control}`. Reuse its maintained public bootstrap or
`createNativeSessionOpener` in [BRIDGE.md](BRIDGE.md). Enable only declared
queries/commands and deliberate outbound projections. A native reader can read
application history; an event-topic filter limits egress, not the native grant.
Enroll reader/writer access only as needed. Publisher, administrator, recovery
and coordinator permissions are independent.

## Install and configure

Use Node 24 or newer for the integration's SQLite store and native tests.
From the repository root, `npm ci` installs its dependencies. To install only
the integration package's dependencies here, run
`npm --prefix integrations/chatgpt ci` instead.
Install exact compatible public Tendriller/Chronolog artifacts where the
application session module resolves its imports, following the application
guide. When using the integration's default native opener or lifecycle imports,
also install those archives under this package:

```sh
npm --prefix integrations/chatgpt install --no-save --package-lock=false \
  /absolute/path/tendriller-core.tgz /absolute/path/chronolog-peer-session.tgz
```

Do not assume an unverified public npm release of the prerelease session package
is compatible. Keep package provenance with the deployed service.

### Use the Tendriller account host

Copy [config.host-account.example.mjs](config.host-account.example.mjs) to a
private deployment directory, or use the deployment preparation command. Supply
the existing delivery and kitchen settings plus `TENDRILLER_HOST_ORIGIN`,
`TENDRILLER_BRIDGE_ID`, `TENDRILLER_BRIDGE_SECRET` and
`TENDRILLER_MANAGEMENT_CSRF_KEY`. The host registration binds the exact MCP
resource, application IDs and `/connections/callback` URL. It also records the
actual ChatGPT client ID and exact callback URI shown by that client.

The service verifies the host's signed token and introspects its exact grant.
It checks current account and page access again on protected operations and
delivery. The owner opens `/connections`, follows the existing Tendriller login,
approves the browser handoff and selects the exact application permissions.
No access token or bridge credential is pasted into the browser. Logging out
of the original host session invalidates its management tickets. OAuth grants
and explicit application consent can each be revoked independently.

For programmatic composition, set `hostAccount: {origin, bridgeId, bridgeSecret,
csrfKey}` and add each application's actual `pageId` and explicit `allowedEvents`
to the existing application configuration. This mode installs the account
callbacks and management UI automatically; do not mix it with external `auth`
or account callback overrides. Set `management: false` only when another trusted
owner interface manages consent. Optional `lifecycle: {creation: true}` uses the
host's current verified owner email while leaving the actual claim to the owner.

### Use an external identity provider

Copy [config.example.mjs](config.example.mjs) to a private deployment directory.
It imports the actual kitchen session, local configuration and event projection;
it does not invent an application backend. It requires these operator settings:

| Environment variable | Meaning |
| --- | --- |
| `TENDRILLER_KITCHEN_DIR` | Absolute configured kitchen project directory, including its private enrolled bridge store. |
| `TENDRILLER_ACCOUNT_ADAPTER` | Absolute trusted module implementing the current account callbacks below. |
| `TENDRILLER_MCP_RESOURCE` | Exact public HTTPS MCP resource, for example `https://assistant.example/mcp`. |
| `TENDRILLER_OAUTH_ISSUER` | Exact trusted authorization-server issuer. |
| `TENDRILLER_OAUTH_JWKS_URI` | Trusted HTTPS signing-key endpoint; never a token-supplied URL. |
| `TENDRILLER_DELIVERY_DB` | Persistent private SQLite file for encrypted integration state. |
| `TENDRILLER_DELIVERY_KEY` | Dedicated base64-encoded 32-byte encryption key, retained across restart. |
| `TENDRILLER_MANAGEMENT_CSRF_KEY` | Separate base64 key of at least 32 random bytes for the optional browser management surface. |

Provision keys through the deployment's secret manager. Preserve the database,
its WAL state and its matching encryption key using a coherent backup procedure.
Do not generate a replacement encryption key on every start. Keep credentials,
device stores and authored review bytes outside public assets and repositories.

The account module must export these functions. They are real deployment
integration points, not permissive example stubs:

| Export | Required behavior |
| --- | --- |
| `authorizeAccountAccess(principal, applicationId)` | Resolve the verified issuer/subject to current Tendriller account access; return exactly `true` only while access is allowed. |
| `authorizeOwner(principal, applicationId)` | Resolve current page ownership before new/replacement consent; OAuth scope or a token email is insufficient. |
| `authenticateBrowserSession(request)` | Authenticate the deployment's existing secure browser login and return the same stable `{id, issuer}` principal. |
| `applicationsForPrincipal(principal)` | Return the current authorized catalog of `{applicationId,label,queries,commands,events,allowEventDetails}` from trusted application declarations. |

The first two callbacks remain necessary when managing consent through another
trusted owner UI. The last two are needed for the example's optional
`/connections` page. Remove `management` when no authenticated browser-session
adapter exists; do not replace login with pasted JWTs or public query parameters.

The configuration module exports this shape (names below denote the actual
imported application/account adapters):

```js
export default {
  resource: 'https://assistant.example/mcp',
  issuer: 'https://identity.example',
  jwksUri: 'https://identity.example/jwks',
  storePath: '/private/tendriller-delivery.sqlite',
  storeKey: process.env.TENDRILLER_DELIVERY_KEY,
  applications: [{
    id: descriptor.payload.applicationId,
    label: 'Kitchen assistance',
    openSession: options => openSession({ ...options, deviceFile: bridgeDevicePath }),
    allowedQueries: ['kitchenContext', 'assistanceStatus'],
    allowedCommands: ['requestAssistance', 'replyToAssistance'],
    eventTopics: ['assistant'],
    exportVersion: 'kitchen-assistance-v1',
    eventProjection: kitchenEventProjection,
  }],
  authorizeAccountAccess: account.authorizeAccountAccess,
  authorizeOwner: account.authorizeOwner,
  management: {
    authenticate: account.authenticateBrowserSession,
    applicationsForPrincipal: account.applicationsForPrincipal,
    csrfKey: Buffer.from(process.env.TENDRILLER_MANAGEMENT_CSRF_KEY, 'base64'),
  },
  host: '127.0.0.1',
  port: 8788,
};
```

The application definition, pinned descriptor and enrolled device must agree.
Use the same application ID in account mapping, consent, lifecycle handles and
tool calls. No remote tool accepts a module path, provider endpoint, host token
or signing key. Configured trusted dependency injection exists for controlled
composition and tests, not model-selected execution.

### Independent approved consumers

The built-in external OAuth verifier and Tendriller account adapter establish an
account identity. Their default `get_profile.consumer.verification` is `account`.
That compatibility mode intentionally shares one account's operation and
subscription namespace: a new conversation or request-supplied agent name does
not establish a new approved participant. A trusted authenticator can supply a
verified `clientId` for an OAuth client namespace; its verification is explicitly
`oauth-client`, which does not claim an individually approved agent.

For independently scoped agents, use the hosted MCP owner's agent approval flow
or supply the following result from this deployment's trusted `auth.authenticate`
adapter after it verifies the credential and resolves an existing approved
binding. The adapter owns the approval policy; this service does not read these
fields from tool arguments, tokens' unverified claims, or MCP `_meta`:

```js
{
  id: verifiedAccountId,
  issuer: trustedIssuer,
  scopes: ['applications:read', 'applications:write', 'events:subscribe'],
  oauthGrantId: verifiedCurrentGrantId,
  agentBinding: {
    id: approvedStableBindingId,
    revision: approvedBindingRevision,
    applications: {
      [applicationId]: {
        queries: ['kitchenContext', 'assistanceStatus'],
        commands: ['replyToAssistance'],
        events: ['assistant.help_requested'],
        readEvents: true,
      },
    },
  },
}
```

`authorizeAccountAccess` must also verify that this exact binding and revision
remain approved for the account and application, including when the service
passes retained principal metadata for background delivery. Return `false` on
revocation or stale revision. All egress and protected calls repeat that check.
OAuth scopes, current account access, account consent, binding capabilities and
the native device grant must all permit the action. Keep a binding ID stable
across credential rotation; create another approved ID for a different agent.
Revoking one binding stops its observations, invocations and new deliveries while
preserving sibling bindings. Existing delivery receipts remain inspectable by
the same approved consumer after authorization is restored.

The same short local operation ID is safe in two bindings. The integration
derives a native ID from application, issuer/account, approved consumer and local
ID, then durably binds it to the command, exact input, reviewed revision and
source context. Its response includes the original local `operationId` and a
full `operationReference` containing the actual signer, history, native operation
and known attempt/generation. Optional `context` accepts run, endpoint, document
and publication correlation fields; these remain labeled `caller-asserted` and
never authenticate an actor or become a signed domain claim automatically.

Use `inspect_application_operation`, `wait_application_operation` and
`retry_application_operation` with the original local ID. Retry sends the exact
native attempt; it does not create a new attempt after uncertainty. A lost or
offline response retains the full known reference and reports uncertainty.
`reapply_application_operation` requires the original ID, a distinct new ID,
explicit input and a reviewed `basedOn` revision. The real native API checks
whether reapplication is valid. Reconfiguring a provider never moves old work to
another signing device or history: those operations require their original
provider. Account-only legacy records retain their original native IDs and do
not transfer to a newly approved binding.

Start with the actual private module:

```sh
node integrations/chatgpt/run.mjs --config /private/integration.config.mjs
```

The listener defaults to loopback and is intended to sit behind the configured
HTTPS proxy. Preserve the public resource host and forward the Authorization
header; keep management on its configured origin. Restrict any extra allowed
origins deliberately. The process handles SIGINT/SIGTERM, aborts its observers,
and closes sessions/storage. A supervisor must restart this same configuration
and private storage. Never run multiple processes against the same native device
store; delivery leases alone do not make a native signer multi-process safe.

## Link accounts and select permissions

Configure a real OAuth authorization server as described in [AUTH.md](AUTH.md),
then connect the MCP resource in the intended ChatGPT surface. Resource metadata
is public; all MCP calls require an authenticated token. Configure the provider's
exact redirect URI, audience and requested scopes. The integration verifies the
token and separately calls the account adapter on protected app operations.

The optional authenticated `/connections` page starts with no selections. The
owner chooses exact queries, commands and event names; detailed event content
requires its own checkbox. Grants expire by default and can be disconnected.
There is no ordinary MCP tool for silently granting consent or native authority.
Use `list_tendrils`, `get_integration_options` and `describe_application` after
linking to inspect what the connection actually permits.

For events, ask the supported chat to subscribe to the chosen event with
`application_id`. The client's callback URL and signing secret arrive through
the event protocol. A verified subscription does not replace owner consent.
Only explicitly projected events leave the service; the default catalog does
not manufacture inventory or shopping facts. The
[public integration guide](../../docs/CHATGPT_INTEGRATION.md#event-delivery-and-recovery)
covers current-state reads, durable retries, delivery status and recovery resume.

## Optional adapters

Add `workspaceAgent: {triggerId, accessToken}` or
`workspaceAgent: {triggerId, getAccessToken}` to configure a published channel.
The adapter fixes the destination in trusted configuration, sends selected-source
identifiers and keeps the original idempotency key. See
[WORKSPACE_AGENT.md](WORKSPACE_AGENT.md). Its conversation/run receipt does not
contain the assistant answer; the agent must use permitted MCP write-back tools.
Approved consumer identity also scopes its operation journal and conversation
key, so sibling agents can use the same short operation ID independently.

Add `lifecycle: {creation, applications, authorizePublication}` for separately
scoped creation/release tools. `creation` supplies the trusted service `origin`
and `ownerEmailForPrincipal` lookup. Its application entries contain
`{id,handle,pinnedDescriptor,ownerAccountId?}`. The optional
`authorizePublication(principal, review)` must check an actual recorded approval
for the exact `reviewId`, `reviewDigest`, application, operation, signed identity
and publisher. The factory also rechecks current account access and connection
consent. Missing approval configuration leaves publication unavailable.

[LIFECYCLE.md](LIFECYCLE.md) describes private review-bundle export and existing
publisher signing. Creation returns the actual owner claim URL without claiming.
Preparation never implies a signed publication. The private bundle must be
reviewed by bytes as well as hashes, and no signing key goes to the remote model.
Approved consumers receive separate review and native publication identities;
`clientOperationId` retains their short local ID while `operationId` and the
signing request identify the exact scoped publication to approve.
The default MCP request limit is 256 KiB including JSON/base64 overhead; trusted
`maxRequestBytes` may raise it up to 12 MiB. Lifecycle graphs additionally default
to 8 MiB decoded bytes/128 files and host limits still apply. The public CLI is
the direct route for larger local reviewed file graphs.

For embedding, `await createIntegration(config)` from `integration.mjs` returns
`handler`, `start()`, `close()`, and the composed `bridge`, `consent`,
`subscriptions`, `outbox`, `lifecycle` and `workspaceAgent` services. The factory
constructs the services; `start()` runs observation/delivery. `startHttpService`
from `run.mjs` binds the listener and starts it. Call `close()` on shutdown.

## Storage, operations and bounded service

The encrypted SQLite record holds consent, subscriptions, routing, selected
cursors, delivery attempts, caller operation references, profile IDs and optional
creation/release bookkeeping. It does not become application state. The dedicated
Chronolog device retains its signer, keys, native history and signed attempts.
Back up both stores with their respective keys and preserve original identities.

Reviewed publication bytes live in separate encrypted SQLite asset rows; the
shared metadata record contains references. `storeLimits.maxBlobBytes` defaults
to 64 MiB across retained assets and can be deliberately set up to 1 GiB. New
review admission and asset writes commit together, and capacity errors preserve
existing review/retry identities. Metadata-only delivery updates do not copy all
authored asset bytes.

New jobs and their cursor commit together. Delivery refresh/revocation is checked
before sends, and recovery pauses require the exact reviewed `recoveryRevision`
with `from_current` or `replay_selected`. An accepted external request cannot be
retracted. Finite journal capacities refuse new work instead of deleting uncertain
records; operators must review/archive retained receipts deliberately.

Internal cursors record the application, consumer, history, export fingerprint,
event filter and generation. Public subscription cursors remain `null`; replay
is an explicit reviewed action. Configure `exportVersion` whenever projection
behavior or captured configuration changes. If omitted, the service fingerprints
the projection function text as a compatibility default. Export definitions also
bind the declared topics, application definition and actual provider. A changed
export pauses observation and queued egress before an old cursor is opened.
`get_application_status.delivery` exposes `cursorReset`, the previous/current export and an
exact `reviewToken`. Pass that token and the shown revision to
`resume_event_delivery`; a subsequent export change invalidates the review.
Replaying under a changed export uses new delivery identities and preserves the
cancelled old receipts. A refresh or credential rotation cannot silently clear
this pause.

Event envelopes retain the actual source author, attempt, selected revision and
export definition. Delivery status distinguishes delivered, pending, cancelled,
revoked, expired, rejected and unknown outcomes; successful webhook receipt still
does not mean that an assistant answered or a domain command applied. Admission
allows two concurrent calls per consumer, eight per account and 32 overall.
All bindings share the account's rate and subscription budgets. Durable dispatch
turns alternate accounts and their consumers before draining older backlogs.
Webhook delivery uses four workers by default, with at most two current leases
per account, two per consumer and one per subscription. These limits are checked
inside the durable lease transaction, including across simultaneous dispatcher
instances. A slow callback occupies its own slot while another recipient can
complete; callbacks for the same subscription do not run concurrently. Configure
`outboxLimits.maxConcurrent` (1–32), `maxConcurrentPerAccount`, and
`maxConcurrentPerConsumer` to reduce the relevant budgets. Account/consumer limits
cannot exceed their parent budget. Each turn still admits at most its explicit
delivery limit, and late responses retain the existing exact-lease receipt rules.
The journal's finite capacity preserves terminal and uncertain receipts instead
of silently evicting them.

`GET /health` is process liveness and reports `liveChatGptVerified: false`.
Use authorized application status for grants, connection availability, observer
problems, queued attempts and recovery pauses. Keep safe diagnostic codes; do not
log Authorization headers, subscription secrets, private handles, event contents
or authored asset bundles.

## Tests and exact native artifact

The root integration test command is separate from the core Node 22 gate:

```sh
npm run test:chatgpt
```

After `npm run build`, run `npm run test:chatgpt:host` on Node 24 to exercise
the actual packaged Worker and Node account/browser adapter together. This gate
applies both exported account migrations to isolated D1 storage and uses public
page creation/claim, real PKCE codes and signed tokens, introspection, exact
owner consent, encrypted-store reopen, refresh and revocation. It records
`.results/chatgpt-host.json`, including exact archive/source identities and the
boundaries not tested. The initial browser accounts are synthetic and the
transport dispatches only to the local Worker; this is not live GitHub/Google
login or a ChatGPT link. The script also accepts `--engine-archive` and `--report`
for a selected public package and explicit report destination.

Without `CHRONOLOG_SESSION_PACKAGE`, real native cases report explicit skips.
Build the pinned public events artifact and extract its archive to enable them:

```sh
git clone https://github.com/werg/chronolog-db.git chronolog-source
git -C chronolog-source checkout --detach d3efeb6d75ac24bb9b44899f27d6940475ab55e9
cd chronolog-source
corepack pnpm install --frozen-lockfile --ignore-scripts
node tools/package-peer-session.mjs
mkdir -p /absolute/private/native-test-package
tar -xzf artifacts/peer-session/chronolog-peer-session-d3efeb6d.tgz \
  -C /absolute/private/native-test-package --strip-components=1
cd /absolute/path/to/tendriller
CHRONOLOG_SESSION_PACKAGE=/absolute/private/native-test-package npm run test:chatgpt
```

The [ChatGPT integration workflow](../../.github/workflows/chatgpt-integration.yml)
uses Node 24 and the [release builder](deploy/README.md) to build clean exact
source revisions, run the native-enabled integration suite with zero skips,
exercise the packed host/account flow, and check runtime imports. Its
`tendriller-chatgpt-release` artifact contains the complete release, pinned
public packages, bridge template, deployment tools, hash manifest and host
qualification report. `chatgpt-integration-qualification` retains the build and
test logs. Installation and private configuration remain explicit operator
steps; no generated private credentials enter either artifact. The reference local
artifact built from that source had SHA-256
`673a6ecdf6c6741721efbb250f711f3acf7fa9784624ad5bcbf6596e5a00996c`;
record each actual build's hash instead of identifying tested bytes only by a
branch name. No production credentials or remote deployment are used by this gate.

| Check | Evidence | Explicit remaining boundary |
| --- | --- | --- |
| OAuth/consent | Actual packed host and Node adapter with D1, signed tokens, browser handoff, current owner/grant checks, CSRF and encrypted restart state | Live GitHub/Google sign-in and actual ChatGPT account linking |
| Deployment | Exact-source release builder, verified public packages, private credential generation, dedicated bridge staging and bounded preflight | Installing the services, DNS/HTTPS and configuring the actual client callback |
| Bridge/native kitchen | Actual SQLite peers, signed control/attempts, authenticated in-process exchange, query/reply, exact retry and reopen | Deployed host, Internet RTC/relay and actual published browser behavior |
| Outbox/subscriptions | Encrypted restart state, callback signing/challenge, authorization races, retry/lease fences and explicit recovery | Actual client callback and subscribed model turn |
| Lifecycle | Real public SDK requests and native publisher signatures against synthetic signed host state | Human owner claim, deployed approval UI and production publication |
| Widget | Mounted-bridge protocol/feature-detection logic and explicit-click behavior | Rendering and accepted follow-up in the intended live ChatGPT host |
| Workspace Agent | Exact provider request/receipt contract through injected transport | Real published channel, its MCP permissions and applied reply |

The complete deployment acceptance sequence is in the
[agent guide](../../docs/CHATGPT_INTEGRATION.md#verification-and-completion).
Keep the local/native evidence separate from those live checks, and identify the
exact missing account, device, callback, approval or runtime prerequisite when
using a fallback.
