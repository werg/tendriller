# First application: Shared Notes

When adapting this starter to a checklist or another application, first verify its
unchanged connected loop, then change the domain and UI. Keep device identity
independent of titles: the page, pairing Worker and application Worker all import
`helpers/browser-profile.mjs`. Do not rename the profile in just one entry point
or replace a retained browser store. Keep `configuration.page_url` from the page
handle; the service origin and the published page origin serve different roles.

This is the complete source used by the selected service's
`/docs/BUILD_AN_APP.md`. Use Node 24 and check that service's `/api/readiness`
before acquiring dependencies. Follow its build guide to download and verify
the immutable `tendriller-first-app-VERSION.tgz` release kit in a new application
directory. The kit carries this starter, `composition.json`, and its exact SDK,
tools and Chronolog events archives under `packages/`. Install those local
archives after their hashes and the selected host's build identity agree.

The host's `/downloads/tendriller-first-app.tgz` and this repository directory
contain source for inspection. They are not the complete qualified release kit;
do not combine them with same-version packages from another source checkpoint.
For source development, build and qualify one clean matching composition as
described in the selected service's development guide.

The parent guide supplies the package acquisition commands and every setup
checkpoint. After installing those dependencies:

```sh
npm run setup:prepare -- https://YOUR_HOST "Shared notes"
# Call prepare_tendril_setup through the same account-linked MCP connection
# with the printed public arguments. Save its ready result under .tendriller/.
npm run setup:finish -- .tendriller/account-setup-result.json
npm run init
npm run build
npx tendril --session ./session.mjs --mode own --timeout 120 publish ./page --operation notes-release-1
npm run serve # Native participant with optional reviewed MCP access.
# Now give the owner the ready page URL; they sign in to open this version.
# Do not wait for a claimed reply before publishing or starting the participant.
# The owner opens the page. It connects by itself: a new browser creates its own
# key, the native peer pauses ordering and stages the exact signed proposal, and
# the page opens the service-origin approval once. One Approve tap returns to the
# page, which connects as soon as the peer commits. Later visits just connect.
```

The account-linked route derives the verified owner on the host and requires its
existing `tendrils:create` grant. It needs no local OAuth credential or owner email.
`setup:prepare` atomically retains `.tendriller/account-setup.json` before printing
the public request; `setup:finish` reconstructs the private handle only from its
exact ready result. Reopen the same directory and inspect the same operation
after a lost reply. Restore the original private checkpoint if it is missing;
never mint a replacement intent as a retry. `handle_saved` is not connected.

The account-linked setup credential lasts 24 hours even after owner claim and
also depends on its original OAuth grant. To continue the same claimed app,
stop the native peer, retain its complete checkpoint, and have the owner open
the existing `page_url` with `_tendril/manage` appended. Under **Add agent**,
approve a named native binding with host read, participant connection and signed
control permissions; include signed publication and assistant proposal access
when used. Save its ten-minute code privately in
`.tendriller/delegation-code.txt`, then run:

```sh
npm run host:adopt -- https://YOUR_HOST .tendriller/delegation-code.txt
npx tendril --session ./session.mjs --mode own self
npx tendril --session ./session.mjs --mode own query notes null
npm run peer
```

This selects a separately retained host credential while keeping the original
handle, setup intent, signer and signed operations. It refuses a replacing
recovery code or another application's identity. If the reply is lost,
`adoption_outcome_unknown` requires the owner to inspect and disconnect that
named binding if present before explicitly approving another code; the helper
does not resend the uncertain one-use code. A saved response is reused after
the host confirms its credential remains active. Replaying an older successful
attempt cannot overwrite a newer selected credential. If both the handle and
connector access are lost, the owner can inspect `SERVICE_ORIGIN/dashboard/setups`
and save its **Open existing page** link privately as
`.tendriller/owner-page-url.txt`; the retained signed descriptor binds the same
application for the same `host:adopt` command.
Once reviewed delegation is saved, its credential and the retained descriptor
also let `npm run create` resume the same page if the original handle is missing.
It returns the existing page URL without allocating a replacement. Conflicting
identity or incomplete retained recovery state stops creation; restore or
continue that checkpoint instead of clearing it. This local resume result does
not replace the real session and retained-data checks above.
For lost credentials, retained operation inspection and assistant permission
renewal, follow [same-app continuation](https://tendriller.dev/docs/BUILD_AN_APP.md#continue-the-same-app-after-setup-credential-expiry-or-loss).
The original device checkpoint remains necessary; host delegation cannot
recreate application signing keys. Keep all adoption records and code files
private alongside the rest of `.tendriller/`.

Without an account-linked creation route, use the supported explicit email route:
`npm run create -- https://YOUR_HOST owner@example.com "Shared notes"`.
Do not use it to replace an uncertain account-linked operation.

The running native owner handles pairing with its existing session and signer.
After the browser proves possession of its own key, that owner retains the
pairing intent, durably pauses command ordering and saves the exact signed
proposal **before owner review**. The service review displays the fingerprint,
account, application, origins, narrow reader/writer rights, selected generation,
retained prefix and proposal digest. Approval binds that complete proposal.
The host checks current account access, authority and the reviewed payload again
when the normal signed control transition is selected. Existing grants and key
commitments are preserved.

The native participant remains available for later devices through an
authenticated setup WebSocket on the existing hibernating page object. Idle
setup has no polling or heartbeat. Each review expires after ten minutes, with
one local active-request deadline. Every request still needs the owner's
approval on the service origin.

The page uses `connection.mjs` and `connect-view.mjs`: opening it attaches to
this browser's existing device owner (any tab), sets up a new browser, opens the
approval with a return to the page, waits for the commit and connects. A request
the participant committed while the page was away is found on the next open.
Browser reloads retain the same public request and key; private signing keys stay
in Worker storage. An expired or stale request is renewed for the same device; a
denied one waits for an explicit "Ask again".

Private native records are `pairing-ID-intent.json`, `pairing-ID-prepared.json`,
`pairing-ID-commit.json` and `pairing-ID-outcome.json` under `.tendriller/`.
The durable ordering pause lives in the same native device store and survives
process close and reopen. A lost response or unavailable status leaves uncertain
work paused. Reopen the same project and participant to
reconcile the original signed transition; never delete the records, copy the
signer or sign a replacement prefix to resume writes. Only a verified exact
outcome, or a confirmed terminal request with no committed transition, releases
that pause. A later revoked grant is never restored by replay.

With the resident owner stopped, `npm run pair` performs one bounded
prepare/inspect/commit pass and closes that owner. It may stage a proposal and
leave ordering paused for review; rerun the same command after the review.
`npm run enroll -- PUBLIC_KEY` remains a deliberate manual administration route.
A committed pairing still needs a successful peer session and real notes query
before the page reports that it is connected.

Only `page/` is publishable. `.tendriller/` holds the private agent handle,
native device, initial key and exact setup requests; keep it out of Git and page
assets. Setup records are write-once so a retry cannot silently generate another
identity or change a signed transition. The browser receives keys only through
the authenticated session's reader-to-reader key exchange.

Before installing the packages, inspect the selected host's `/api/readiness`.
`create` repeats that check and refuses paused, unavailable or older hosts with
no readiness endpoint. It also refuses an existing handle for another service.
Resume a saved production application only against its matching production
connector; use a separate directory for staging. Never copy private signing
state to make an origin mismatch disappear.

If publishing times out, retain `page/`, `.tendriller/` and the original
`notes-release-1` identity. With the owner stopped, inspect `publication` and
`publication-operation notes-release-1` using `--mode own`; compare the signed
graph before an exact retry. A retained host receipt and a verified current head
are separate observations. `--timeout 120` means 120 seconds.

The browser can read/write notes but cannot administer, publish, coordinate or
recover. Keep the native peer running for applied writes. This first-app policy
can be expanded deliberately after reviewing the membership and availability
requirements. With the peer running, ordinary CLI commands attach to its
owner automatically. Use `--mode own` only for deliberate standalone ownership
while the peer is stopped; it takes the same exclusive fence.

Ctrl-C/SIGTERM waits for owned shutdown. Standalone peer/assistant/SQL/inference
entry points then flush their output and dispose the dedicated Node process,
including lingering socket close handshakes. A failed cleanup or flush is
nonzero; preserve the original device and operation references. Importing these
runners never exits an embedding process or closes its sibling listeners. The
shared `helpers/cli-lifetime.mjs` is included in the downloaded kit.

Several browser tabs attach to one profile owner. SharedWorker is preferred; the
fallback uses an exclusive Web Lock and authenticated local routes. A tab closes
its attachment, leaving the shared signer and sibling views intact. Drafts and
pending references belong to each view; copying a draft is explicit. A duplicate
live view ID receives a fresh ID. Reloading reopens the original signer journal.

The page exposes real connection/data state, local draft preservation, accepted
versus rejected applied outcomes, operation inspection, exact retry and explicit
close. Its initial live-view `ready()` wait keeps the same attachment during
`PEER_RECOVERING` until a coherent read succeeds, with a fixed 30-second deadline
and event-driven readiness. Fatal read errors and cancellation still fail setup.
It imports `createLiveView` from `@tendriller/core/collaboration/live-view` and
the supplied operation-state and reviewed-input helpers. Adapt these modules directly rather than rebuilding transport and state
fetching around another backend. Its localhost preview is clearly labeled
layout-only. Follow the parent guide's deployed acceptance checks before reporting
success: deliver the running hosted application and explain which process must
remain alive, as described in [Agent delivery](https://tendriller.dev/docs/AGENT_DELIVERY.md).

| Source | Purpose |
| --- | --- |
| `domain.mjs` | Shared events-backed command/query definition |
| `account-setup.mjs` | Retain private setup intent, supply public MCP arguments, reconstruct exact ready handle |
| `host-adoption.mjs` | Continue the same app through privately retained owner-reviewed host delegation |
| `setup.mjs` | Explicit email creation, initialize/select genesis, one pairing pass or deliberate manual enrollment |
| `local.mjs` | Private setup records and native host client |
| `session.mjs` | Real resumable native session; CLI bootstrap and running peer |
| `worker.mjs` | Browser device, owned session, authority and peer key acquisition |
| `pairing-browser.mjs`, `pairing-worker.mjs` | Retain one public browser request and prove possession using its own fenced device |
| `pairing-native.mjs` | Bounded processing on the existing native owner, durable ordering pause and exact reviewed transition recovery |
| `page.mjs`, `index.html` | Editable UI and public session facade |
| `build.mjs` | Browser bundling and a public-only publication graph |
| `helpers/` | Importable coherent views, operation observations and reviewed input |
| `media/` | Camera/file and runtime voice controls; opt-in native inference participant |
| `sql/` | Separate guarded SQL starter, exact engine setup and resumable transaction demo |

## Extend the running application

[Application patterns](https://tendriller.dev/docs/APP_PATTERNS.md) explains the
helper interfaces and their ownership boundaries. These are application-owned
source modules, not additional SDK exports or a second synchronization layer.

The page's **Review a photo** controls work with manual review immediately. The
optional **Analyze photo** path needs the native inference participant described
in [Reviewed AI input](https://tendriller.dev/docs/AI_INPUT.md), an allowed browser
device, an explicit request budget, and the owner's provider credentials. Run that
participant instead of a second process opening the same native store. Analysis
only suggests text; **Save reviewed observation** submits the reviewed command.
OpenAI is the included provider and is named in the page's consent. Disclose a
custom provider in the authored page before publishing that adaptation. Voice
likewise supplies an editable draft, with typed input always available.

For stock deductions or other guarded relational changes, follow
[State models](https://tendriller.dev/docs/STATE_MODELS.md) and [the SQL starter](sql/README.md).
It creates a separate application and needs the matching SQL-native engine
archive. The events-only archive used above cannot run it. The SQL demo tests
atomic two-bin transfers, rejection without partial changes, exact retry and
reopen; its optional browser Worker is an integration source, not a second
finished interface.

The source uses public package exports and no qualification fixture imports.
It is a small working composition to adapt, not a general automatic enrollment
service or a substitute for release qualification. The source of truth for
capabilities remains the host descriptor and exact installed artifacts.


For MCP access, run `npm run assistant:prepare` before owner sign-in and retain
its returned review URL. Run one `npm run serve` process for the native
participant plus its optional assistant adapter. Give the owner the ready page and
review URL together. Claim adopts the prepared app, while assistant approval
remains explicit; there is no need to type “claimed” back to the agent.

The default assistant requests only the declared notes query and add-note command.
For optional event forwarding, use `npm run assistant:prepare -- --events` and
`npm run assistant -- --events` with the same reviewed choice. Forwarding events
does not create an MCP subscription, run a future model turn, or extend this
process's lifetime. The runner reports proposal preparation, the running native
PID, actual adapter status and shutdown separately. Missing consent, adapter failure, revocation and replacement leave the native
participant running. New consent reconnects only the adapter through setup
notifications. Even `adapter_online` still
requires a real MCP/browser round trip before setup is complete.

If optional forwarding reports `adapter_activity_failed`, the native participant
and healthy MCP provider stay running, but event continuity is unverified and
forwarding is paused for that connection. Inspect the retained private
`.tendriller/assistant-event-cursor.json` and the selected application's recovery
history. Keep that exact cursor; do not delete it or silently choose a new start.
After explicitly reviewing which events may be forwarded from that checkpoint,
restart the existing runner from the same private project with
`npm run serve -- --events` (equivalently `npm run assistant -- --events`).
This explicitly restarts the native process too; its retained identity, cursor
and operation records resume from that project. A still-unresolved review
remains blocked rather than silently advancing its cursor.
`eventsForwarding: true` means enabled, not verified continuity. Do not begin an
idle qualification that requires forwarding while this review remains blocked.

### Inspect the resident participant

While `npm run peer` keeps the native owner running, `node session.mjs diagnostics`
(or `node session.mjs status PROFILE`) attaches locally, takes one sanitized
transport sample and detaches. The standard Page options menu shows the same
authenticated-link evidence. Counters reset on link replacement and are not
billing or operation-retention proof. See [transport diagnostics](https://tendriller.dev/docs/TRANSPORT_DIAGNOSTICS.md).
