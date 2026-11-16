# Core mechanisms, authored pages and cookbooks

Tendriller separates dependable platform behavior from application design. Core is independently buildable. Contrib is a collection of adaptable decision guides, with optional page-owned snippets and deliberately selected trusted references.

## Ownership and dependency direction

| Surface | Owner | Dependency boundary |
| --- | --- | --- |
| Identity, roles, state, events, files, blobs, streams and lifecycle | Core engine | Public core contract |
| Durable commands, conversation data, sensor tracking and publication readiness | Headless core runtime | Public core contract |
| Active-use stop and recovery link | Hosted utility | Public browser API |
| Spoken input/output | Explicit optional runtime adapter | Public conversation, captures and asset URLs |
| Private records and synchronous atomic operations | Core trusted host | `@tendriller/core/host` |
| Publication, preview, delivery and collector plumbing | Optional core tools | Built SDK/runtime artifacts |
| Layout, navigation, domain data and presentation | Authored page | Public browser APIs and ordinary web dependencies |
| Decisions, alternatives, algorithms and illustrative policies | Contrib cookbooks | Markdown and optional verification against public core artifacts |
| Installed application-specific server policy | Explicit deployment entry | Reviewed reference plus public engine/host interfaces |

Core does not download a contrib release, compile a sessions package, or infer a workflow from application JSON. `npm run build` produces an engine with an empty registry. A trusted deployment entry calls `configureWorkflows` with exact reviewed implementations before serving requests. Page code cannot register modules.

Build checks reject cookbook, tool and application imports in the Worker or runtime. The kernel graph excludes the rich control, speech engine and domain rule implementation. Operational tools are separately bundled; their dependencies never enter the Worker.

## Public artifacts

| Archive | Package | Purpose |
| --- | --- | --- |
| `tendriller-sdk-<version>.tgz` | `@tendriller/core` | Client, wire schema, limits and public browser/host declarations |
| `tendriller-runtime-<version>.tgz` | `@tendriller/runtime` | Exact browser assets, headless kernel, optional voice and preview primitives |
| `tendriller-engine-<version>.tgz` | `@tendriller/engine` | Generic Worker, fresh account schema and separate public host test fixture |
| `tendriller-tools-<version>.tgz` | `@tendriller/tools` | Self-contained optional operational commands and libraries |

Release metadata records exact source, version, contract, runtime identity, sizes and SHA-256 digests. Cookbook snapshots have independent content revisions. A recorded test pairing describes the bytes exercised; it does not create a circular release dependency or install anything for a reader.

The engine's `./testing` entry is a separate fixture bundle. It creates synthetic accounts and exercises the real Worker, authentication, command admission and transactions through public requests. It is excluded from the production Worker input graph. Cookbook checks install the public SDK/engine archives in a temporary directory; they need no private server imports or sibling checkout.

## Browser and UI boundary

Importing `@tendriller/runtime/kernel` mounts nothing and asks for no permissions. `startRuntime` supplies one connection, durable commands, state, streams, conversation records, capture lifecycle, publication identity and capability inspection. The hosted entry starts this kernel and adds only a recovery link plus active-sensor status/stop.

Pages author their own conversation and status presentation. They receive stable message IDs and the distinction between queued, accepted and rejected commands. `conversation.presented(messageId)` acknowledges that the particular agent message was presented; receipt or an open socket does not imply presentation. Voice loads only when a page imports its optional module and explicitly starts the chosen behavior. Voice preferences belong to that adapter rather than a universal core presentation preference.

The recovery route is service-owned HTML, independent of the page runtime. It authorizes the signed-in owner before changing agent connections, guest access or the selected publication. The floating link is convenience, not a security boundary. Selecting a retained publication changes files and preserves application data.

## One transaction boundary

A protected command carries a stable `cid`, an optional opaque scope, original `expected_generations`, and its payload. Scopes are authoritative records with protected paths and operation targets. They are separate from application JSON. Binding changes, reset and retirement deliberately change command meaning and therefore generations.

Admission derives required guards from every overlapping path and operation target. A protected descendant also guards an ancestor write or whole-state replacement. Every supplied guard is checked. Generation tokens are concurrency observations, never access grants.

Browser operations, agent HTTP/MCP, capture completion, bundle publication and trusted-module mutations use this admission rule inside the local transaction. Idempotency is keyed by authenticated actor and stable command ID. Reuse with different content rejects; an accepted retry returns its saved result even after later generation rotation. The mutation and result commit together. Broadcasts and notifications run only after commit.

The browser persists identity, payload and captured guards before optimism or delivery. Reload and reconnect reuse that record. Obsolete work cannot overwrite a newer generation, and a rejection remains observable to page-owned UI. Uploading capture bytes and admitting their event are distinct steps, so a failed command can retain a reviewable draft.

## Narrow trusted host

A module declares its own operation names, schemas, permission policies, implementation identity and scope targets. Its synchronous `run` receives authenticated identity, namespaced bounded records, shared state, explicit scopes, participant identities, media retention and post-commit effects. It receives neither SQL nor the Durable Object.

Private records stay outside shared state. One record, total record count and aggregate bytes have enforced limits; quota failure rolls back the complete operation. Module-owned scopes rotate or retire when their installed meaning changes. Domain choices such as assignment policy, a summary path, approval expiry and archive contents belong to the selected implementation.

The private-response and exact-proposal cookbooks contain small reference policies. They are not a default sessions product. Their verification uses fresh text-only records. Private-media authorization and retention require a separately established storage policy; a text-record test makes no claim about those bytes.

## Publication and serving contract

A publication locks complete page files and the current runtime artifact. `publication.base` identifies its immutable root; `publication.entry` identifies the actual requested logical HTML file. Each HTML response inserts a first base URL for that file's encoded directory, so nested pages resolve sibling assets correctly. Asset paths are encoded by segment, including spaces, Unicode and URL punctuation. Directory requests select `index.html`; an arbitrary missing route returns 404. Applications may use hash routing or publish explicit route files.

An existing author manifest is retained. External dependencies remain an explicit page choice and do not acquire platform offline guarantees. Preview and publication receive the same authored asset set; preview cannot silently supply a missing library.

The service worker verifies manifest-declared bytes and commits a complete graph before acknowledging `publication.saveOffline()`. HTML is identified by its publication response header because runtime injection changes its bytes. Optional runtime assets are verified when used instead of being fetched by every page. Open tabs stay attached to their publication until an explicit update transition; normal target-system publication retention preserves active work and offline leases.

## Validation ownership

Core owns protocol, authorization, transaction, runtime and operational-tool tests. Preview simulates explicitly supported operations and rejects the rest. It cannot prove real service privacy, quotas or atomicity. Contrib owns guide metadata, provenance, links, numerical examples, different page adaptations and selected trusted-reference scenarios. See [development](DEVELOPMENT.md), [browser tests](E2E_TESTING.md) and the [protocol](PROTOCOL.md) for executable gates and limits.
