# Evaluate onboarding from only the domain

This is a repeatable evaluation protocol for the journey from Tendriller's
homepage to a working session-connected application. It addresses a specific
failure: an agent can explain the architecture yet abandon the native application
lifecycle when it cannot find concrete setup instructions.
It also tests whether the agent treats provisioning and a connected process as
part of the requested deliverable, and whether discovered capabilities become
actual implementation choices instead of unused reading material.

**This document is a test plan, not a passing test result.** Repository checks,
link checks and existing application qualification do not establish that a fresh
agent completed this journey. Record each real attempt and its limitations.

## Set up an independent attempt

Use a fresh agent conversation and empty project directory, with no inherited
knowledge of Tendriller, maintainer-supplied source snippets or prepared session
bootstrap. Give it ordinary web/file/terminal tools and access to the public
artifacts available to a new consumer. Record the model, tool capabilities and
environment restrictions so a missing capability is distinguishable from a
documentation failure.

Use a disposable test application and an authorized owner account. The owner can
answer identity questions, complete sign-in and review required enrollment or
recovery decisions. Keep credentials and private application records out of the
evaluation report. A staged evaluation should use a deployed candidate host with
the matching public docs and artifacts. Record exact commits and artifact hashes;
a local source edit does not change what the domain serves.

Do not give the agent repository URLs, the name of a bootstrap module, an API
reading order, the expected architecture, or a list of endpoints. The first
input must be the domain and the user's desired outcome. For a staging run,
replace only the domain in this prompt:

> Build me a shared checklist using https://tendriller.dev. I want to add items
> and mark them complete in my browser, see the same list from your agent session,
> and keep my work when I reload. Give me the working page and explain how to
> return to it. Ask me for any identity or sign-in you actually need.

Do not rescue a stuck agent with implementation advice during the baseline
attempt. It may ask for owner identity, human claim, legitimate device enrollment
approval or an unavailable tool/artifact. Record those questions and the reason.
If a maintainer supplies architecture or code guidance, mark the attempt
**assisted** and keep the preceding failure trace; a successful continuation is
useful evidence but is not an unassisted completion.

## Observable completion criteria

| Stage | Evidence required |
| --- | --- |
| Discover | Starting from the domain, the agent finds a task-oriented build route and the compatible public artifacts through published links. Record the URLs followed and any broken or inaccessible resource. |
| Prepare before claim | The agent saves a private handle, initializes and publishes the signed UI before requesting sign-in, starts the participant, and gives the owner the ready page and permission-review URLs. Claim retains the same publication and keys; no claimed reply or agent redeployment is required. |
| Reuse | The agent uses the task/capability map and imports or adapts current session/helpers where appropriate. Record exact files used and whether historical contrib links were mistaken for current APIs. |
| Define retained work | The authored application has a real checklist definition, declared commands and a coherent query/read path. Identify where an agent edits the model and UI for a different user request. |
| Configure authority | The actual public definition and execution commitments are configured; device grants and account bindings are explicit. The first generation is selected using a retained signed creation transition before opening the session. No invented digest, fixture-only authority or copied private signer stands in for enrollment. |
| Open and connect | Native and browser participants use the same application ID with their own authorized signing identities and persistent stores. The browser runs the session in its Worker. One participation controller owns connection/recovery behavior. Record actual session/participation status and selected transport. |
| Publish | The complete authored file graph is published through an authorized Chronolog control participant. Retain the publication operation ID and returned receipt; verify the selected publication through the session. |
| Browser to agent | Add an item through the published page's UI. Observe the command outcome and the same item through a coherent native session query. A DOM change or local draft alone does not pass. |
| Agent to browser | Submit a native checklist command and observe the browser update through its normal session path. Do not inject state or a fabricated receipt into the page. |
| Resume | Reload the browser and reopen the existing native device store. Confirm stable device identities and retained checklist content. Separate local reopen evidence from independent peer-retention evidence. |
| User experience | The app uses domain views appropriate to its main tasks. A separate second pass walks every main flow in fresh desktop and phone-sized profiles, checks navigation/keyboard/long content and empty/loading/error states, and records before/after screenshots and fixes using the [delivery matrix](AGENT_DELIVERY.md#the-user-experience-is-part-of-the-deliverable). |
| Explain | The final report gives the working page, what was exercised, how to resume, which peer/process must remain available, and material unverified limits. It distinguishes published code from a connected application. |

Keep the native session alive for the part of the evaluation that requires it.
The claim that an agent can receive page interactions requires an actual running
consumer or supported wake integration. A resident hosted page does not prove
that either exists.

## Failure rehearsals

After the first successful loop, perform these bounded checks in the disposable
application. Record exactly which environment and artifact tuple was exercised.

1. **Lost command response.** Interrupt the wait after submission without
   replacing the saved attempt. Inspect and retry the same operation ID. Verify
   that the intended checklist change appears once, and that the report does not
   interpret a timeout as a definite rejection.
2. **Unavailable peer.** Stop or disconnect the relevant peer, observe the UI's
   honest waiting/saved/connection state, then resume the same device. Verify
   reconnect uses the owned controller. Do not require a synthetic success or
   automatic recovery that discards work.
3. **Uncertain publication.** Lose a publication response and retry the same
   saved intent. Verify the original receipt is returned. Test a stale or changed
   release separately and confirm that the agent reads the current head and uses
   a new reviewed operation for changed content.
4. **Missing setup.** In a separate fresh attempt, omit an enrollment or required
   artifact. The agent should name the incomplete checkpoint and concrete next
   action, preserve the native route and avoid claiming completion. This is a
   successful diagnosis, not a completed application build.

Recovery that may abandon a history suffix needs an exact reviewed proposal.
If that scenario is included, record the adopted/abandoned evidence, visible loss
notice and deliberate reapplication under a fresh operation ID. Do not perform
lossy recovery merely to obtain a green onboarding score.

## Critical failure modes

| Failure | Why the attempt does not pass |
| --- | --- |
| A FastAPI service, hosted database or another persistence stack replaces the session because setup was unclear. | The agent has bypassed the platform path under evaluation. An intentionally required external capability must be explained separately; it does not satisfy this checklist task's native-state criterion. |
| The agent delivers a ZIP or local project and defers provisioning without attempting it. | The requested running application remains unbuilt. Record whether any real blocker was encountered or setup was simply treated as somebody else's prerequisite. |
| The result is a static page, unconfigured application, or installed adapter with no observed peer exchange. | It demonstrates only an earlier checkpoint. |
| The guide ends at undefined `session`, `authority`, `epochKeys`, `connectPeers` or an unknown `deployment.mjs`. | The first-app path still requires unprovided implementation knowledge. Record the exact unresolved variable/file and last successful step. |
| The agent assumes page login or an API token is a publisher/device grant. | Host access and signed application authority remain separate. |
| Agent tokens, native private keys or another device's signer are embedded in authored browser assets. | The published graph does not preserve the required credential boundaries. A browser must use its own enrolled identity. |
| A failed reopen silently creates an empty device, swaps storage backends or resets authority. | The apparent recovery loses identity/history instead of resuming it. |
| Changed input/files are submitted under an already-used operation identity. | This violates exact retry and conceals uncertainty. |
| `saved`, `applied`, `shared`, adapter readiness or offline code saving are presented as equivalent guarantees. | The user cannot assess persistence, connectivity, replication or recovery correctly. |
| A full-featured request produces only a JSON/field editor, or the agent skips the separate browser UX pass. | Working plumbing does not establish that the person can complete the intended tasks; record missing flows and evidence. |
| The result promises ongoing agent responses after its only consuming process exits. | The demonstrated runtime does not support the promised interaction. |
| Production, mobile or Internet reliability is claimed from only local mocks or a desktop preview. | The evidence does not cover the reported environment. |

## Record an attempt

Keep a concise redacted report with these fields:

| Field | Record |
| --- | --- |
| Identity | Evaluation date, model/agent configuration, fresh or assisted context, tools, OS/browser, and network restrictions. |
| Target | Service origin, deployed core commit/release/runtime, exact Chronolog and tools artifacts and hashes, and relevant cookbook reference. Mark unknown values explicitly. |
| Discovery | Ordered entry URLs, failed reads, missing links/artifacts and the point where the agent first chose its implementation path. |
| Human input | Every question/intervention and whether it concerned user intent, owner claim, legitimate authority, missing tool access or undocumented platform mechanics. |
| Progress | First successful checkpoint, time to first observed shared command, total active work, and each unresolved stage. Record wall time separately from owner sign-in wait. |
| First action and reuse | Time to the actual page creation/owner claim URL; the step at which a connected process was started; supplied modules imported/adapted; duplicated features and their stated reason. |
| Behavior | Public application/device identities, command operation IDs and outcomes, coherent read evidence, same-device reopen, selected transport and publication receipt identity. Redact credentials and sensitive content. |
| UX review | Main-flow matrix, actual desktop/phone viewports and browser, before/after image links, observed friction and fixes, and explicitly unverified checks. |
| Artifacts | Authored application files and private build-record location, plus public-package provenance. Keep private bootstrap material out of any public report. |
| Outcome | `complete`, `blocked`, `failed`, or `assisted`; exact reasons, first failing step, and whether the critical failure modes occurred. |

Compare attempts using unassisted completion, the first failure point, unnecessary
maintainer input, missing setup files and time to the first real shared command.
Do not improve the score by concealing a required authorization step or by
counting static publication as application completion. Repeat with at least one
fresh agent after a material onboarding change; one successful run is evidence
for that run, not a guarantee for every agent environment.

## Automated gates and their limits

Run the repository's normal checks for the candidate changes. These are separate
evidence from the cold-start evaluation:

| Gate | Establishes | Does not establish |
| --- | --- | --- |
| `npm run check` | The configured contract, type, build, boundary, runtime, host, consumer and tools checks pass for that checkout. | A new agent can discover and compose an app from only the domain. |
| `npm run check:release` | Core checks plus the configured browser gates pass. | A particular live service, owner sign-in or physical device is qualified. |
| `npm run test:first-app -- --session-archive PATH` | The downloaded app runs against a packed host and real native/browser sessions, including exact retry and reopening. | An unaided agent naturally chooses that route or a temporary process survives the conversation. |
| `node scripts/check-deployment.mjs https://SERVICE_HOST` | The script's public service, guide, automated-client and runtime probes succeed on that host. | Signed publication, device enrollment or application synchronization has been exercised by a fresh agent. |
| [Three-repository qualification](RELEASE_COMPOSITION.md) | Recorded independent consumers compose the exact supplied core, Chronolog and cookbook artifacts under their stated scenarios. | The task-oriented entry path is comprehensible without maintainer help. |
| This domain-only evaluation | The recorded agent attempt reaches or fails the concrete user outcome through naturally discovered resources. | Broader mobile, recovery, security or production guarantees outside its observed scenarios. |

Navigation/build regression checks should verify that the homepage's first-app
link, agent index, build guide, troubleshooting guide and linked runnable assets
are actually served and packaged. Assert meaningful links and contracts rather
than exact prose. A changed guide title should not fail a test; an absent setup
file, unserved route or unusable example should.

Publish the outcome only when the corresponding run exists. If the environment
cannot access the host, compatible artifact or required owner authorization,
record the blocked stage and complete the checks that are available. Keep that
limitation visible alongside the result.


## MCP-only discovery scenario

In a fresh chat with only the Tendriller MCP connection selected, request:
“Build me a small checklist page I can use on my phone, and connect it to this
chat.” Start with an account that has no assistant-connected apps. Do not supply
repository paths or install the bundled skill as hidden prior context.

Record whether the agent finds `tendril_guide`, reads `start` and `build`, uses
the connected service origin, checks live readiness before package installation,
and checks its execution capabilities. Record the environment label, core release,
runtime ID and explicit source checkpoint (or its absence). With a
supported native runtime, apply the full build and delivery criteria above.
Without that runtime, the expected result is a concrete runtime handoff with
same-origin build instructions and an honest blocked status. Searching for
unrelated plugins, inferring that an empty list disables creation, or delivering
a static website as the connected app fails this discovery scenario.

Also test an existing but unconnected app: the agent should follow `connect`
and the existing participant's review URL rather than create a replacement.
The automated MCP regression follows the guide/tool/resource and empty-list
path, including anonymous discovery and staging links; it does not substitute
for this fresh-agent behavior evaluation.

Run these failure variants against an isolated test deployment as well:

- Use an installed tool catalog without `tendril_guide`. The agent should recover
  through `get_profile` or `list_tendrils` and their direct same-origin setup URLs,
  without guessing production or creating an application on another host.
- Pause new page creation. The agent should report the readiness blocker before
  package downloads, dependency installation or a creation request. Existing
  application calls remain subject to their separate permissions and write state.
- Make readiness unavailable, malformed or unsupported. The agent should name
  the exact blocked preflight and keep the selected origin; an HTTP 404 is not a
  compatibility exemption allowing speculative creation.

After shipping discovery changes, refresh the real installed plugin's tool
catalog and repeat the empty-account scenario. A source-level `tools/list` test
does not establish that ChatGPT's installed plugin exposes the updated guide.

## Maintained acceptance harness

`scripts/agent-acceptance/cli.mjs` maintains six parts of this procedure:

1. An independent Codex app-server conversation in an empty project with an
   isolated home, model credentials only, and the ordinary checklist prompt above.
2. Separate domain-only and account-authenticated MCP discovery modes. MCP uses
   the selected origin's genuine catalog and results, with OAuth renewed before
   every turn. No handcrafted tools or maintainer instructions substitute for discovery.
3. A paired headless owner browser using the existing private review-access
   account, with explicit exact permission review and ordinary UI interactions.
4. Timestamped private observable evidence and a minimal shareable report, binding
   the deployment to the exact clean release composition and artifact hashes.
5. An observer protocol for signed publication, both command directions,
   reload/reopen, lost responses, peer absence, missing setup and cleanup.
6. A separate external-host report protocol, including honest attribution for
   actual ChatGPT web observations. Native Codex never qualifies ChatGPT web.

The harness does not deploy, change readiness, reset accounts, install a service,
or control existing reviewer processes. Use a disposable application. The parent
operator deploys and qualifies the selected checkpoint before starting a live run.
No package.json change is required; the tests join the existing `test:ci` glob.

### Prepare and launch

Use Node 24, a model-authenticated `codex` CLI with the app-server protocol, the
repository's installed Playwright package and Chromium. `npm ci` is the ordinary
development dependency gate. The launch preflight reuses
`scripts/review/preflight.mjs`: the release checkout must be clean with prepared
release artifacts, and the selected service must advertise open creation readiness
and that exact source/release/runtime/composition tuple. This gate runs before
owner login, OAuth, model turns, or acquisition of application packages. A pause,
unavailable/unsupported readiness, stale deployment, or missing artifact stops
the run; the private failure record retains the exact prerequisite/next action.

Choose a **new absolute directory outside every source checkout**. The harness
creates its empty `project/`, isolated `home/`, temporary files and evidence there.
It copies only the model auth file to that isolated home and removes the isolated
Codex credential/cache directory on shutdown. It disables host tracing/telemetry.
It inherits PATH and optional OPENAI_API_KEY, not maintainer environment,
configuration, skills, memories, repository snippets or review credentials.
Account-linked apps and remote plugins are explicitly disabled along with host
skill discovery. Before each turn, the complete MCP server catalog must be empty
for domain mode or contain only the configured selected-origin server for MCP
mode. An observed call to another server stops and marks the attempt contaminated.
An isolated home alone does not disable account-linked app tools in all Codex versions.
Any instruction sources reported by `thread/start` fail the baseline closed.
This is context isolation, not an OS security sandbox: the agent has host network
and filesystem access with approval policy `never`. Run on a disposable evaluator
host when filesystem/process isolation is required. Protect the private account
and run directory accordingly.

```sh
node scripts/agent-acceptance/cli.mjs run \
  --origin https://staging.tendriller.dev --mode domain \
  --release-root /private/clean-deployed-release \
  --access /private/review-access.json \
  --output /private/acceptance/new-domain-run \
  --observer-config /private/acceptance/new-domain-observer.json \
  --seconds 1800
```

Use `--mode mcp` for the separate MCP-only prompt (no domain, guide names or
architecture hints). The owner signs into the dedicated account and performs
real PKCE consent through `scripts/review/access.mjs`. Before each model turn,
the harness obtains a fresh account token and reloads the app-server connection.
If a token expires during a long-running turn, the bridge renews it on an actual
upstream HTTP **401** using the same real owner OAuth flow, then replays the exact
buffered request once. Concurrent 401s share one renewal; delayed 401s from the
old credential reuse the already renewed token. The selected service authenticates
before MCP dispatch, so this replay does not duplicate an admitted application
command. A 403, tool-level error, other status, or second 401 is never retried.
Body bytes, method, session/protocol headers and source tool results are preserved;
only the bearer changes. There is no periodic/background OAuth refresh and no
extra model message. Renewal has a 30-second deadline within the request's
60-second budget. Disconnecting the last waiting request or closing the bridge
cancels renewal; cancellation closes only that flow's OAuth page. Renewal failure
returns a transport failure without exposing credentials or retrying dispatch.
Successful request-driven renewals are timestamped privately in `mcp-auth.jsonl`.
A loopback transport forwards only to the selected origin's `/mcp`, with redirects
disabled, preserving the genuine tools/results. Bearer tokens remain in the
harness process, outside the model shell environment. The real catalog and its
hash are recorded; an absent catalog blocks the turn. An empty account is a
scenario prerequisite to verify independently, not a reason to erase existing apps.
An MCP error never silently falls back to domain discovery.

The launcher stays in the foreground until stopped or its model/owner work window
expires. Individual RPC, browser and observer actions also have deadlines. The
private `control.sock` accepts only local filesystem-authorized requests. In a
second terminal, inspect the sanitized progress, and read `observable.jsonl`
privately to find the page/review URLs and actual agent questions:

```sh
node scripts/agent-acceptance/cli.mjs status --output /private/acceptance/new-domain-run
node scripts/agent-acceptance/cli.mjs owner --output /private/acceptance/new-domain-run --input /private/owner-action.json
node scripts/agent-acceptance/cli.mjs send --output /private/acceptance/new-domain-run --input /private/owner-reply.json
node scripts/agent-acceptance/cli.mjs observe --output /private/acceptance/new-domain-run --input /private/check.json
node scripts/agent-acceptance/cli.mjs stop --output /private/acceptance/new-domain-run
```

The running controller is the **single report writer**. Use `control(run,
{action: 'observe', input: {check, options}})` or the `observe` CLI above for every
live measurement; an external adapter also returns its result through this IPC.
Do not instantiate another `Evidence`, import results directly, or edit/merge
`report.json` while that controller is active. Those unsupported competing writes
are overwritten by its next model/owner event. The report is an atomic snapshot
of the controller's own instance; `status` returns that same instance. Owner
actions alone do not imply passed checks: call `observe` at each checkpoint.
`deadlineAt` is reported in advance. Preserve expired reports as expired partial
attempts; a later evaluator continuation is not a resumed innocent model thread.
Use `--seconds 7200` when owner review and fault rehearsals need that bounded
window. Run one cold app at a time when a shared account's resident quota must
leave room for independent CI fixtures. Use a short run path such as
`/tmp/td-acceptance-domain-1` for the filesystem controller socket.

`send` input is `{ "kind": "identity", "text": "…" }`. Allowed categories are
`identity`, `sign-in`, `review`, `visible-error`, `user-outcome` and
`maintainer-advice`. Give identity only when asked. Sign in and review only the
actual app and device/capabilities requested. Report visible errors literally;
do not diagnose implementation or provide code. Report ordinary checklist outcomes
to continue the conversation. All inputs are timestamped and hashed in the report;
`maintainer-advice` permanently marks the attempt assisted. Categorizing advice
as identity does not make it unassisted: review the private inputs when judging it.
No owner reply is sent automatically after a claim. The original user prompt
contains no observation checklist, endpoints, architecture, private handle or secrets.

### Exact owner actions

`owner` input is one of these JSON objects. Select labels from the actual page;
the harness never evaluates model-supplied JavaScript or supplies application code.

```json
{ "action": "navigate", "url": "https://staging.tendriller.dev/ACTUAL_REVIEW_PATH" }
```

```json
{
  "action": "review",
  "expected": {
    "fingerprint": "EXACT VISIBLE FINGERPRINT TEXT",
    "rights": "EXACT VISIBLE RIGHTS TEXT",
    "retainedPrefix": "EXACT VISIBLE RETAINED PREFIX TEXT"
  },
  "permissions": ["EXACT SELECTED CHECKBOX LABEL"],
  "button": "EXACT APPROVAL BUTTON NAME"
}
```

Other actions are `inspect`, `fill` with `label` and `value`, `click` with `name`
and optional accessible `role`, `reload`, and `reopen`. Reopen closes and recreates
the page in the same browser context; it does **not** establish browser-process
restart or independent peer retention. Navigation rejects foreign origins and
credential-bearing URLs. Action results contain visible page text and remain
private. Login uses a static URL and a separately filled private account code;
credentials are never a model input. Exact review text must be chosen by the
evaluator after inspection, not guessed or approved by checking every checkbox.
For a device review with one approval button and no permission checkboxes, use
`permissions: []`; the exact fingerprint, rights and retained-prefix checks still
apply. Add the application/account text to `expected` when checking those fields.
`inspect` also returns a private `view` of definition-list fields, link targets,
non-secret visible inputs, and the displayed proposal JSON, so the evaluator can
choose actual values without exporting browser keys or injecting state.

`open-link` with an exact accessible link `name` follows that real link in a new
owner tab; `return-page` closes it and restores the retained app tab. These actions
support the browser review flow without an external browser driver or report
writer. `wait` accepts a selector, `condition` (`visible`, `enabled`, or `text`),
optional text `value`, and `timeoutMs` up to 30000. It only observes the DOM. If a
review form reports expired/already used, navigate with GET to the same review
link, compare the unchanged proposal/fingerprint/rights/prefix, then approve; do
not replace the browser key or start a new enrollment to bypass that message.

### Maintained starter observer (no custom module)

Use `--observer-config /absolute/private/run-observer.json` for a checklist or
shared-notes app derived from the published starter. The maintained observer is
`scripts/agent-acceptance/observer.mjs`; there is no executable for the operator
to author. The config can be absent at launch and completed **after** the innocent
agent produces its project. It is read only by the evaluator, never sent to the
model. Keep it outside the agent project. A nested native project within the
run's empty `project/` is supported. Do not infer paths or identities from this
example: copy them from the app actually produced in that run.

```json
{
  "protocol": "tendriller-starter-observer-v1",
  "origin": "https://staging.tendriller.dev",
  "applicationId": "ACTUAL_64_HEX_APPLICATION_ID",
  "historyId": "ACTUAL_SIGNED_HISTORY_ID",
  "native": {
    "project": "/private/acceptance/new-domain-run/project/actual-app",
    "module": "session.mjs",
    "export": "attachSession",
    "profile": "main",
    "handle": { "file": ".tendriller/handle.json" },
    "descriptor": { "file": ".tendriller/descriptor.json" },
    "deviceId": { "file": ".tendriller/initialized.json", "pointer": "/deviceId" },
    "deviceStore": ".tendriller/device.sqlite",
    "process": {
      "pid": 12345,
      "argv": ["/absolute/node", "session.mjs"],
      "resume": ["/absolute/node", "session.mjs"],
      "storage": ".tendriller/device.sqlite"
    }
  },
  "query": {
    "name": "notes", "input": null, "rows": "/value",
    "marker": "/text", "operationId": "/operationId", "author": "/author"
  },
  "browser": {
    "device": { "selector": "#device-key", "read": "value" },
    "rows": "#notes li",
    "status": { "selector": "#connection", "read": "text" },
    "waitingText": "ACTUAL_VISIBLE_WAITING_TEXT"
  },
  "commands": {
    "browser-to-agent": { "name": "addNote" },
    "agent-to-browser": {
      "name": "addNote", "input": { "text": "unique agent marker" },
      "marker": "unique agent marker", "operationId": "unique-local-agent-operation"
    },
    "lost-command-response": {
      "name": "addNote", "input": { "text": "unique lost-wait marker" },
      "marker": "unique lost-wait marker", "operationId": "unique-local-lost-operation"
    }
  },
  "publication": { "operationId": "ACTUAL_SIGNED_PUBLICATION_OPERATION_ID" }
}
```

All `pointer` and query field paths are JSON Pointers, relative to the referenced
JSON object. File paths are relative to `native.project` unless absolute.
`native.deviceId` can alternatively be the actual public key string; `process.pid`
can be a JSON file reference. JSONL references accept `format: "jsonl"`, `line`
(a zero-based index or `"last"`) and a pointer into that entry. The process check
reads Linux `/proc`, matching actual cwd, argv and birth token, rather than
accepting a caller's "running" flag. It never sends signals or controls services.
Update the PID after an explicit restart; the retained identity binding stays fixed.

The observer validates the selected-origin handle, page/application/history and
pinned signed descriptor, pins identities on its first observation, then attaches
to the **existing** native session. It never falls back to `openSession`, creates
a signer, resets authority or opens a replacement native store. Native probes run
in bounded child processes with raw stdout/stderr discarded. The public codec and
Ed25519 verify the v1 signed attempt ID, exact envelope, historical grant and command
header; the existing native session supplies applied execution and coherent reads.
No private signing or epoch keys are exported. Host publication/authority checks
use the installed public SDK's actual verifiers. This envelope check does not
independently decrypt/re-execute the operation body.

Browser measurements read the paired owner's actual page, public runtime identity,
device field and rendered rows. They require the configured app's page URL and a
distinct browser identity. `owner navigate` and `reopen` may use that one
observer-validated page URL on the service's page subdomain; this does not enable
arbitrary foreign navigation. No browser state or receipts are injected.
Preview page origins may differ from the service hostname. The configured handle
must still name the selected service API, and that authenticated host must confirm
the exact page ID, application ID and page URL before publication qualifies.
An open tab normally uses the documented immutable URL
`BASE/_publications/VERSION/DOCUMENT`. The observer accepts only that route or the
exact canonical base on the host-confirmed page origin and private link. The URL
version/document must agree with the public runtime identity; the host version
string must map to an independently verified signed receipt, and its HTML document
must belong to that signed file graph. The host's publication/version string
(for example `"2"`) is distinct from Chronolog's signed publication digest.
Other page IDs, private links, origins, arbitrary suffixes, unsigned documents,
version mismatches and credential-bearing URLs fail closed.

For checklist projections without operation/author columns, set
`query.operationId` to `null` and configure `query.eventTopic`, `query.eventId`
(such as `/payload/id`), and `query.rowId` (such as `/id`). The observer joins a
single authenticated operation event to its projected row within the **same
revision**; changed revisions block and require another observation. A missing
join cannot pass from a matching label alone. The browser row must expose the
operation ID (notes mode) or joined item ID (event mode), either in its text or
through an actual DOM attribute named by `browser.rowIdentityAttribute` (for
example `data-item-id`). `browser.rowIdentitySelector` selects a nested element
within each measured row when that attribute is on a checkbox rather than its
container. `query.eventIdEncoding: "author-operation-json"` supports projections
whose row ID is JSON.stringify([event.author, event.operationId]);
`"author-operation-colon"` supports `${event.author}:${event.operationId}`.
Both encodings use the independently verified event author and operation, never
a label supplied by the evaluator. No arbitrary
projection code is accepted by the observer. If the produced app exposes neither, record the missing
metric; do not provide implementation advice to repair the baseline's score.

Use the normal `observe --input /private/check.json` controller command. Supported
check inputs and their sequence:

For an MCP-authored operation in the same native signer's separate adapter
namespace, the terminal attachment may correctly refuse inspection. Do not
broaden that binding or open another owner. If the model actually called
`inspect_application_operation`, `native.mcpOperations` may map its canonical
operation ID to the retained completed event, for example a file reference to
`observable.jsonl` with `format: "jsonl"` and the exact zero-based `line`.
The observer accepts only that selected server/tool and matching client request,
application/history/device/operation/attempt reference. The response must contain
the **raw signed attempt**, whose signature and historical grant are verified
independently. It still requires the exact authenticated applied event in a
coherent native read and the matching browser row. A receipt, saved status or
model completion message alone cannot substitute for those bytes. Native probe
results record their implementation SHA-256, including when a separately forked
probe was fixed after controller launch; retain the controller's original source
identity and do not relabel the entire run as having used a newer harness.

| Check | Input/options and observed proof |
| --- | --- |
| `preclaim-publication` | Observe before claim; independently verify the selected signed publication and unclaimed host response. |
| `authority`, `publication` | Verify pinned authority, grants and selected generation. Immediately after claim, call `publication` with `options.phase: "claim-boundary"` before allowing a further republish: the exact signed receipt must be unchanged and the authenticated owner must match. Later `publication` calls verify the actually selected release/browser version and the signed CAS parent lineage back to that retained boundary. A legitimate v2 after claim does not invalidate the v1 claim proof. Missing boundary/parent receipts block instead of inventing continuity; `publication.ancestors` may reference actually retained intermediate receipt JSON files, whose signatures/scope/revision chain are reverified. |
| `browser-to-agent` | Owner adds a unique marker through the ordinary UI. Supply `options.operationId` and `options.marker` from the visible result. Signed author must equal the measured browser device. |
| `agent-to-browser` | `options.action: "submit"` submits the configured command once using a coherent revision and stable local operation ID. Observe again without an action when the browser renders it. Native attachment aliases and the canonical signed ID are both retained. |
| `browser-reload`, `native-reopen` | Supply `options` with `phase: "before"`, `operationId`, `author`, `command`, `marker`. Perform actual owner reload/reopen or explicit same-store native restart, then observe with `phase: "after"` and the same fields. Native restart requires a new process birth token and the same measured store inode/device/signing identity and signed attempt. No process is restarted by the observer. |
| `lost-command-response` | `options.action: "submit-lost"` submits the configured operation, then deliberately interrupts its applied waiter. This remains blocked until `action: "retry"` inspects/retries the same saved signed attempt and sees one applied result in native and browser rows. If a response won the interruption race, it reports that the loss was not established. |
| `lost-publication-response` | Configure `publication.intent` (a file reference selecting the existing signed publication) and `publication.assets` (its saved public SDK asset array). `options.action: "drop"` retains the exact intent before calling publish, discards the real acknowledgement, and retains only its witness digest. `action: "retry"` must recover the identical versioned receipt and selected signed head. This is evaluator-side acknowledgement loss, not a network partition or browser retry qualification. No publication is newly signed by this observer. |
| `connected` | Requires measured native peer status containing the browser's device, exact process details, explicit browser grant and a file reference `native.transport` containing the maintained relay probe’s complete current observation. Protocol, live PID/birth, page and both device identities, freshness, paired lanes and binary traffic are verified. A string label or configured desired transport is not evidence. WebRTC requires separately attributed external-host evidence. Many attachment facades do not expose participation status; report this check blocked rather than infer it. |
| `unavailable-peer` | `options.phase: "before"` measures the native process and browser. Stop only this disposable participant externally. `phase: "offline"` verifies its exit and actual visible waiting text. Resume the same device and observe with normal browser-to-agent marker/operation options. |
| `discovery` | Domain mode measures successful model terminal reads of same-origin service, discovery, readiness and build guide URLs. MCP mode measures an actual `tendril_guide` (`build`) result from the sole selected server, requiring trusted returned origin, exact deployment/build, open readiness and the same-origin build-guide URL/body; `get_profile` is optional. Both must precede any observed install. Arbitrary tools, opaque responses, wrong origin/build or late discovery cannot pass. |
| `missing-setup` | Configure `missingSetup.report` to a separate actual harness run report and `expectedCode` to its prerequisite code. It must name this origin, a different attempt, blocked status and a concrete next action. |
| `cleanup` | After the agent/operator cleans up only the disposable app and stops its participant, verify actual host `not_found` plus the disappearance of the previously measured process birth token. Requires the preclaim and native process checkpoints. The observer does no deletion or service control. |

For example, after the owner adds a note:

```json
{
  "check": "browser-to-agent",
  "options": { "operationId": "ACTUAL_BROWSER_OPERATION", "marker": "unique browser marker" }
}
```

Take `connected` as soon as both participants are enrolled and the native process
configuration is measured. It retains the process checkpoint before checking the
optional transport metric, so a transport-blocked observation still supplies the
owned-process prerequisite for later cleanup. Record every subsequent native
restart and stop all actual run-owned processes before the cleanup observation.

Discovery timing uses only allowlisted `commandExecution` and `mcpToolCall`
`item/started` IDs/timestamps held in memory. Their completed observations include
`startedAt` and `completedAt`; no raw start notification or reasoning is logged.
Every required HTTP read or MCP build-guide result must finish before
the earliest installation starts, including a failed or parallel installation.
Missing/malformed timestamps block; comparing completion notification times alone
cannot establish this order. Older attempts without start timing retain that
limitation and must not be relabeled as timing-qualified.

Domain discovery also recognizes literal origin variables in a narrow successful
`set -e` shell prefix of constant assignments and `curl --fail` reads. It never
executes captured code or interprets general shell control flow. When the same
command subsequently runs a guide bootstrap, the proof records prefix/continuation
order; its timestamps still bound the whole command. `firstInstallCommandStartedAt`
is that enclosing command's start, not an invented HTTP or npm timestamp. Acquisition
coverage includes recognized install/exec/dlx/npx commands and npm-shaped output;
silent arbitrary subprocess installers remain outside that coverage. Overlapping
installations in another command still fail the measured timing check.

The controller returns `status` and explicit `missing`/`mismatches` metrics.
If the native attachment exposes connected peers but no transport diagnostic,
leave transport unknown. For the existing public WebSocket relay only, the
maintained evaluator preload `scripts/agent-acceptance/transport-probe.mjs` can
observe a scoped same-store participant restart. Put a private JSON config
outside the model project with `api` (the exact owned handle API), `deviceId`,
`remoteDeviceId` (the measured browser key), `runDirectory`, and `output` (a
private file inside that run). Start the participant's original resume command
with `TENDRILLER_ACCEPTANCE_TRANSPORT_CONFIG=/private/probe.json` and Node's
`--import /absolute/harness/scripts/agent-acceptance/transport-probe.mjs`.
This is evaluator instrumentation; record the changed argv and restart, and do
not send the config, preload, or implementation advice to the fresh model.
The probe observes actual matching application/device relay sockets, both
matching paired-lane handshakes, and sent/received binary traffic. Construction
or a configured transport alone never establishes success. It records no
authorization protocols, URLs, application payloads, or private channel values;
a close/error clears the measured transport. Failure to persist an observation
terminates the instrumented participant with exit 74, so an old positive file
cannot qualify as a live process. Set `native.transport` to that complete file
without a pointer. The observer validates its protocol, live PID/birth, exact
page/native/browser identities, matching paired lanes and binary traffic. The
observation must be at most five seconds old (with one second clock tolerance);
observe immediately after an ordinary application command to produce activity,
without background polling or heartbeat traffic. It cannot
measure WebRTC or recover transport evidence from an earlier uninstrumented
process. Keep those cases blocked.

Missing files, unsupported attachment diagnostics, absent browser/session metrics
and incomplete before/after sequences remain `blocked`; a mismatched measured
identity, signature, operation, row or receipt is `failed`. It never fills gaps
with caller-provided success booleans. Private checkpoints are retained beneath
the run's `observer/` directory and never enter the model prompt or shareable
report. Keep a failed baseline intact. Unsupported checks do not require authoring
another module: leave them blocked, or record separately attributed external-host
evidence through the protocol below. There is no claim of universal app introspection.

### External observer adapter protocol

For hosts or applications outside the maintained starter observer's supported
measurements, the explicit external adapter remains available. Supply a
**trusted evaluator executable** outside the agent's project with `--adapter`.
It receives one JSON request on stdin, returns exactly one JSON observation on
stdout, and exits within 30 seconds. The harness supplies PATH only, bounds output
to 1 MiB, and suppresses adapter stderr. An observer must inspect actual native
queries, retained operations, signed host/session controls and browser evidence;
model completion text and application-authored assertions are not independent proof.
Writing an observer that returns unconditional success invalidates the run.
Keep private observer implementations and credentials outside the model context.

For `observe`, `/private/check.json` contains a `check` and optional `options`.
The executable receives:

```json
{
  "protocol": "tendriller-agent-adapter-v1",
  "action": "observe",
  "runDirectory": "/private/acceptance/new-domain-run",
  "project": "/private/acceptance/new-domain-run/project",
  "origin": "https://staging.tendriller.dev",
  "check": "browser-to-agent",
  "options": {}
}
```

Its response has protocol `tendriller-agent-observation-v1`, the same `check`,
`observedAt` as an ISO timestamp, `status` (`passed`, `failed`, `blocked`, or
`not-tested`), and an `evidence` object. Evidence stays private; the shareable report
contains only check status, source, timestamp and SHA-256 reference. Retain these
measurements (public identities and private paths must stay in the private evidence):

| Check | Evidence to collect |
| --- | --- |
| `discovery` | Ordered discovered URLs, failed reads, reused files/imports, install/create timing and exact downloaded package hashes. |
| `preclaim-publication` | `unclaimed: true`, `signatureVerified: true`, `publicationId`, `operationId`, receipt, observation before claim, same signed head after claim. |
| `authority` | Actual public definition, creation transition, reviewed device fingerprint/rights/prefix and their verified selection. |
| `connected` | `applicationId`, distinct `nativeDeviceId`/`browserDeviceId`, `transport`, and `nativeProcess` containing `pid`, `startedAt`, exact `resume` command and `storage` location. Include connection/session observations. |
| `browser-to-agent`, `agent-to-browser` | `operationId`, `commandOutcome: "applied"`, coherent `query`, unique `marker`, `browserObserved: true`, `nativeObserved: true`; actual UI/command and read results. |
| `browser-reload` | Browser device identity before/after reload and persisted marker/read observations. |
| `native-reopen` | `beforeDeviceId`, identical `afterDeviceId`, `retained: true`; stopped/restarted PID, exact store/resume command, actual reopened query. |
| `lost-command-response`, `lost-publication-response` | `responseLost: true`, equal nonempty `operationId`/`retryOperationId`, equal SHA-256 `attemptHash`/`retryAttemptHash`, `appliedCount: 1`; retained signed attempt and original receipt after retry. Publication also requires equal `receiptId`/`retryReceiptId`. |
| `unavailable-peer` | Disposable peer stop, visible honest UI state, same-device reconnection and retained work. |
| `missing-setup` | Separate fresh attempt identifier, omitted prerequisite, actual diagnosis and next action; do not break the baseline's authority. |
| `publication` | Verified signed selected head, complete authored graph and receipt bound to the observed live page. |
| `cleanup` | `ownedApplicationsReconciled: true`, `nativeProcessesStopped: true`, `persistentReviewerServicesUntouched: true`, deletion receipts for this run only, or confirmed no creation. |

The schema rejects missing round-trip, connection, preclaim, reopen and retry
measurements. Other measurements still need evaluator review: a schema cannot
prove an external observer's honesty. The report never converts model messages
into passed checks. Every check must pass for `complete`; missing evidence remains
`blocked`, a failing observation produces `failed`, and advice produces `assisted`.
Perform preclaim observation **before** claim, and cleanup observation **before**
`stop`. Stop terminates the owned app-server process group, closes Chromium and
the transport, and records actual start/stop/exit details. Detached participants
or services need explicit observer accounting; the harness does not stop unknown
PIDs or existing services. Private project/device records remain for uncertain
operation reconciliation. Delete them only after run-owned remote cleanup is proven.

### External hosts and unavailable browsers

When a local browser is unavailable, `--no-browser --adapter /absolute/observer`
supports a domain-mode run with an external owner. It records that limitation;
it neither creates browser evidence nor permits unauthenticated MCP mode.
If testing a different host, including actual ChatGPT web, use:

```sh
node scripts/agent-acceptance/cli.mjs external-report \
  --output /private/acceptance/new-external-run --input /private/external-host.json
```

The envelope protocol is `tendriller-external-host-v1`, with `host` (`chatgpt-web`
or `other`), `mode`, `origin`, `environment` (model, tools/catalog, browser and
restrictions), exact `initialPrompt`, `sessionEvidence` (actual host session and
visible observation references), `interventions` (`kind`, `text`), and
`observations` in the adapter response format above. Do not include reasoning,
chain-of-thought, raw session dumps, or credentials. Import retains environment,
prompt and session references privately. External ChatGPT evidence is labeled
`external-attested`, never native-verified. An absent browser session is
`not-tested`; a native Codex success cannot fill it in. Reviewer inspection of
the real external session remains necessary. External reports do not control or
promise future wake of an existing ChatGPT conversation.

### Tests, evidence privacy and limits

```sh
TENDRILLER_ACCEPTANCE_BROWSER=1 node --test scripts/test/agent-acceptance-*.test.mjs
node scripts/agent-acceptance/cli.mjs protocol-smoke \
  --output /private/acceptance/new-protocol-smoke --seconds 20
npm run check
```

The local tests exercise actual stdio child processes, protocol event filtering,
RPC errors/exits/deadlines, observation validation, bearer refresh forwarding,
coalesced HTTP-401 renewal with exact replay, denial/cancellation behavior and
a real headless Chromium owner against a synthetic local form/checklist. The
fixture's localStorage is only an owner-driver test, not Tendriller persistence
evidence. `protocol-smoke` starts the installed real app-server, initializes a
fresh ephemeral thread and shuts it down without a model turn or remote app.
Neither substitutes for the parent's bounded live staged model/owner run.
The default core gate runs protocol/owner-contract tests and explicitly skips the
real Chromium case; the command above enables that case on browser-equipped hosts.
The standalone `agent-acceptance.yml` workflow enables the same local Chromium
regression in the repository's pinned Playwright container. It needs no model or
review-account credentials and does not claim a live acceptance run.

Files/directories are private (0600/0700). The model thread is ephemeral; reasoning
events/deltas and entire turn dumps are never written. Only allowlisted completed
observable messages/tools and minimal turn status are retained. Raw stderr is
discarded. Tool outputs, owner text, prompts, URLs, application private stores and
external observation details can contain secrets: **do not publish the run directory**.
Only the minimal `report.json` is intended for reviewable sharing after inspection.
It includes exact deployment/artifact identities, model/tool environment, timestamps,
intervention hashes, first shared-command time, first unresolved stage and process
lifetime. Detailed receipt/operation/identity/resume evidence is deliberately private.
Unknown or unperformed observations stay explicit. Preserve the failed attempt
before starting a fresh one; do not retrofit a baseline with hidden maintainer help.

A bounded omitted-owner-access check can use a new output directory, exact
qualified release root and deliberately absent `--access` file. It reaches the
anonymous preflight, then stops with `owner_access_missing` and the explicit
next action before OAuth, model turns or application creation. Retain that real
report for `missingSetup`; it qualifies this omitted prerequisite only, not a
model's diagnosis of every missing application setup. The owner driver also
supports `open-details` with an exact visible summary name for ordinary recovery
forms; it never selects hidden actions by script or expands unrelated panels.

### Classify frontend repairs separately from data synchronization

The source-722 live attempt exposed an authored pairing-profile mismatch. After
the agent published its repair as version 2, reloading the existing version-1 tab
still ran version 1. The agent later discovered the documented **Page options →
Open latest version** action; that action loaded version 2 before browser pairing.
Record this as **manual recovery from expected publication pinning after an
authored defect**, not proof of automatic frontend adoption or automatic update
notification. Retain the initial error and the extra owner interaction.

The deployed source explains the distinction: `server/src/files.ts`
pins `_publications/VERSION/DOCUMENT`, `runtime/src/utility.ts`
links explicitly to the canonical latest URL, and
`server/src/publication-watch.ts`, installed by the
host's waiting page, handles the first publication. The source-722 commit path
notified that watch only for `next === 1`; it did not provide a later-release notice
to an already published, unpaired tab. The observed custom page also did not show
such a notice. This is not evidence of a missing data-session subscription: the
failure occurred before browser enrollment and the publication pin was independent
of that enrollment.

A requirement that frontend repairs reach an existing tab before pairing needs a
separate test: publish v2 while the owner remains on broken v1, verify a visible
host/runtime update notice or an explicitly supported safe adoption path, choose
it, and prove v2 is executing with the same retained browser identity/request.
Do not silently auto-replace code with unresolved operations, and do not count a
manual latest-version navigation as automatic-update success. Missing update
notification remains an explicit UX/health-recovery gap until that test exists.

Maintain starter identity/profile wiring centrally rather than deriving it from
display labels. Qualification should first exercise the unchanged kit and then
adapt labels/domain operations while preserving its profile/key/storage bindings.
The evaluator must not supply that implementation guidance to a baseline model;
it belongs in maintained starter/SDK guidance naturally discovered on the service.
