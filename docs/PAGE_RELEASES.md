# Peer page releases

Peer pages publish through Chronolog's `chronolog-release-v1` control facet.
The host accepts signed manifests of exact authored bytes and signed activation
requests. It retains the approved content, selects a complete release atomically,
and serves that selection through the existing authenticated page URL.

Publication authority is a separate publisher policy. Reading or writing
application data, coordinating its history, administering data membership, or
signing the SQL initializer does not grant permission to publish code. The owner
binds publisher public keys to admitted page accounts. The host signs that policy
with the same durable control root used by the application's descriptor; release
policy can be initialized before the application itself exists.

## Use the public publisher

The supported composition is an owned Chronolog release publisher plus
`client.peers.releases` from `@tendriller/core`. Keep the device and signer in the
native application process or owning browser Worker.

```js
import { createReleasePublisher } from '@chronolog/peer-session/releases';

// Owner-account administration. expectedPolicy is the digest of the policy
// already reviewed, or null for the first policy. Save and retry this request
// unchanged if its result is lost.
await client.peers.releases.configure({
  requestId: 'initial-publisher-policy',
  expectedPolicy: null,
  publishers: [{ publicKey: publisherPublicKey }],
});

const releases = await createReleasePublisher({
  session,
  host: client.peers.releases,
});
const prepared = await releases.prepare({
  operationId: 'release-board-1',
  entry: 'index.html',
  assets: [
    { path: 'index.html', mediaType: 'text/html', bytes: htmlBytes },
    { path: 'app.js', mediaType: 'text/javascript', bytes: javascriptBytes },
  ],
});
await releases.publish(prepared.operationId);
const state = await releases.state();
const selected = await releases.activate(prepared.id, {
  requestId: 'activate-board-1',
  expectedActivation: state.activations.at(-1)?.id ?? null,
});
```

The publisher stages the authored bytes and signed intent durably before making
requests. Retry publication with the same operation ID. After a lost activation
reply, call `releases.retry('activate-board-1')`; it resends the exact retained
request. A conflict requires a new review and a new activation request. Reusing
an ID with different intent fails.

`createReleasePublisher` binds the manifest to the session's verified history,
definition digest, execution manifest and schema digest. Activation checks that
binding against the host's configured application. Publishing code does not
rewrite the application definition or reinterpret stored data.

For a shell published before application configuration, use
`openReleasePublisher({device, applicationId, controlPublicKey, host})` from the
same entry. Pin the control key obtained through the authenticated bootstrap.
This standalone publisher owns the device until it closes. An unbound manifest
can be activated only while the host has no configured application boundary.

## Transport and storage

All routes below are relative to an agent API base or an authenticated page's
`_tendril/` base. The SDK uses the same routes. Publication policy changes are
owner-account operations. Signed publication and activation requests must come
from the account bound to their publisher key. Guest publisher keys require
current approved page access. Existing account suspension and page access checks
apply at entry and again at durable commit.

| SDK method | HTTP operation | Result |
| --- | --- | --- |
| `releases.state()` | `GET peers/releases` | Signed policy and activation history |
| `releases.configure(request)` | `PUT peers/releases/policy` | Signed publisher policy |
| `releases.content.put(digest, bytes)` | `PUT peers/releases/content/:digest` | Verified digest and byte count |
| `releases.content.get(digest)` | `GET peers/releases/content/:digest` | Exact authored bytes |
| `releases.publish(manifest)` | `POST peers/releases/manifests` | Accepted manifest and its digest |
| `releases.manifest(id)` | `GET peers/releases/manifests/:id` | Accepted signed manifest or null |
| `releases.activate(request)` | `POST peers/releases/activations` | Signed durable selection |
| `releases.watch({signal})` | WebSocket `peers/releases/socket` | Receive-only signed selection hints |

Publisher entries in the host policy request are `{publicKey, accountId?}`.
Omitting the account binds the key to the owner. A key's account binding is
immutable; new account ownership uses a new key. An empty publisher set freezes
new publication and activation. Exact accepted requests remain retryable after
their publisher is revoked, provided the caller still has page/account access.

The host admits at most eight simultaneous release requests and 64 explicit
release watches per page. Uploads reserve at most 32 MiB of aggregate buffered
input before reading a body; a body without a declared length reserves the whole
budget. Policy changes remain independent of upload buffering. The portable
protocol bounds a manifest at 256 safe
relative ASCII paths, 32 MiB per file and 128 MiB total, with at most 128 current
publishers, 256 policies, 1,024 accepted manifests and 1,024 activations. These
limits fail explicitly. Verification streams chunks of at most 64 KiB with a
30-second deadline. Account storage quotas also apply.

Release content has its own explicit projection. Knowing a private blob digest
does not make that blob publishable or readable through release routes. Pending
uploads receive a 24-hour staging retention window; accepted manifests retain
their complete graphs. Release history remains resident until explicit page
deletion. An initialized but missing control head fails closed.

## Serving and update choices

The current page URL serves the signed selection. Retained activated releases
use `_publications/<release-id>/<asset-path>`. Relative references resolve within
that immutable release directory, including nested HTML directories. Every
manifest includes the complete authored graph; upload, publication and preview
do not fill missing dependencies.

Signatures cover authored bytes. Rendered HTML adds the trusted host runtime and
HTTP bootstrap separately. The injected `peerRelease` evidence contains the
current signed state and manifest, while `publication` identifies the exact
graph being displayed. The raw release-content endpoint remains byte-exact.
Each accepted release also pins the host runtime artifact used to serve it.
Serving verifies the requested asset incrementally, then reopens the same R2
version and ETag before exposing bytes. Changed or missing storage fails closed.
Non-HTML assets stream; HTML injection admits at most two responses and 25 MiB
of aggregate authored input until their bodies drain or are cancelled.

Watching is explicit. The narrow WebSocket accepts no application frames and
sends only signed selection hints. The SDK coalesces pending hints; the Chronolog
publisher fetches and verifies a monotonic extension before exposing a new
selection. Reconnect explicitly refreshes state. There is no polling, heartbeat,
automatic reload or host health rollback. Page code decides when to offer an
update, preserve its draft and navigate to the selected release.

Reactivating older code is a fresh authorized compare-and-set activation.
Application data recovery leaves the publisher policy and selected code intact.
Service-owned recovery pages display the retained activation history and allow
the owner to reconnect an agent even when authored JavaScript is broken; the
publisher still signs any code selection.

The existing Cloudflare application profile uses its own publication, health and
recovery APIs. Peer pages reject those unsigned publication and bundle paths.
MCP exposes `release_state`, `configure_release_publishers`,
`upload_release_text`, `publish_release`, `release_manifest` and
`activate_release`. Binary assets and owned signing use the public SDK and
Chronolog publisher.
