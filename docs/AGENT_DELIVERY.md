# Deliver a running application

A request to build an app includes setup, signed publication, real device-owned data, offline use and verification. Source files, an installed adapter, a native process alone, or an HTML preview do not complete it. Begin at [Build an app](BUILD_AN_APP.md); select existing [capabilities](CAPABILITIES.md) and [patterns](APP_PATTERNS.md).

## Start provisioning early

Read the exact service's `/api/service`, discovery and `/api/readiness` before package acquisition. Continue only with open creation readiness. Retain the original account-linked setup intent/handle across lost replies and use `inspect_tendril_setup`, not a replacement intent. The host derives the verified owner.

Choose finality/availability semantics explicitly (`none` by default), prepare the independent publisher policy and publish the complete signed UI **before the first browser key is known**. Give the human the ready page URL without asking for a claimed reply. They perform their own sign-in. The first browser proves its key and initializes its root/membership and actual local keys without a native process. Additional devices require explicit account/key proof, owner rights review and recipient-bound key provisioning.

## Browser and optional process lifetime

The browser's owned signer/store can durably author with no peer, agent server or finalizer. Cached local authority/identity/data open before remote refresh/discovery. Live synchronization requires participating devices/routing to be available; stopping them does not revoke the browser's local Save capability.

An optional native participant/tool provider must use its original private store and real process lifetime. Report its PID/process manager, start command, retained state location and stop/resume behavior only when actually established. A detached child may die when the execution environment ends. Do not call it permanent, resident or resumable merely because an adapter is installed. Root locks protect one physical profile, not global data order.

A configured finalizer can be browser/native/host placed under the same proof contract. Report actual tested provider availability separately from policy configuration. Its absence may delay finality, never local authoring/provisional reads. Explain sealed-time exclusion of unseen offline work and preserve excluded original intents visibly.

## An existing conversation

Page residency, a durable operation set, an optional MCP gateway, hibernating sockets and retained inboxes do not establish supported future wake or handoff to an existing ChatGPT/other assistant conversation. Say which actively running process observes work. Do not imply conversation execution after it ends.

## Evidence in the final handoff

Provide the ready page URL and concise evidence:

- Verified signed publication ID/receipt and exact package/source composition tested.
- First browser initialized after owner sign-in with **no native data process**.
- A real command acknowledged **stored locally**, then its coherent **materialized locally** result (revisable).
- Offline graph acknowledgment, disconnect, offline CRUD and reload retaining identity/drafts/operations.
- A second genuinely separate profile/device first keyless, then explicitly proved/granted/provisioned; both replicas converge from authenticated operations.
- Authenticated peer retention evidence, separately from execution. Configured finality is `none`, pending, verified finalized, or excluded as actually observed; never report fake finality.
- Late earlier state/schema/outcome revisions and preserved draft/focus/deep links.
- Actual browser/optional native/provider lifetimes, private-state resume path and explicit untested boundaries.

No plaintext keys/private host handles enter authored assets, screenshots or shared reports. Production deployment is a separate action. When blocked, name the exact prerequisite and next action from [troubleshooting](TROUBLESHOOTING.md), complete safe setup already possible, and report the missing verification honestly.

## The user experience is part of the deliverable

### Run a separate second pass

After the first working version, use this dedicated prompt:

> Act as a first-time user at desktop and 320px phone width in fresh browser profiles. Exercise every domain flow without reading implementation code. Find observed friction in local opening, sign-in/key provisioning, offline Save/reload, domain navigation/editing, revisable operation facts, schema changes and optional feature availability. Verify keyboard/focus, Back/deep links, long content and cancellation. Fix concrete observed problems and retain before/after screenshots. Do not replace domain views with storage forms or treat transport tests as UX completion.

| Flow | Required observation |
| --- | --- |
| Fresh owner | Signed UI already published; first sign-in/key proof initializes locally; no native process or extra ordering approval |
| New second profile | Keyless state honest; exact fingerprint/independent grant review; wrapped-key import; no magic old-data access |
| Local Save | Enabled by local signer/store prerequisites even with zero peers, stale view, unavailable agent/finalizer |
| Offline reload | Complete immutable graph saved; identity/keys/data and separate unsent drafts remain |
| CRUD/list/detail | Stable entities update/move/disappear; derived counts/detail recompute; selection and local editor remain distinct |
| Concurrent/late earlier work | Current success/rejection/events revise; original intent remains inspectable; no silent retimestamp/new ID |
| SQL DDL/permissions | Ordinary authorized CREATE/ALTER/DROP and grants; schema-only invalidation; missing query labels last snapshot not current; unrelated authoring survives |
| Operation inspector | Stored/materialized/retained/finalized/excluded separate; exact original retry; no ambiguous success label |
| Optional features | Agent-only tools/analysis unavailable locally without disabling edits; explicit media consent/cancellation |
| Optional finality | None/pending/certified/excluded honest; browser provider tested without native; closure warning and complete proof/dependency boundary |
| Navigation/accessibility | Deep links, Back, keyboard, focus, scroll and long text at desktop/320px; no horizontal page overflow |
| Lifecycle/errors | Loading/empty/stale/error states; abrupt owner/process restart, uncertain reply and same-intent retry; device locks retained |

Capture before/after screenshots for fixed friction and name the exact flows/viewports exercised. Static previews, source-only tests and deterministic provider fixtures do not establish live OAuth, Internet NAT, physical mobile execution or real inference-provider behavior.

## Verify consumers after a release or restart

Re-run public-package Workerd, browser, RTC/relay, SQL native/WASM and first-app composition gates against the exact new graph. Historical successful receipts do not qualify this protocol. Do not keep an old ordering path, compatibility reader or migration layer to satisfy old tests. State exact commands run and their limits. Preserve existing private device state; an artifact mismatch never authorizes deletion or an unrequested production rollout.
