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
