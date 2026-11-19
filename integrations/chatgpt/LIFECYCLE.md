# Creation and reviewed page publication

`lifecycle.mjs` provides optional lifecycle adapters for the remote tools. The
deployment supplies trusted service origins, private handles, pinned descriptors
and account lookup. A model cannot select another endpoint, token, owner, signer
or backend. The caller checks account scopes and application access before every
method. Publication additionally requires a trusted recorded approval callback;
there is no `approved: true` tool argument.

```js
const lifecycle = createLifecycleService({
  store, // encrypted durable delivery/review bookkeeping
  creation: {
    origin: 'https://tendriller.dev',
    ownerEmailForPrincipal: lookupVerifiedTendrillerOwnerEmail,
  },
  applications: [{ id: applicationId, handle, pinnedDescriptor, ownerAccountId }],
  authorizePublication: lookupRecordedApprovalForExactReview,
});
```

`createTendril(principal,{requestId,name})` uses the public SDK's `describeService`,
`requireService` and `createPage`. Current Tendriller creation accepts an owner
email and expressly rejects an Authorization header. This integration resolves
that email from the authenticated account, not from model text. It returns the
real owner claim URL and retains the private agent handle in encrypted storage.
It never claims, configures, enrolls or publishes on the owner's behalf.

Page creation has no host idempotency key. The service saves an attempt before
sending and retains the returned handle before answering. A repeated successful
request returns its saved result. An interrupted/uncertain request is not sent
again automatically; inspect the host/account state before another creation.

`preparePageRelease(principal,{applicationId,operationId,entry,files})` takes a
complete graph of `{path,type,bytesBase64}` files. It applies the CLI packer's
canonical path, complete-graph, HTML-entry, SHA-256, file-count and byte-limit
rules without letting a remote caller read local paths. The default maximum is
8 MiB/128 files. Hidden state, reserved paths and `node_modules` are rejected.
The service verifies the claimed application, pinned authority and signed
publication ancestry, then persists a stable review identity and digest. The
result is explicitly unsigned and includes the exact native `preparePublication`
input plus expected application/control/publication bindings.

On the existing enrolled publisher device, review the graph and use its normal
application session:

```js
import { signReviewedRelease } from './lifecycle.mjs';
const owned = await openSession(); // Existing publisher device, no new signer.
try {
  const signedPublication = await signReviewedRelease(review, owned);
  // Save these exact signed bytes before returning them to the integration.
} finally { await owned.session.close(); }
```

The helper uses the actual session-owned `control.preparePublication` journal.
A reader/writer or host account is not a publisher. Missing publisher rights or
changed publication/control context stop the handoff. The ordinary CLI remains
available for directly publishing reviewed local files:
`tendril --session ./session.mjs publish ./page --operation THE_REVIEWED_ID`.
That CLI command signs and publishes directly and therefore has its own explicit
user authorization; it is not a substitute for uploading a signature to this tool.

`publishPageRelease(principal,{reviewId,reviewDigest,signedPublication})` requires
the original review owner, exact digest, authentic enrolled publisher signature,
matching graph/operation/context, and the deployment's approval record. It
submits the exact signature and retained content-addressed assets through the
public `host.peers.publish` transport. The host remains the final account,
publisher and publication-head authority. The bridge never receives a signing
key. Lost replies retain the signed attempt for exact retry; a stale predecessor
requires a newly reviewed publication instead of silently changing the intent.

`capabilities` reports which optional tools can be exposed. With no creation
configuration creation is unavailable. With no trusted approval callback,
publication is unavailable; preparing a signing handoff remains possible.

The encrypted store contains private creation handles, authored release bytes,
review metadata and receipts. It is not application history or a command engine.
The bounded journals refuse new records when full rather than deleting uncertain
work. Retention and private review/handle export are operator responsibilities.
