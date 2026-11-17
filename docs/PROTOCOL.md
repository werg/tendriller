# Host participant protocol

Tendriller is a light Chronolog participant over authenticated HTTP. The application session and host use the same request/response envelope. Transport policy and participant rights define what the host receives.

## Envelope and routes

`POST /api/t/<page>/peers/participant` serves agent credentials. The corresponding page route is `<page_url>_tendril/peers/participant`, authenticated by the page's account session. Both dispatch the same implementation.

```json
{"protocol":"chronolog-participant-v1","applicationId":"<64 lowercase hex>","requestId":"<caller identity>","facet":"control","action":"read","payload":{}}
```

Responses repeat all routing fields and carry the result in `payload`. The shared transport checks policy, bounds, application scope and exact response correlation before unwrapping a result. Transport failures remain typed errors. Client filters reject unsupported facets before scope lookup or network I/O; the host independently enforces the same role policy.

| Facet | Allowed actions | Content |
| --- | --- | --- |
| `control` | `configure`, `read`, `select`, `administer` | Signed descriptors, device grants and generation selection |
| `publication` | `definition`, `read`, `publish` | Immutable public definition and signed page-code release chain |
| `discovery` | `read`, `advertise`, `withdraw` | Bounded expiring routing hints |
| `ephemeral` | `invite` | Small on-demand connection introduction |

Database commands, database histories, generic content chunks and live application signals are refused. They are not retained in host tables. The host has no alternate ordinary command endpoint or application extension registry.

## Identity and authorization

The page records one independent application ID at creation. Before authority configuration it returns explicit unconfigured control state. A descriptor binds the history, definition, schema and execution manifest. Chronolog verifies signed authority against the pinned descriptor.

Host account access and device grants are independent. Owner accounts authorize host setup and recovery. Signed device identities authorize application commands and code publication according to their grants. An account login alone does not become a signing device. Every mutation rechecks local account/credential revocation after asynchronous work before committing.

## Control and recovery

A control revision records device rights and key epoch. Generation selection has signed transition identity, expected predecessor, a real peer coordinator and an authenticated adopted prefix. Exact retries return retained evidence. Competing predecessors conflict. The host's declared control role cannot read, write or coordinate ordinary application history.

Ordinary current-generation work requires no host request. Discovery advertisements are hints, not membership or retention evidence. A coordinator loss can require explicit generation recovery; clients retain signed local attempts while waiting and report abandoned or unknown history honestly.

## Signed code release

The publication manifest binds application/history identity, fixed wire version, current control revision, publisher author, operation ID, monotonically increasing revision, previous release ID, definition/engine digests, HTML entry and sorted complete file graph. Assets are referenced by digest and size, with canonical media types.

The host verifies the signature and current publisher grant, checks predecessor CAS, bounds the manifest and release history, verifies all supplied bytes, and rechecks account access around storage effects. Publication rights are independent of control administration and application data rights; the host's control-only identity receives no publisher grant. A single database transaction selects the immutable code version and signed publication head. A failure leaves the previous head selected.

An exact retained operation retry returns its original `{publication,version}` receipt. Changed intent under the same operation ID fails. A missing byte or stale predecessor fails explicitly. `publication/read` with `{}` returns the head; `{id}` returns that exact retained release or null. The session verifies the chain and persists the selected head outside lossy application history.

Old code remains at its immutable publication URL. The host never selects old code because of health diagnostics, static review or an unsigned management action. Restore requires a new signed release. Code history and application recovery are independent.

## Storage and lifecycle

Fresh host storage contains account access, signed participant records, code versions/assets and bounded host audit metadata. It has no ordinary application state, event log, command receipts, database history or delivery queue. File storage is content-addressed; release references retain bytes. A configured peer application retains its resident lifetime and owner account; generic claim release is rejected. Page/account deletion deliberately removes their hosted control/code resources.

One pre-release schema is supported. A mismatched existing schema is rejected before mutation; provision fresh resources. No migration, compatibility routing or alternate application pipeline is provided.
