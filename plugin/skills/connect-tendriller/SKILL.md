---
name: connect-tendriller
description: Build or connect a browser-first Tendriller application, retain the user's account/device authority, and verify durable local writes, peer convergence and approved optional tools.
---

# Build or connect a Tendriller application

Start with `tendril_guide` (`topic: "start"`), then `topic: "build"`, `topic: "capabilities"`, and `topic: "delivery"`. Use `topic: "connect"` for an existing application, `topic: "sensors"` for capture consent, and `topic: "deployment"` only for an explicitly requested rollout. The tool returns maintained instructions and the selected `serviceOrigin`; keep every setup and discovery route on that exact origin, including staging. If absent, inspect `get_profile`/`list_tendrils` fields `setup.startHere`, `setup.buildGuide`, and `setup.discoveryUrl` and refresh the catalog; never infer production from a name or switch service origins. An empty application list does not mean creation is unavailable.

Before downloading/installing, read the exact service origin's `/api/service`, `/.well-known/tendriller.json` and `/api/readiness`. Require same-origin `mode:"open"` and `creation.available:true`. Otherwise stop and report its next action. Use the immutable `firstApp.release` kit, matching SDK/tools/**authority**/session archives, source/tree/hash composition and exact lockfile—not private kernel imports or mixed same-version builds.

## Create, prepare, publish, then initialize the browser

For linked-account creation, run `npm run setup:prepare -- SERVICE_ORIGIN NAME` in the retained starter. Call `prepare_tendril_setup` with its exact printed **public** arguments under this connector's existing grant. The host derives the verified owner; local setup secrets/OAuth credentials do not enter tool arguments. Save its exact public ready result and run `setup:finish`. After a lost reply, use `inspect_tendril_setup` with the original operation ID, never a new intent or another account route.

Prepare early and publish the full signed UI **before the first browser key is known**. The starter's publisher key/policy are independent of the data descriptor, root, epoch keys and schema. `npm run init && npm run deploy` does not require a native data participant. Give the person the ready page URL and any separately prepared tool-consent URL without waiting for a “claimed” reply. They complete their own sign-in.

The first owner browser proves its key and initializes the signed data root/membership/epoch commitment; actual keys are durably local before the proof. Retained identity/authority/keys/data reopen before background host refresh/discovery. A fresh additional browser cannot magically read old data: exact key proof, explicit independent crypto rights and recipient-bound wrapped-key transfer remain required. Crypto membership does not overwrite SQL collective/object/row/column permissions. There is no native-prepared prefix, ordering pause, selected-generation transition or compatibility path.

## Authoring, reactivity and optional finality

Ordinary offline-first apps default to finality `none`. Canonical order is solely signed author timestamp, signing key bytes and stable proposal-ID bytes. Submission acknowledges exact durable local storage, not remote execution. Distinguish **stored**, **materialized locally (revisable)**, **retained by peers**, **finalized**, and **excluded**. Preserve original IDs/time/bytes after uncertainty; inspect/retry the retained original, never silently retimestamp.

Save depends on local signer/storage/key prerequisites, not peers, a successful current/global read, native tools or a finalizer. Finality is optional inclusion/author-time closure evidence, never a sorter. Configured policy is not demonstrated provider availability. A closed frontier can exclude genuine unseen offline work behind it; explain this tradeoff and retain excluded originals. No-finality final waits explicitly fail as unsupported. Provisional claims do not establish global exclusivity or authorize irreversible external effects.

SQL schema, DML and permissions are ordinary authorized atomic transactions. Engine/platform manifests do not freeze database schema or require code publication for ALTER/CREATE/DROP. Existing consumer/tool/column approvals never silently expand after schema changes.

Build real domain views: stable-ID lists/details, inspectors, reviewed edits and mobile navigation, not a JSON editor. Render coherent materialized snapshots plus separate local drafts/view state. Notifications invalidate/rederive; never append arrivals into another UI database. Late earlier operations can revise outcomes, rows, counts and schema. Missing-table/query errors mark the last snapshot not current without erasing unsent input or blocking unrelated local authoring.

## Verify rather than assume

Use existing device-local owner/root locks and direct-first RTC/two-lane encrypted relay helpers. Do not introduce another selector, always-failing RTC stub or app backend. Qualify actual authenticated data traffic/direct versus forced fallback. Native participants and tool providers are optional independently authorized processes; if used, report actual lifetime/private-state resume details. Their absence must affect only their features.

Exercise browser-first setup with no native process; real local command/materialization; complete-graph offline acknowledgment, CRUD and reload; explicit second-profile key provisioning; convergence and separate retention; late earlier state/schema changes; and signed publication. Run the dedicated second pass from `delivery` at desktop and **320px**, fresh profiles, every main flow, Back/deep links, keyboard/focus, long content and loading/empty/stale/error states. Retain before/after screenshots. Transport/persistence checks alone are not UX completion.

## Optional tools, account linking and sensors

For an existing app, use `list_tendrils` then `describe_application`. Existing participants propose only declared operations; the owner reviews exact queries/commands/events. Preserve independent consuming-agent approval and tool-provider idempotency. Do not silently replace the app or expand rights. Query/write responses carry revisable operation/snapshot facts. Event consumers must understand resets/retractions and finalized versus provisional evidence.

Follow the person's normal account-linking prompt; credentials/codes stay out of chat. Ordinary calls use the existing OAuth-client binding. Separate proof bindings are for independently revocable agents, not a mandatory new identity for every call. Missing native/provider runtime is a named prerequisite for those optional tools, not browser data use.

For sensors read `topic:"sensors"`. Inspect only relevant capabilities; use standard browser APIs, existing content/signals/commands and tracked asynchronous cancellation. An agent observation request displays a prompt only. A trusted local gesture starts capture; explicit consent/review authorizes sharing/retention. Missing inference disables analysis, not ordinary edits.

For restart, consult same-origin `/docs/AGENT_RESTART.md`; preserve retained profiles, snapshot-aware cursors and original pending inputs. A live page, optional MCP socket or inbox does not guarantee future conversation wake. Report the process actually running, exact tests and unverified boundaries. Users revoke account access at `/oauth/connections` or app tool scopes at `/connections` on the same service origin. Use `topic:"troubleshooting"` for the exact next action; no automatic storage wipe or unrequested deployment is authorized.
