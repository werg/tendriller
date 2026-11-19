# Optional Tendriller ↔ ChatGPT integration

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
git -C chronolog-source checkout --detach d014879ecb29714e80311d6101cfa8973953d5c4
cd chronolog-source
corepack pnpm install --frozen-lockfile --ignore-scripts
node tools/package-peer-session.mjs
mkdir -p /absolute/private/native-test-package
tar -xzf artifacts/peer-session/chronolog-peer-session-d014879e.tgz \
  -C /absolute/private/native-test-package --strip-components=1
cd /absolute/path/to/tendriller
CHRONOLOG_SESSION_PACKAGE=/absolute/private/native-test-package npm run test:chatgpt
```

The [ChatGPT integration workflow](../../.github/workflows/chatgpt-integration.yml)
uses Node 24, that pinned source, the extracted public artifact and the same
test command. It retains logs, archive hash and provenance. The reference local
artifact built from that source had SHA-256
`673a6ecdf6c6741721efbb250f711f3acf7fa9784624ad5bcbf6596e5a00996c`;
record each actual build's hash instead of identifying tested bytes only by a
branch name. No production credentials or remote deployment are used by this gate.

| Check | Evidence | Explicit remaining boundary |
| --- | --- | --- |
| OAuth/consent | Real generated-key JWT checks, bounded JWKS behavior, ownership/isolation/revocation and management CSRF | A configured live identity-provider/account-linking flow |
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
