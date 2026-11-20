# Troubleshoot an application build

Start with [Build an app](BUILD_AN_APP.md). Diagnose the first incomplete stage
before changing architecture: **create and claim → define state and UI → configure
authority and select the first generation → connect → publish and verify**. A page URL, an installed adapter, and
a working shared application are different checkpoints.

Keep the private handle, signer store, epoch keys and saved attempts intact while
diagnosing. Share error codes, public device IDs and redacted status; keep bearer
tokens, capability URLs, private keys and application data out of public logs and
published assets. An uncertain response is a reason to inspect the existing work,
not to create a replacement identity or backend.

## MCP has no applications or the agent cannot find setup

Call `tendril_guide` with `topic: "start"`; the tool returns the maintained
[MCP workflow](MCP_AGENT_GUIDE.md) without browsing. An empty `list_tendrils`
means no assistant-connected apps for that account. Use `topic: "build"` for a
new application and its supported HTTP creation route, or `topic: "connect"`
for the existing participant's proposal and owner review. Check Node 24, retained
storage and actual process lifetime before promising a connected new app. A
missing runtime requires a concrete runtime handoff, not another website plugin.

If the guide tool is absent, refresh the client's cached tool catalog or recreate
the custom connection after confirming the intended service origin and deployed
release. Keep the same origin for all setup requests; do not switch staging to
production to find an app.

## Locate the missing checkpoint

| Checkpoint | Evidence to inspect | What remains to do |
| --- | --- | --- |
| Host discovered | `GET /api/service` returns a compatible contract and limits. | Obtain compatible public artifacts and read the build guide. A descriptor does not open a session. |
| Page created | The saved private handle contains `api`, `token`, `page_url` and `application.id`. | Give the owner their page URL so they can claim it. |
| Owner claimed | The owner completed sign-in; inspect host info through `host.info()` or `tendril --tendril NAME info`. | Configure device authority. `configured: false` is a separate state from claim. |
| Authority configured | Host info reports `configured: true`; `host.peers.application()` returns authority to verify and pin through Chronolog. | Select the first generation. Configuration retains the descriptor and controls but supplies no selected generation and starts no application process. |
| Initial generation selected | The saved, signed creation transition has been submitted through `host.peers.selectGeneration(...)`; verified authority contains the selected generation. | Open the enrolled device's session with the matching definition, keys and persistent store. The tutorial's `init` step saves the exact transition before sending it and resumes that attempt after interruption. |
| Browser binding installed | `tendril.application.available` is true; `ready()` resolves with the backend. | Inspect `session.status` and participation status for connectivity and the selected generation. |
| Data path exercised | A declared command has an observed outcome and a coherent query shows the intended value. | Check the other peer and reopen the same device. A local result alone does not prove replication or resume. |
| Code published | `control.publish(...)` returned a signed publication receipt; `control.publication()` verifies the selected release. | Open the actual published page and exercise its browser/session integration. |

The CLI examples below assume the tools are installed and `./application.mjs` is
your real application bootstrap exporting `openSession({ signal })`. If that file
does not exist, return to [the build guide](BUILD_AN_APP.md) and complete setup;
an empty module or invented `deployment.mjs` does not provide a session.

```sh
tendril --tendril NAME info
tendril --session ./application.mjs status
tendril --session ./application.mjs describe
tendril --session ./application.mjs definition
tendril --session ./application.mjs publication
```

These commands inspect different boundaries. Preserve the returned application
ID, selected generation, public device ID, operation ID, publication ID and exact
artifact versions in the private build record so mismatches are visible.

## Host access, claim and package setup

| Observation or code | Next action |
| --- | --- |
| `/api/service` returns HTML, a challenge, or `invalid_response` | Check that the URL is the service origin, not a page or agent API URL. Inspect HTTP status and content type. If ordinary automated clients are blocked before the Worker, report the host access problem with a redacted response. Do not treat it as a successful descriptor. |
| `contract_mismatch`, missing package export, or incompatible definition/engine artifacts | Compare the host contract, core release and exact installed artifact manifests. Follow [artifact acquisition](tools/ARTIFACTS.md) and the [release composition](RELEASE_COMPOSITION.md) record. Supply a compatible public Chronolog session archive; the core host's control dependency is not the full native/browser session package. Do not assume that unrelated latest package versions compose. |
| `unauthorized` from an agent API | Check the saved handle's service/API and current bearer token. Ask the owner to use the page's management connection flow if the agent credential has been revoked. A different account's credential or browser cookie is not a substitute. |
| Sign-in is shown, `wrong_owner`, or `claimed` | Have the human open the returned owner `page_url` and sign in with the intended verified identity. If another account owns the page, report that mismatch. Agent credentials cannot claim the page on the owner's behalf. |
| `forbidden` while configuring, or `account_required` while making a page resident | Confirm owner claim and the current account's authority. Host control configuration is owner administration. A page display role cannot perform it. Read the specific error message; `forbidden` can also mean revoked access. |
| `lifetime_pending` | Inspect current host info and retry the same requested lifetime after account storage recovers. Do not alternate lifetime values to work around an uncertain account write. |
| `quota`, `rate_limited`, or `peer_participant_busy` | Read the reported limit and service status; reduce concurrency or wait before a bounded retry. Preserve existing handles and operation identities. Do not repeatedly create pages to evade a limit. |

Unclaimed pages expire after 24 hours. Creating another page is a new application
setup decision, not a recovery mechanism for an existing claimed application.
See [membership](MEMBERSHIP.md) for the independent account and device rights.

## Definition, authority and enrollment

| Code | Next action |
| --- | --- |
| `peer_application_unconfigured` | After owner claim, complete `host.peers.configureApplication(...)` with the real public definition, execution-manifest digest, schema administrator, epoch/key digest and initial device grants. SQL also needs its matching signed schema. Inspect authority after an uncertain response before repeating the exact configuration. Publishing HTML cannot configure the application. |
| `PEER_NO_SELECTED_GENERATION` when opening the session | Configuration succeeded but the initial generation has not been selected. Resume the tutorial's `init` step or the complete [session bootstrap](SESSION_BOOTSTRAP.md): persist the signed creation transition, submit it through `host.peers.selectGeneration(...)`, verify the resulting authority, then open the session. Reuse a retained transition on an uncertain response; do not invent a replacement generation or start an empty session. |
| `peer_definition_invalid` or `peer_schema_definition_mismatch` | Validate the actual application definition and, for SQL, prepare its schema with the matching public engine/session artifacts. Compare the signed definition/schema commitments instead of inventing digest values. |
| `peer_application_immutable` | Read the configured definition and authority. The initial descriptor cannot be replaced by submitting different configuration. Resume that application or deliberately design a new application identity; preserve the existing page and data while deciding. |
| `invalid_application`, `peer_application_identity`, or `peer_participant_scope_mismatch` | Compare the handle's 32-byte lowercase hex `application.id` with the session, runtime binding and participant request. A page ID, URL or device ID is not the application ID. |
| `peer_account_binding_required`, `peer_account_binding_immutable`, or `peer_requester_account` | Inspect the signed grants and authenticated account bindings. Enroll the actual device under an admitted account through authorized control changes. An existing device key retains its original account; changing a payload role does not change authority. |
| `peer_control_revision_mismatch` or `peer_transition_id_reused` | Inspect the current verified authority and the retained transition. An exact retry keeps its original signed bytes and transition ID. A changed control proposal is a new reviewed transition, not a modification of the saved request. |
| `peer_control_state_missing`, `peer_control_state_mismatch`, or `peer_definition_state_mismatch` | Preserve the existing records and report the host consistency failure. Recreating a signer or empty authority would destroy the pinned trust relationship. Use explicit recovery with actual surviving evidence; do not fabricate it. |
| `peer_controls_require_owner` or `peer_controls_require_resident` | Configured signed controls must retain their owner and resident storage. Claim release or lifetime downgrade is not an application reset. Use an explicitly authorized lifecycle decision for deletion. |

A native device and browser device have separate signers. Page login grants host
access; signed enrollment grants application rights. A public discovery entry only
helps peers find each other. None of these replaces the others.

## Browser readiness, storage and peer connections

| Observation or code | Next action |
| --- | --- |
| `backend_unavailable`, or `application.ready()` remains pending | Check browser module/Worker load errors and the real session bootstrap. Install `createApplicationBackend({ id: session.applicationId, session })` exactly once. `ready()` waits for installation; it does not construct the session. |
| `invalid_backend` or `backend_already_selected` | Match the backend's application ID and public contract. Keep one owned session/binding for the page lifetime; reconnect through that session rather than installing a second backend. |
| `signal_unavailable` | Install that same session's `signals` with `tendril.signals.install(session.signals)`. Live signals are disposable; successful send is not a durable application write. |
| Adapter installed, but commands wait or no peers are visible | Inspect `session.status` and the one participation controller's status. Confirm the intended native process/browser Worker is running, has current grants and keys, and uses the same application. Check the host introduction adapter and actual environment RTC/relay openers. A resident host page does not keep an application coordinator running. |
| Direct RTC fails | Let the owned adapter use its bounded relay fallback. Inspect the selected transport and relay reachability. Do not add an application retry/election loop or a second participation controller. See [peer connections](PEER_CONNECTIONS.md). |
| Participation reports `approval-required` | Display the exact current recovery proposal and its freshness/loss evidence. Call `approveRecovery(proposal.id)` only after that proposal is reviewed. Changed authority can invalidate it; do not approve an old proposal automatically. |
| `status.database` is `idle` while signals/control work | This is expected before durable data is used. Exercise a real command or coherent query when the task needs retained state; adapter readiness does not activate the database. |
| First data use fails or reopen cannot find the existing device store | Inspect the actual Worker error and storage capabilities. Keep the existing device's record-backend pin and signer. A capability probe can diagnose a fresh store's eligibility; it does not enroll a device, migrate a store or repair lost history. |

An IndexedDB record backend does not establish SQL/WASM support. SQL has its own
engine assets and capability requirements. Saving page code for offline use and
adding it to the Home Screen are also separate from application-data durability
and device enrollment. See [application storage](APPLICATION_BACKENDS.md) and
[browser setup](BROWSER_API.md#home-screen-setup).

## Lost replies, operation outcomes and recovery

Use the original operation ID to inspect uncertain work:

```sh
tendril --session ./application.mjs operation add-item-1
tendril --session ./application.mjs retry add-item-1
```

| Observation | Meaning and next step |
| --- | --- |
| `saved` | The exact signed attempt is durable locally. It does not prove acceptance, applied execution or another peer's retention. Keep its identity and inspect/wait for progress. |
| `applied` | Inspect accepted/rejected outcome, generation and revision. Query a coherent view in that selected history. Applied work can still be abandoned by explicit recovery. |
| `shared` | Retained coverage is observed separately from application acceptance. It is not a promise that every peer has the data or that recovery can never exclude it. |
| Timeout or disconnected waiter | The operation may already have been accepted. Inspect and retry the original saved attempt; cancelling the wait does not cancel the command. |
| `abandoned` or `needsReapply` | Show the recovery and affected work. Capture the current view, review the original intent and guards, and deliberately reapply under a fresh operation ID linked to the original. Do not silently replay an abandoned branch. |

Release each captured read view after use. A `changes` notification is an
invalidation to reread, not a durable event cursor or an acknowledgement of an
external effect. [The application contract](APPLICATION_BACKENDS.md) and
[CLI recovery commands](tools/CLI.md) describe these boundaries.

## Signed publication

The host returns lowercase error codes. A directly called Chronolog API may
report the corresponding uppercase `PEER_...` code.

| Code | Next action |
| --- | --- |
| `peer_publication_forbidden` or `peer_publisher_account` | Check the real signing device's explicit `publisher: true` grant and its account enrollment. Control administrator or application writer rights alone do not grant publication. Have an authorized administrator grant the intended right; never substitute a different signer secretly. |
| `peer_publication_control_changed` or `peer_publication_conflict` | Read and verify current authority and `control.publication()`. Check whether the original publication was already accepted. If preparing a changed release against a new head, review it and use a fresh operation ID. Keep the old signed attempt intact. |
| `peer_publication_operation_reused` | The operation ID already binds different signed content. Retry the original intent exactly, or use a new operation ID for the intentionally changed release. |
| `peer_publication_content_missing`, `peer_publication_assets_invalid`, `peer_publication_bytes_invalid`, or `peer_publication_asset_mismatch` | Repack the complete authored directory. Check sorted canonical paths, content hashes, sizes, media types, HTML entry and canonical base64 asset bytes. Supply every missing referenced asset. If the intended graph changes, prepare a new release rather than altering saved signed bytes. |
| `peer_publication_semantics_mismatch` or `peer_publication_scope_mismatch` | Compare definition/engine commitments and application/history identity with verified authority. Publishing a different application's bundle cannot repair its bootstrap. |
| `peer_publication_file_too_large`, `peer_publication_too_large`, or `peer_publication_history_limit` | Inspect effective host and publication limits. Reduce the authored graph where possible; a bounded history limit requires an explicit lifecycle decision. Do not split one coherent release into unsigned partial updates. |

After a lost publish response, retry the original publication operation with the
same files and saved intent. An accepted exact retry returns its original receipt.
A loaded page may still be pinned to an earlier immutable publication; compare
its publication identity before diagnosing a code update as missing. Restoring
old code is a new signed publication, separate from application-data recovery.

## Report the actual boundary

Ordinary application commands, queries and live signals travel through peers.
With a direct connection, the host can remain idle during those edits. Relay
connections carry encrypted peer traffic through the host and consume bandwidth;
coarse discovery renewal and explicit control/publication calls also use it.
Do not interpret zero host application writes as a failed save, or claim zero
host traffic for a relay-backed session.

The ordinary host MCP endpoint administers host controls; it does not run domain
commands or wake an agent conversation. For application tools, subscribed events,
mounted UI handoff and the optional Workspace Agent route, use the separate
[ChatGPT setup and recovery guide](CHATGPT_INTEGRATION.md#troubleshoot-setup).
State which native process or integration actually
consumes the application work and how long it remains available. If a prerequisite
is missing, report the completed checkpoint, exact missing artifact/authority,
redacted error, preserved work and next action. Keep a separate persistence
service out of the repair unless the task requires a capability beyond the
documented application contract and that architectural choice is explicit.
