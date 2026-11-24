# Use the application session from a terminal

`tendril` has one application path: the public Chronolog session opened by the
application's own bootstrap module. Host lifecycle commands use the host's
metadata API. Application commands, queries, events, live signals, recovery and
page-code publication use the session and its explicit control participant.

## Start with only a domain

Install the tools archive using the artifact instructions in
[Build an app](https://tendriller.dev/docs/BUILD_AN_APP.md), then inspect the
workflow and the host before creating anything:

```sh
tendril guide --server https://tendriller.dev --pretty
tendril readiness --server https://tendriller.dev --pretty
tendril service --server https://tendriller.dev --pretty
```

`guide` prints structured steps, prerequisites, authorization checkpoints and
links for that service origin. It is offline: it creates no page, reads no
private handle, and does not claim the host is reachable. `service --server`
reads `/api/service` without credentials, even if page credentials are present
in the environment. Use the actual staging or self-hosted origin throughout.

`readiness` reads uncached `/api/readiness` anonymously. Inspect it before
installing or building application packages. A paused/read-only or unavailable
service blocks creation; a missing endpoint requires a host upgrade. `new`
requires an explicit `--server` or `TENDRIL_SERVER` and repeats the preflight. It
never defaults creation to production. Readiness is advisory: if the service
pauses before the POST, the original creation error is retained and no handle is
saved. Do not retry on another origin.

`service --tendril NAME` still reads the selected page's effective limits.
Without either flag, a configured page is used if available; otherwise the
public descriptor comes from `TENDRIL_SERVER` or `https://tendriller.dev`.

Follow the [complete application workflow](https://tendriller.dev/docs/BUILD_AN_APP.md)
for initial authority, device enrollment, UI composition and publication. A
successful `new` command gives you a hosted page and independent application
identity. It does not configure application authority or open a Chronolog
session. The human owner must open the returned `page_url` and sign in to claim
the page. Keep its private handle and tokens out of the authored page files.

Initial configuration also needs a selected first generation. Save its signed
transition request before sending it, then verify the selected authority before
opening the session. `configureApplication` alone does not satisfy this step;
the tutorial's initialization command performs both stages.

## Inspect capabilities and choose a host

`tendril probe --server YOUR_ORIGIN --project ./app --check-network` reports
measured capabilities separately from unknowns. It does not create a page,
request a browser permission, or establish future process availability. Prefer
WebRTC when available; select the encrypted relay for restricted environments.
See [deployment guidance](../DEPLOYMENT_GUIDE.md) for the process, storage and
lifetime required by each hosting route.

## Choose attachment or ownership

`--session /absolute/application.mjs` names the application's public bootstrap.
The supplied [Shared Notes bootstrap](https://tendriller.dev/downloads/tendriller-first-app.tgz)
exports both hooks. Start `npm run peer`, then use `--mode attach` from several
terminals while that process keeps the same signer, journal and peer connections
open. The CLI prefers attachment whenever the bootstrap exports `attachSession`.
An unavailable owner never causes it to open a second signer.

| Mode | Bootstrap hook | Lifetime |
| --- | --- | --- |
| `attach` | `attachSession({signal, profile, context})` | Uses an authenticated existing owner; exit or cancellation detaches only this client |
| `own` | `openSession({signal, mode, profile})` | Acquires exclusive ownership of the retained profile and closes that ownership after the command |
| `independent` | `openSession({signal, mode, profile})` | Requires an explicit `--profile` with a separately provisioned and enrolled device |

`attachSession` returns `{session, detach?}`. Either that return object or the
session must expose a local `detach()` method. `openSession` returns
`{session, control?, close?}`; the optional `close()` also releases the owner's
profile fence. The CLI calls the appropriate cleanup exactly once, including an
interrupted invocation. A bootstrap exporting only `openSession` uses explicit ownership. `--run RUN_ID` supplies caller-asserted run context;
it is not authorization to impersonate a participant.

For the tutorial's default `main` profile:

```sh
# Persistent owner, in its own terminal:
npm run peer

# Independent attached invocations:
npx tendril --session ./session.mjs --mode attach self
npx tendril --session ./session.mjs --mode attach endpoints
npx tendril --session ./session.mjs --mode attach doctor
npx tendril --session ./session.mjs --mode attach --run review-1 query notes null
```

`self` exposes the actual application, signing device, attachment, owner
incarnation and binding identity. `endpoints` lists authorized local endpoint
metadata; `doctor` combines that provenance with definition names, capabilities
and session status. Its versioned diagnostic report has `assessment`, `scope`
and `findings`, each with a stable `code`, current `state`, `retrySafe` and a
concrete `nextAction`. It distinguishes unopened data from missing keys,
unreachable coordinators, recovery review and a closed owner. A restricted
endpoint list adds its original denial code while preserving other observations.
It never activates the database, fetches authority, submits work, retries an
operation or includes command inputs, credentials and full definition schemas.

Applications can use the same pure public helper:
`diagnoseApplicationSession(session)` from
`@tendriller/core/diagnostics`. `diagnosticFinding(error, {scope})`
maps an existing exact error to the same bounded report without including its
arbitrary message or payload. CLI errors include this diagnostic alongside the
original error. A ready observation is not a remote delivery, model turn or
external effect guarantee; retry safety never authorizes replacing an uncertain
operation ID. Presence remains separate from authorization.

Initial publication before starting the peer uses `--mode own`. Administrative
setup and enrollment still need exclusive ownership or a deliberately granted
owner-administration attachment. Ordinary queries, commands, retries, events and
signals work while the native peer runs. `--mode own` against a running supervisor
returns `OWNER_BUSY` before opening its signing store.

## Compose a native supervisor

The maintained Node-only export is `@tendriller/core/native-owner`. It
accepts the public Chronolog owner and facade factories without bundling another
copy of Chronolog into the tools. The following outline composes already
provisioned deployment values; the first-app bootstrap supplies a complete
example:

```js
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { createNativeSessionSupervisor, attachNativeSession }
  from '@tendriller/core/native-owner';
import { directory, profileId, applicationId, definition, openRetainedSession,
  readPrivateAttachmentKey } from './deployment.mjs';

// Run once in the long-lived native peer process. The callback executes only
// after the exclusive profile fence has been acquired.
const supervisor = await createNativeSessionSupervisor({
  directory, profileId,
  openOwner: async () => createApplicationOwner(await openRetainedSession()),
});

// Owner administration adds a distinct credential without replacing siblings.
// Store the returned token in a private file and give it only to that client.
const reviewer = await supervisor.createBinding({ id: 'reviewer', policy: {
  capabilities: ['queries', 'events', 'operations', 'diagnostics'],
  queries: ['notes'],
}});

// In the CLI's bootstrap module, running in a different process:
export async function attachSession({ signal, context }) {
  return attachNativeSession({ directory, token: await readPrivateAttachmentKey(),
    applicationId, definitionId: definition.id, definitionVersion: definition.version,
    connect: connectApplicationOwner, signal, context });
}
```

The directory is owned by the current OS user and mode `0700`; the Unix socket
and retained metadata are mode `0600`. Only credential hashes are stored by the
supervisor. `rotateBinding(id)` retains the stable binding identity and advances
its credential revision. `revokeBinding(id)` disconnects only that binding's
attachments; retained operations and sibling clients survive. Restart reads the
same bindings and verifies the same application, definition and signing device.
A lightweight SQLite lock is acquired before opening application data and is
released by the kernel after a process crash. A successor removes a stale socket
only while holding that lock. A delayed heartbeat never permits takeover.

Defaults are 32 clients overall, four per binding, 32 retained binding records,
a three-second authentication deadline, 1.1 MB frames and 4.4 MB buffered bytes
per socket. Owner request, stream and view quotas also apply independently to
each attachment. Slow or malformed clients are disconnected locally. The module
opens no TCP command port. A missing signer, incompatible definition, insecure
path, unavailable owner or occupied profile produces an explicit error.

`--profile NAME` selects a bootstrap-defined retained profile. In Shared Notes,
a separately provisioned profile lives at
`.tendriller/profiles/NAME/device.sqlite`; `npm run peer -- NAME` owns that profile.
It needs its own enrolled key and grants. Copying a bearer token or inventing a
profile name does not enroll an independent participant. Normal invocations never
use `create: true`, replace a missing identity or merge two profiles' signing
rights. Keep all credentials and native stores outside the publishable page.

## Inspect and submit domain work

```sh
tendril --session ./application.mjs describe
tendril --session ./application.mjs query board '{}'
tendril --session ./application.mjs command claimTask '{"taskId":"review"}' \
  --operation claim-review-1 --based-on '<captured revision JSON>'
tendril --session ./application.mjs operation claim-review-1
tendril --session ./application.mjs retry claim-review-1
```

Operation IDs are required and remain stable across exact retries. Native attachments namespace a short caller ID by the application and authenticated binding. Two distinct agents may safely use the same short ID; the result retains the actual signing device and full native operation ID. Rotating a credential preserves that namespace. Commands wait
for applied execution by default. `--saved` returns after the exact attempt is
saved; `--shared` additionally waits for retained coverage. A timeout leaves the
original attempt available. Inspect it or retry that same identity. Applied and
shared observations can later be abandoned by an explicit recovery selection.

An omitted query input is `{}` for compatibility. The starter's `notes` query
requires JSON `null`, so use `query notes null`. `--shared` waits for another
eligible participant to retain the work; a single native peer can apply a write
without satisfying that additional condition. Operation inspection is scoped to
the current signing device and authenticated binding. Keep the full
`operationReference` returned by MCP/attachments when moving between tools;
another signer or a short external ID is not the same native journal entry.

`--timeout` is in **seconds**, for example `--timeout 120`, with a default of 30.
Timeout cancels observation, not a saved signed attempt. Errors preserve the
timeout/action cause separately from local cleanup failures.

### Reconcile a publication after an uncertain response

Stop the native owner before using its standalone publication control:

```sh
npx tendril --session ./session.mjs --mode own --timeout 120 publication
npx tendril --session ./session.mjs --mode own publication-operation notes-release-1
```

The second command reads the same device's saved signed intent and any retained
host acknowledgement; it sends no publication. It requires the qualified
Chronolog package with publication receipt inspection. Acknowledgement proves
the host accepted that signed graph, not that it remains the current selected
release. The first command verifies the selected signed history.

Publish errors include the original operation/publication identity, the phase,
and `outcome`: `unknown` when a response is uncertain, `committed` when a valid
receipt was observed, or `not_submitted` when preparation failed. A known receipt
survives failure of the subsequent selected-head read or local cleanup. Preserve
the authored bytes and original operation; inspect before an exact retry. Never
change the operation ID merely because the invocation failed.

A reviewed reapplication names the old operation, a new identity, current input
and the current captured revision:

```sh
tendril --session ./application.mjs reapply claim-review-1 claimTask \
  '{"taskId":"review"}' --operation claim-review-2 \
  --based-on '<reviewed current revision JSON>'
```

The tool performs no automatic reapplication and dispatches no external effects.
An irreversible action requires a separately declared capability with its own
durable authority and reconciliation boundary.

## Events, signals and recovery

`events` captures a coherent applied view and releases it after reading. Its
opaque cursor belongs to that history. The caller commits derived state and its
processed cursor together; reading a batch does not acknowledge external work.
`watch` streams actual session changes, including explicit recovery notices,
with stdout backpressure. These are coalesced revision notifications, not retained
events or replay cursors. Existing change rows keep their shape.

For a durable consumer, use `watch --events`. It reads coherent applied event
batches after each change, drains every page before waiting again, and prints
`{revision, events, cursor, hasMore}` rows. It accepts the same opaque `--cursor`,
`--topics` and `--limit` options as `events`; those flags require `--events` on a
watch. The first batch exposes a cursor even when the history is empty. Neither
mode creates a checkpoint file, polls or acknowledges that application work was
handled.

An unexpected end, owner loss, revoked attachment or read failure exits nonzero.
The error on stderr retains the original cause and a `watch` object containing
`mode`, `cursor` and `revision`, without copying event payloads. `cursor` is the
last batch successfully written to stdout (or the supplied starting cursor);
change mode reports `null`. A missing owner fails immediately instead of opening
a second signer or retrying forever. Attachment watches do not reconnect to a
replacement owner automatically.

A running watch's requested `--timeout` or explicit SIGINT/SIGTERM stops normally,
awaits cleanup and exits 0. It writes a JSON `watch` summary to stderr with
`reason: "timeout"` or `"interrupted"` and the same progress fields. Output and
cleanup failures still exit nonzero. Other commands retain their existing
nonzero timeout/cancellation behavior.

Persist the **processed** event cursor together with the consumer's own results.
A successful stdout write only means the CLI emitted that batch, not that the
next process processed it. After owner restart, start a new attachment with the
same profile and topic filter, using the last cursor whose work was committed.
Use `events --cursor` for a bounded catch-up or `watch --events --cursor` to
continue listening. If recovery invalidates that cursor, the watch fails with
the original recovery error and retained cursor; review/rebuild derived state
for the new generation explicitly. It never silently resets to the beginning.

```sh
tendril --session ./application.mjs events --topics '["message"]' --limit 100
tendril --session ./application.mjs watch
tendril --session ./application.mjs --mode attach watch --events --topics '["message"]'
tendril --session ./application.mjs --mode attach watch --events --cursor "$PROCESSED_CURSOR" --topics '["message"]'
tendril --session ./application.mjs signal progress '{"complete":3}' --ttl 2000
tendril --session ./application.mjs recovery inspect
tendril --session ./application.mjs recovery takeover --transition recover-on-device-b
```

A handover uses `recovery handover <successor-device> --transition <id>` and
requires the successor's verified retained prefix. The session persists exact
signed transition requests. A lost control response retries its original base
and identity, without a tool-owned delivery queue. Live signals are disposable
and do not append application history.

## Publish signed page code

```sh
tendril --session ./application.mjs definition
tendril --session ./application.mjs publication
tendril --session ./application.mjs --mode own publish ./page --operation release-2026-11-17
```

The complete authored graph is hashed and passed to the session's
`preparePublication`. `publish` sends that saved signature and content addressed
bytes through the control participant. Reusing the same operation recovers the
same signed intent. A changed graph under that identity is refused. There is no
unsigned publication route, merge overlay or rollback alias. Deliberately
publishing earlier content is a new reviewed signed publication.

## Host lifecycle commands

`new [name] --owner VERIFIED_EMAIL` creates a page and saves its private handle
with restricted file permissions, including its stable `application.id`.
Choose that handle with `--tendril NAME`, or
supply `TENDRIL_API` and `TENDRIL_TOKEN`. `info`, `service`, `meta <json>`,
`release`, `activity`, `link` and `token` operate on host metadata and access.
`remove --yes` deletes hosted state. These routes do not carry domain commands.

`token create reviewer --scopes '["host:read","participants:connect"]'` adds a
separately scoped binding without invalidating existing agents. `token rotate
reviewer` changes that credential while retaining its binding identity; `token
remove reviewer` revokes it narrowly. Delegation cannot grant more authority than
the caller holds. Named agents share their delegating account's discovery,
invitation, relay and participant admission budgets; adding tokens does not
multiply those quotas.

Handles saved by older CLI builds may lack `application`. Retrieve the selected
page's `application.id` with `info`; use that identity when composing the host
client. Do not create a different application identity to fill the missing
local field.

The default invocation timeout is 30 seconds. `watch` continues until interrupted
unless `--timeout SECONDS` supplies a bound. `--pretty` formats the JSON result.

### Set a favicon

Give each app a recognizable emoji favicon during setup. With a saved CLI handle
named `garden`, one command sets it:

```sh
tendril --tendril garden meta '{"icon":"🌱"}'
```

The host converts a single emoji (including compound emoji) to an SVG. An HTTPS
image URL is also accepted. Use `meta '{"icon":null}'` with the same handle to
restore the default. If you selected the handle through `TENDRIL_API` and
`TENDRIL_TOKEN`, omit `--tendril garden`. Reload the page after a change. Authored
icon tags or manifests take precedence; see [page branding](../BROWSER_API.md#favicons-and-page-branding).

## Retain irreversible provider effects separately

`createEffectDispatcher` requires a durable journal outside the application's
recoverable history. The native export supplies a concrete
`createSqliteEffectJournal({path, applicationId, providerId})`. Its private SQLite
file uses synchronous WAL commits, binds its scope permanently, and rejects use
of an application database as its effect store. The dispatcher derives a stable
provider idempotency key from application, provider and effect identity.

```js
import { createEffectDispatcher } from '@tendriller/core/collaboration';
import { createSqliteEffectJournal } from '@tendriller/core/native-owner';

const journal = await createSqliteEffectJournal({
  path: '/private/my-agent/effects.sqlite',
  applicationId, providerId: 'mail-provider',
});
const effects = createEffectDispatcher({ journal,
  authorize: verifyCurrentClaimFence,
  dispatch: ({ idempotencyKey, input }) => provider.send({ idempotencyKey, ...input }),
  reconcile: (_effectId, record) => provider.findReceipt(record.idempotencyKey),
});
await effects.execute({ effectId, fence: reviewedClaimFence, input });
```

The journal commits `dispatching` before calling the provider. A timeout,
process loss, missing receipt or failed post-journal authorization remains
uncertain. Reopening or retrying the same effect first reconciles the original
provider identity and never dispatches it again automatically. Completed receipts
are terminal and cannot be silently replaced. Recovery of application history
does not erase these records or prove an external action did not happen.

`inspect(effectId)` and bounded `list({after, limit, status})` expose the retained
state. The default capacity is 10,000 effect identities with 128 KiB records;
a full journal refuses new effects instead of evicting duplicate protection.
`close()` releases the SQLite connection. Network work belongs outside
`transact()`; an asynchronous transaction callback is rejected.


## Local MCP and ordered command batches

A local MCP client can launch the installed tools executable with arguments
`["--session", "/absolute/app/session.mjs", "--mode", "attach", "mcp-stdio"]`.
Start the app's resident participant first. This newline-delimited stdio server
exposes `app_discover`, `state_query`, `command_submit`,
`command_submit_batch`, and `operation_inspect`. It attaches to the same local
signer; closing the MCP client detaches that caller. Tool calls have a fixed
30-second deadline and support cancellation. Saved work survives a waiter
cancelling or timing out. This supplies local tools; it does not imply that the
client supports background conversation wake.

`command-batch '<JSON array>'` accepts up to 64 ordered entries with `command`,
`input`, `operationId`, and optional `basedOn`; `--saved` returns the observed
recorded/applied state without waiting for application. The local MCP batch
accepts up to 32 entries. These are ordered individual commands, not one atomic
transaction. Declare one domain command when all changes must commit together.
Malformed envelopes fail before the first submission. Results preserve the
original operation IDs and report incomplete batches with `nextIndex`.
Inspect uncertain operations rather than assigning replacement IDs.

## Share source without device state

`tendril handoff source handoff.tgz --project ./app` exports code, documentation,
static assets and package/TypeScript manifests. It excludes hidden files,
environment files, runtime/configuration JSON, device/checkpoint bytes and
state directories, and rejects recognized credentials embedded in source.
Review authored source before sharing: arbitrary embedded credentials cannot be
identified reliably by a file filter. The recipient configures its own private
setup and device; the source archive transfers no authority.


## Move a stopped retained device

The checkpoint commands use the selected project's matching public Chronolog
package. Load `TENDRILLER_CHECKPOINT_SECRET` from private storage (a 64-hex random
key or a passphrase of at least 12 characters), then stop the original participant:

```sh
tendril checkpoint export ./move.clcp --project ./app --device ./app/.tendriller/device.sqlite
tendril checkpoint restore ./move.clcp --project ./app --device ./app/.tendriller/profiles/moved/device.sqlite
# In the supplied starter, reopen that retained identity in its new profile:
cd app
npm run peer -- moved
```

The encrypted file is durably written before the source store is retired.
Restore verifies the signing identity in a temporary store, then publishes one
fresh private directory. Existing output files and destination directories are
never replaced. A running source is rejected by the native store's exclusive
writer fence. This fences the original store; run only one restored copy of the
same signing identity. Enroll another device for simultaneous participants.

The checkpoint carries canonical device identity, keys, signed attempts and
retained history. SQL materialization is rebuilt from that history when the
application reopens; copying its engine files is unnecessary. Preserve the same
application code, signed schema/descriptor and private host configuration too.
For the example above those remain in the original project. A cross-machine move
must retain that private project context separately; source-only handoff excludes
it. Verify a coherent query, original operation outcomes and remote interaction
after reopening before reporting the handoff complete. The checkpoint is bounded
to 4,096 entries and 16 MiB of source data (32 MiB encoded); oversized state is
rejected without retiring the source.
