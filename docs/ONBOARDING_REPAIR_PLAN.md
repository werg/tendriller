# Agent setup reliability repair plan

This checkpoint tracks the failures observed during the 20 November 2026
Tendriller setup attempt. The core draft PR is the cross-repository tracker;
implementation is committed and pushed in small increments so work can resume
without this conversation. No credentials, device stores, owner email, or private
page links belong in this plan.

## Evidence and scope

The selected account-linked MCP connector ultimately identified staging. Its
first empty application-list response did not expose that origin, and the agent
mistakenly created the application on production before establishing the binding.
The production page was claimed, initialized, and published. The publication CLI
returned `APPLICATION_SESSION_CLOSED`; a later signed-head read verified that the
same operation had committed all 16 files (594,520 bytes). A native command,
close/reopen, and exact retry passed without a duplicate. A staging creation
attempt returned HTTP 503 `creation_paused`. Browser enrollment, live MCP
commands, and a persistent running participant were not established.

The original failure does not prove the cause or timing of the publication
error, the reason the MCP response changed, or the operator's configured service
mode. Tests must reproduce the relevant boundaries without assuming those causes.

Starting points for this repair:

- Core: `aa3db19168784e49242116973461e0d1b7a4e02c` (`master`).
- Chronolog: `d1cc92bc1f03d2558cc03124333493baad35ea32` (`main`).
- Core already includes the rc.11 release update and preparation before owner
  claim. Verify and build on these changes; do not restore claim-first behavior.
- Production deployment, release publication, operator service-mode changes,
  plugin installation/catalog refresh, and owner authentication are separate
  operational steps. Repository changes must describe their remaining gates.

## Completion checklist

Checked items describe implemented repository behavior and focused validation.
They do not certify a deployment or an installed ChatGPT connection. The draft
PR records exact final qualification heads and results as they complete.
Companion drafts: [Chronolog #12](https://github.com/werg/chronolog-db/pull/12)
and [Contrib #30](https://github.com/werg/tendriller-contrib/pull/30).

### 1. Origin and connector discovery

- [x] Every account-linked discovery path identifies its canonical service
  origin, environment/instance, contract, and build/composition identity.
- [x] An empty application list explains that it lists assistant connections,
  not every page owned by the account, and includes a same-origin next step.
- [x] `tendril_guide` is advertised and exercised through the actual MCP catalog;
  clients missing the tool have an explicit same-origin HTTP fallback.
- [x] Setup rejects a saved-handle/requested-origin mismatch before mutation.
- [x] Staging documentation and links never silently switch to production.
- [ ] Installed-plugin acceptance verifies that every suggested tool is callable
  after both fresh installation and upgrade. This is a live release gate.

### 2. Operational readiness and paused creation

- [x] Publish an anonymous, machine-readable readiness surface without changing
  the strict `/api/service` descriptor contract.
- [x] Include creation availability, stable reason code, and actionable next
  step in MCP onboarding and public discovery.
- [x] Tutorial and CLI check readiness before creating a page; a paused service
  does not lead to an alternate origin, repeated creation, or an expensive build.
- [x] Tests cover open, creation-paused/read-only modes, unavailable readiness,
  and races where readiness changes before the create request.
- [x] Operator runbook records how to inspect/restore the intended staging
  readiness. No service mode is changed as part of this PR.

### 3. Release composition and usable public packages

- [x] Build one immutable composition manifest containing exact source commits,
  archive hashes, capability/export requirements, starter identity, and pinned
  Chronolog dependency identity.
- [x] Release qualification installs the actual public archives in an isolated
  consumer and imports assistant, onboarding, collaboration/browser,
  collaboration/native, worker, diagnostics, and the starter's real graph.
- [x] A version/build mismatch produces a diagnostic before partial setup.
- [x] The supported events-only path consumes a qualified pinned archive or an
  equivalent single documented bootstrap, without requiring agents to reconstruct
  several source repositories.
- [x] Release publication rejects incomplete, mismatched, dirty, or overwritten
  compositions as appropriate; source-built candidates retain distinct identity.
- [x] Ordinary staging/production deployment verifies that every exact advertised
  public release asset is already available before migrations, uploads or deploy.
  Separately scoped unpublished branch previews retain their own lifecycle.
- [ ] Publish and deploy the qualified composition, then verify deployed starter,
  MCP build identity, SDK, tools, and Chronolog agree. This is a release gate.

### 4. Publication outcomes and timeout recovery

- [x] A verified publication receipt remains available if selected-head refresh
  fails after the host has accepted the upload.
- [x] Distinguish an unknown upload outcome, a known accepted publication with
  head verification pending, and a verified current selection.
- [x] CLI timeout/cancellation retains its original cause when session cleanup
  raises `APPLICATION_SESSION_CLOSED` or another secondary error.
- [x] Error/result output retains the original publication operation identity
  and safe recovery guidance. Retry must reuse the same publication intent.
- [x] Reconcile an uncertain publication against the signed selected head before
  creating any new publication operation.
- [x] Regression tests inject delayed reads, lost replies, cancellation, and
  cleanup failure; preserve validation failures rather than report false success.
- [x] Help and examples consistently state that `--timeout` is in seconds.

### 5. Starter lifecycle, authority, and process status

- [x] Use the current assistant-enabled starter and close the owned supervisor,
  not only its session; attachments detach without shutting down the owner.
- [x] Match adapter capabilities to query, command, inspect, retry, wait, and
  reapply operations; explain original versus native operation references.
- [x] Preserve the same device identity and exact saved attempts on resume.
- [x] Report actual assistant approval/online status, process lifetime, and
  required native participant; proposing a connection is not live connectivity.
- [x] Keep event forwarding/wake consent-gated and distinct from ordinary
  assistant reads/writes and from persistence of the native process.
- [x] Owner claim, assistant permission review, and browser device enrollment
  remain explicit, distinguishable authority steps with resumable instructions.
- [x] Browser enrollment instructions prevent claiming external browser
  authentication from a user's separate successful sign-in.
- [x] Implement account-bound initiation through the scoped API/MCP/SDK, durable
  allocation journal, locally retained credential and exact intended-account claim.
- [x] Implement browser proof, service-origin owner review and exact native signed
  enrollment with retained retry state; login alone grants no device authority.

### 6. Usage and operational documentation

- [x] The notes query example passes JSON `null` explicitly; tooling explains
  omitted-input semantics without silently changing existing applications.
- [x] `--shared` explains its additional eligible-participant requirement.
- [x] Recovery instructions explain signer-scoped operation inspection and
  external/native references.
- [x] Backup/resume instructions explain how to verify checkpoint availability and exclude
  private state from authored UI and public archives.
- [x] Document independent browser login, managed execution lifetime, lack of
  public preview relay, and unsupported future ChatGPT wake without promising
  infrastructure the environment does not provide.
- [x] Keep first-app guide, CLI/MCP discovery, plugin skill, tutorial, and
  onboarding checks synchronized.

### 7. Acceptance and residual external constraints

- [x] Core `npm ci` and `npm run check` pass at the exact integrated source
  checkpoints recorded below; the PR records the latest source matrix.
- [x] Relevant Chronolog unit/integration/package checks pass.
- [x] Downloaded first-app qualification covers native write/reopen/retry,
  signed publication, and browser enrollment/replication/reload using the exact
  candidate composition; identify any environment-limited portions as partial.
- [ ] A fresh unfamiliar agent starts with only the selected plugin and the
  request to create a test page, reaches correct-origin readiness, and completes
  browser-to-MCP and MCP-to-browser round trips after owner actions.
- [ ] Paused staging fails early and clearly, without creating a production app.
- [ ] Deployed/plugin/browser acceptance records exact build IDs and evidence.

## Required account setup and reviewed pairing

Both required capabilities are implemented across the host, public SDK/MCP and
starter. [ONBOARDING_PROTOCOL_FOLLOWUPS.md](ONBOARDING_PROTOCOL_FOLLOWUPS.md) maps
the exact APIs, limits, storage identities, tests and selected-host acceptance
boundary. Account setup retains one allocation and credential commitment;
browser pairing retains one proved, reviewed proposal and signed-control attempt.
Existing OAuth grants acquire no implicit new rights. The per-page baseline is
fresh Durable Object revision 10; account setup requires the explicit
`0004_account_setup.sql` and `0005_account_setup_recovery.sql` migrations,
including the checked account-setup schema marker 3 and retained allocation fences.

Committed focused tests cover same-operation recovery, account/client isolation,
scope and credential freshness, wrong-account claim, allocation failures,
proof/account/origin isolation, exact review/CSRF, interrupted admission, expiry,
stale generations and replay after revocation. Full integrated checks, packed
browser lifecycle and deployed/installed-client observations remain separate
gates above; a source implementation is not a deployment claim.

## Attribution and work outside these repositories

The agent owns the initial production-origin assumption, the premature
production connection link, an unnecessary Sites discovery detour, the incorrect
initial default-branch guess, a rejected duplicate-path patch, and a corrected
timeout-unit example. Repository discovery, examples, and acceptance checks can
prevent recurrence; they cannot repair those past actions.

The managed environment's missing preview relay, separate unauthenticated browser,
web retrieval failures, and unavailable credentials for a particular backup
helper are not Tendriller defects. Improve actionable diagnostics and checkpoints,
but do not add credential workarounds or imply another session is authenticated.
The GitHub connector can checkpoint repository changes even though the local
GitHub CLI has no authenticated account.

## Incremental delivery discipline

1. Push this plan and open the core draft PR before implementation expands.
2. Commit each coherent fix with its focused tests and push it immediately.
3. Link the companion Chronolog draft PR and dependency direction in core.
4. Update the core PR checklist after every checkpoint with actual test evidence
   and remaining operator/release/live acceptance work.
5. Preserve user state; do not deploy, reset identities, replace uncertain
   operations, merge PRs, or silently change service origins.

## Checkpoint log

- Planning checkpoint: recorded the original evidence, current upstream fixes,
  cross-repository ownership, regression gates, and external release work.

- Implementation checkpoints: same-origin discovery and fail-closed readiness;
  packed API/export verification; CLI cancellation/outcome preservation; durable
  Chronolog receipts and reopen inspection; explicit assistant/event lifecycle;
  exact rc.12 composition and first-app kit; predeploy byte/identity/public-asset
  gates; current cookbook guidance; and required setup/pairing implementation.
- Dependency checkpoint: core pins clean Chronolog commit
  `2d4af2f458236b6871b14f9da004168169583a3b`, archive SHA-256
  `740ebc0d2e21bcaf689483f221626535fdec4a1316f33f2ed77bf981e39a2d07`.
  Its 22 targeted publication tests, lint/typecheck and independent packed
  consumer passed, including retained receipts after failure and same-device reopen.
- Intermediate integrated checkpoint `4c7090e69529d0bfd50265f1172de82dfe9a8aa6`:
  full core check and GitHub Public service/Agent onboarding passed. A later
  ChatGPT builder pin mismatch was corrected; all 203 local integration tests
  passed and the merged checkpoint's GitHub ChatGPT integration passed.
- Upstream `25b6b3bd6091e53e374ab3d2fcf4fef4cc27722c` was merged so its native
  MCP reviewer qualification and bounded Durable Object restart retries remain.
  The review runner now checks the exact companion/live build before fixture
  renewal and creation; uncertain creation/mode changes retain recovery files.
- Final integrated core/kit qualification is a separate gate above; this earlier
  evidence must not be relabeled as a final-head pass. Live release, operator,
  installed-plugin and unaided-agent acceptance remain open.
- A later companion checkpoint advances to clean Chronolog commit
  `e7f90ae8761f19a6111b1a1b18f095132454f4ff`, archive SHA-256
  `187f0e8c6bae155823df2d52e6f441ddeddf7f2a85150f2a22a9a7efa4140753`.
  This adds storage-version consistency checks; 25 targeted tests, full lint and
  typecheck and the independent packed receipt/reopen consumer passed.
- Concurrent remote fixes for same-origin SQL setup, inferred participant owner
  shutdown, publication graph revalidation and synchronized onboarding surfaces
  were incorporated without overwriting their commits. Final branch-head
  qualification results and any later corrections are recorded in the core PR.

- Scope correction: account-bound setup and reviewed browser pairing are required
  deliverables in this PR. Implement durable retry-safe allocation, retained
  credential commitments, authenticated device proofs, exact owner review and
  signed-control enrollment across the host, SDK/MCP and starter. Continue to
  distinguish implemented repository behavior from live deployment/owner gates.
- Account implementation checkpoints add retained private SDK/starter intents,
  OAuth API/MCP prepare/inspect/list, verified ownership, exact claim binding,
  D1 allocation fences and idempotent per-page initialization. Subsequent tests
  cover interrupted dispatch, expiry/orphan cleanup, missing/corrupt journals and
  retained credential scope/revocation. Focused results: 21 setup worker plus 6
  authority tests, 44 Admission/alarm/lifetime regressions and 6 setup SDK tests.
- Pairing implementation checkpoints add authenticated bounded challenge/proof/
  status, a script-free service-origin review, one-use session-bound CSRF and
  the native signed-control consumer. Ten pairing worker tests plus database and
  signed-control regressions passed 43 tests; pairing plus fresh setup-authority
  checks passed 16. SDK proof tests and five starter retry/lifetime tests passed.
- The current exact-kit browser candidate reached account-linked creation,
  retained browser proof, exact owner review, native enrollment and commands in
  both directions. Its first run stopped at native shutdown before complete
  reopen qualification. Keep the final packed-browser gate open until that
  complete run passes; earlier successful steps do not certify the whole journey.
- Contrib PR #30 advances to `02a6079426c275d6d45399aba598bdf14f07a8d7`, documenting
  implemented account setup and reviewed pairing with selected-host deployment
  boundaries. Its build/check passed 59 guides, 237 source decisions and 74 tests.
- Staging acceptance now checks public readiness and exact source before the SQL
  fixture build, test spawn or account/session writes. Neither its wrapper nor
  the native MCP reviewer opens a paused service. Any readiness recovery is a
  separately authorized operator action; tests retain existing uncertain-result
  recovery behavior and do not switch origins or modes.

## Qualified integrated checkpoints

On 20 November 2026, clean core source
`1ee9d095557497a76966554f596bfff7859f2c1d` passed `npm ci`, the full
`npm run check` and `npm run release:artifacts`. The full check passed **917
tests**: 264 script, 74 SDK contract, 72 collaboration, 93 runtime, 379 Worker
and 35 tools cases, plus schema, type, build, boundary and independent packed
consumer checks. Both Node 22.15 and Node 24
[hosted core jobs](https://github.com/werg/tendriller/actions/runs/44731655576)
passed at that same head. Clean local and hosted builds produced the same ten
immutable release assets and composition
`d433cfbb17c60ef0ec149a5f81d6edb08efd87d769f387bbef3395dd9fdd4046`.

The [full packed first-app job](https://github.com/werg/tendriller/actions/runs/44731655551/job/136272675480)
passed account-MCP lost-response recovery, publication before owner claim,
browser-held key proof, full narrow-screen keyboard review, durable native
ordering pause/restart, commands in both directions, same-device data after
reopen and natural native process exit. It also passed actual **Add agent**
approval and retained credential adoption, original setup-credential revocation,
loss of the original handle and a creation retry with **one original allocation**.
The [separate SQL starter job](https://github.com/werg/tendriller/actions/runs/44731655551/job/136272675954)
passed its explicitly pinned native SQL qualification; that historical SQL pin
does not become the events kit's current Chronolog identity.

These tests use synthetic owner/provider sessions and a local encrypted
WebSocket relay. The test-host forwarding Worker preserves upstream close
acknowledgment and physical socket closure while isolating the pinned workerd
cold hibernatable-WebSocket defect; it does not qualify direct production TCP
closure. No live OAuth provider, mobile/native RTC environment, installed
ChatGPT connection or unaided agent is certified by this fixture. The distinct
general browser suite timed out during its web-server startup at `1ee9d095`.
The later [complete Public service matrix at `f85c8143`](https://github.com/werg/tendriller/actions/runs/44732642146)
passed both Node versions, all browser suites, native ownership/recovery and
public artifacts; the [exact-kit and SQL jobs](https://github.com/werg/tendriller/actions/runs/44732642139)
also passed. That source passed **921 core tests**, including the focused
recovery additions below.

Investigation additionally reproduced a test-environment DNS portability issue:
Chromium mapped the local service/page names while Playwright's Node clients
relied on container DNS. The E2E configuration now gives both the same explicit
loopback resolution, preserving the real hostnames, HTTP/TLS origins, `/health`
readiness and timeout. A real Playwright runner/worker regression verifies both
readiness and API requests with their original Host headers. This is a
demonstrated portability improvement; the earlier hosted timeout's exclusive
cause is not claimed. The final source matrix is recorded in the core PR.

Subsequent focused checkpoints add the missing real account-suspension race
during pairing commitment (**17 pairing tests**, 32 combined management,
adoption and pairing cases), and protect both events and SQL starters from
replacement creation when retained private recovery evidence exists (**39
starter setup/account/adoption cases**, plus five packaged-onboarding checks).
These focused results are not relabeled as the preceding 917-test run.

The companion source and qualification are independently pinned:

| Repository | Exact source | Current evidence |
| --- | --- | --- |
| Chronolog | `15573014f4536369d7bd2f8a4b894a0d9fb69812` | [Quality](https://github.com/werg/chronolog-db/actions/runs/44725394129): 678 passed, six WASM cases skipped in that suite; [native/WASM execution](https://github.com/werg/chronolog-db/actions/runs/44725394245) and [independent application qualification](https://github.com/werg/chronolog-db/actions/runs/44725394158) also passed. |
| Contrib | `b33cf7102c4bb36eac8be29bbce8368a476ac7a0` | [Node 22.15 and Node 24](https://github.com/werg/tendriller-contrib/actions/runs/44729150515): 59 guides, 237 source decisions and 74 tests passed. |

Core carries the clean Chronolog archive with SHA-256
`c7320c8e5c7c12f8ae65c148f6a6a3a44b5efb64cbee39e36cb6efa71e289be0`.
The final source head, hosted run links and remaining selected-host release
gates are kept current in [PR #68](https://github.com/werg/tendriller/pull/68).
