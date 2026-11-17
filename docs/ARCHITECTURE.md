# Architecture

One Chronolog application session owns each local application's execution and exchange. The same public session contract serves native agents and browser Workers. Tendriller composes that session with authenticated page hosting and a light protocol participant.

## Responsibilities

| Owner | Responsibility |
| --- | --- |
| Chronolog session | Signing device identity, byte store, operation journal, materialization, queries, events, signals, owned participation, replication and recovery |
| Coordinating peer | Orders the currently selected generation; no permanent process or host privilege is implied |
| Tendriller participant | Signed controls, membership changes, immutable public definition and signed page-code release chain |
| Tendriller page host | Account access, isolation, immutable file serving, bounded discovery/introductions and lifecycle quotas |
| Browser runtime | Install one application backend and live signal port, track local sensors, compose optional voice and explicit offline code caching |
| Authored page | UI, domain commands, authorization policy, drafts, presentation and user decisions |
| Tools and contrib | Public consumers, preview, application examples and independent qualification |

The server uses the common participant envelope and a closed action policy. Its different transport and rights describe its role. There is no separate hosted application implementation, default JSON state executor or application-profile switch.

## Identities

A page has a host page ID, a URL capability and account access. It also records one independent 32-byte application ID. Chronolog's pinned descriptor binds that application to its history, schema/definition and execution manifest. The session owns the signing device identity and validates signed updates. A page login or agent bearer token does not itself grant database rights.

The server stores host metadata, signed control records and retained code assets. It has no application command, event, record-log, stream, device outbox or database-history tables. Account audit entries describe host lifecycle and publication activity only.

## Application contract

`ApplicationSelection` is `{id}`. `createApplicationBackend({id,session,...})` adapts the public Chronolog session to the browser binding. The backend always supplies operations, applied read views, changes, status and explicit recovery. SQL and a declared event-publication command are optional capabilities of the same session.

The application binding installs once. Missing installation is an explicit error. Neither installation nor a page's `ready()` callback claims synchronization. `saved`, `applied` and `shared` describe distinct evidence. Recovery can abandon selected-generation history; reapplication is deliberate and preserves the original attempt as evidence.

## Code and publication

Code is a signed Chronolog publication with a predecessor, revision and operation identity. The host verifies authority and the full file graph, writes verified content, then commits the immutable version and signed head together. Lost replies can be retried exactly. Stale heads conflict. Old signed releases retain their bytes.

A publication pins its browser runtime graph. Open tabs retain their exact code graph, including through explicit offline caching. Current code changes only through a new authorized signed release. Application recovery never rewinds that release chain.

## Build boundaries

`@tendriller/core` exports the host SDK, application/signals contracts and participant transport. `@tendriller/runtime` exports kernel, optional voice, manifest and exact assets. `@tendriller/engine` exports the Worker, Durable Object classes, account schema and test fixture. `@tendriller/tools` exports preview, packing and public-session helpers with two executables.

The Worker embeds only Chronolog's portable control and participant graph. It imports no SQL materializer or application session. The kernel imports no domain UI, voice engine or Node tools. Tools consume the built public artifacts; core does not fetch contrib. Provenance records exact source commits, clean/dirty state and archive hashes.
