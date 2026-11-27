# Cloud Computation: hosted agents and cloud actions

**Status: proposed, not implemented by the administration and analytics PR.**
This document describes the proposed joint premium Cloud Computation package. It introduces no
endpoint, SDK method, secret upload flow, Worker binding, or new entitlement.
The existing [administration API](ADMINISTRATION.md) supplies scoped operator
access, complimentary premium grants, and aggregate metrics as a foundation.
Platform details below were checked on 2026-11-27 and need rechecking before build.

## One package, two execution modes

Offer persistent customer agents on Workers for Platforms and ad hoc tasks on
Dynamic Workers together. A customer should manage one set of connections,
permissions, deployment versions, job receipts, usage allowances, and budgets.
Both runtimes use the same trusted authorization and capability broker; premium
access never implies unrestricted access to credentials or unbounded compute.

| Mode | Customer purpose | Platform responsibility |
| --- | --- | --- |
| Hosted agent | Publish a named, versioned service that responds to invocations and approved triggers even when client devices are offline. | Deploy and route customer Workers; isolate tenant resources and durable state. |
| Ad hoc task | Run bounded code generated for a particular request, transform, or agent tool call. | Load isolated code on demand with explicit capabilities and resource ceilings. |

An agent can request an ad hoc task through the shared execution service, subject
to the caller's current permissions and budget. Keep deployment control separate
from invocation permission. Include compute and deployment allowances in the
package, meter actual usage, and budget model/provider charges separately; choose
retail allowances only after measuring representative workloads.

## Fit with Tendriller

A cloud action would let an authorized participant request a bounded external
operation, such as calling a model or creating an issue using a stored credential.
The participant chooses the inputs to disclose. Premium eligibility would permit
use of the service; it would not grant access to another person's connections.

Keep the [blind host](ARCHITECTURE.md) and [deterministic reducers](STATE_MODELS.md)
as they are. Reducers run identically on admitted peers; replay must never send an
email, call a model, or consume a provider credit. Cloud actions run outside that
kernel. An authorized participant can subsequently record the result as a signed
application operation. No action automatically receives page contents, epoch
keys, session storage, cookies, or hosted-MCP credentials. Existing hosted MCP
access remains a separate, explicit permission.

## Three authority boundaries

| Component | Proposed responsibility |
| --- | --- |
| Independent execution Worker | Authenticate requests; verify action versions and grants; check current entitlement; reserve budget; load isolated code; keep the effect ledger. Deploy separately from the blind host. |
| Customer Worker or dynamic sandbox | Execute pinned code using selected inputs and narrowly scoped operation capabilities. Receive no platform secrets or shared infrastructure bindings. |
| Trusted capability broker | Own provider credentials; enforce tenant, resource, operation, expiry, revocation, and budget on every privileged call; return a bounded result. |

The broker can initially be trusted entrypoint classes in the execution Worker;
it can later become a separately deployed service. Neither component should hold
the service administrator's premium-write credential. A private admin tendril
could instead use a dedicated adapter limited to its authorized admin scopes.

## Publish code and approve authority separately

Define a signed action manifest that pins its owner, action version, complete
module/dependency hashes, runtime compatibility settings, entrypoint, input/output
schemas, requested capabilities, and resource ceilings. Verify the publishing
actor against current authority and verify every code hash before loading it.
Code or policy changes produce a new immutable version. A signature establishes
provenance; it does not make the code trustworthy.

The connection owner separately approves specific operations, resources, and
expiry for that version. For example, creating an issue in one repository is a
different grant from reading every repository. Broader capabilities require a
new grant. Do not infer consent from page membership or premium status alone.

Each invocation proves the actor's identity and binds the action version, input
digest, operation ID, audience, and expiry into an authenticated request. Reject
undeclared operations and replay with changed inputs. Check current account,
actor, action grant, and entitlement before execution; recheck authorization and
revocation inside each broker operation. Do not place authorization solely in a
loader callback that may be skipped for a cached Worker. Cloudflare similarly
requires [checks before invocation and inside platform-owned operations](https://developers.cloudflare.com/dynamic-workers/usage/authentication/).

Revocation stops subsequent authorized calls. It cannot undo a completed external
effect or recall plaintext already disclosed. For irreversible actions, require
explicit approval or an agreed finality policy rather than assuming a later
Chronolog replay can reverse the effect.

## Keep secrets behind operations

Use provider credentials with the smallest available permissions, independent
production/test credentials, rotation, and an owner-visible revoke operation.
For managed capabilities, keep provider keys out of browser assets, browser
storage, replicated page state, action code, logs, and the sandbox environment.

Expose methods for concrete operations; names such as `createIssue` are examples
of a future broker contract, not existing Tendriller APIs. Bind the account and
allowed resource in trusted context rather than accepting them as caller claims.
Do not expose `getSecret`, arbitrary SQL, or an unrestricted authenticated fetch.
Validate destinations, methods, input/output schemas and sizes; reject redirects
or revalidate every hop before attaching credentials. Filter provider responses
so they cannot echo credentials or unrelated records back into action code.

Cloudflare supports [custom service capabilities](https://developers.cloudflare.com/dynamic-workers/usage/bindings/)
implemented by trusted `WorkerEntrypoint` classes. Their private `props` remain
in the loader. Normal resource bindings belong on the loader and are exposed
through such wrappers. This supports a broker; it does not imply arbitrary native
bindings or newly provisioned secrets can be created from untrusted code.

[Secrets Store is in open beta](https://developers.cloudflare.com/secrets-store/).
Its Workers integration uses a [preconfigured binding for a specific
`store_id` and `secret_name`](https://developers.cloudflare.com/secrets-store/integrations/workers/),
read asynchronously by the trusted Worker. Plan the first release around a small
set of operator-managed connections. The [current production limit is **100
secrets per account**](https://developers.cloudflare.com/secrets-store/manage-secrets/),
so it cannot be assumed to be an unlimited per-customer vault. A larger
customer-secret product needs a separately reviewed storage,
provisioning, isolation, recovery, and deletion design before rollout.

## Runtime choice: hosted agents and ad hoc actions

Use
[Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
as the primary hosting layer for persistent customer agent services. Code is uploaded to a dispatch namespace; a trusted
dispatch Worker authenticates and routes invocations. This suits named agents,
versioned deployments, stable endpoints, and customer-specific resources.
Use Dynamic Workers for code generated for an individual task. Expose a
platform-owned dynamic execution service to hosted agents through a narrow
capability; do not assume every nested binding is supported.

Workers for Platforms permits [per-Worker resource bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/),
including Durable Objects, D1, R2, Queues, and Workflows. Keep customer code in
the default [untrusted mode](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/).
The platform derives and validates every binding; never accept arbitrary
customer upload metadata that could name the shared account database, page
storage, another customer's resource, or a deployment credential. Requests can
receive [scoped RPC capabilities through dispatch props](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/);
their backing credentials stay in trusted platform code.

[Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)
mediate global `fetch()` and disable direct TCP `connect()` when enabled, but
do not intercept traffic through bindings or from Durable Objects. Therefore
an outbound Worker alone is not a complete egress policy. Review all attached
resources and every stateful execution path before claiming network confinement.

For persistent agents, Cloudflare documents [tenant-deployed Workers with Durable
Objects](https://developers.cloudflare.com/durable-objects/best-practices/architecture-examples/#workers-for-platforms-for-example-tenant-deployed-code).
The [Agents SDK](https://developers.cloudflare.com/agents/getting-started/add-to-existing-project/)
can supply lifecycle, scheduling, and durable jobs; it currently needs named
SQLite-backed objects and `nodejs_compat`. Validate those requirements in the
separate executor rather than changing Tendriller's blind-host runtime. Where
strict egress confinement is required, keep durable orchestration platform-owned
and put untrusted snippets in a restricted dynamic sandbox. Arbitrary customer
Durable Object code has a broader network boundary.

[Durable Object duration and storage](https://developers.cloudflare.com/durable-objects/platform/pricing/)
are separately metered. An agent waiting with a non-hibernating connection can
incur duration charges; the Workers for Platforms request price is not its whole
cost. Invocation CPU/subrequest limits also do not enforce a monthly account
spend ceiling: the shared admission/broker layer must enforce package budgets.

The [per-script secrets API](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/subresources/secrets/methods/update/)
is distinct from account-level Secrets Store. It offers a possible advanced mode
for a customer's own keys in their own deployed Worker; the 100-secret Secrets
Store limit is not a statement about this separate API. Directly bound secrets
are readable by that customer's code. Code editing/deployment authority must
therefore be treated as authority to use and potentially disclose those keys.
Keep shared team credentials and all Tendriller administration credentials behind
the broker unless the owner explicitly accepts that broader code authority.

Keep deployment API tokens in a separate control plane. Cloudflare's
[namespace roles](https://developers.cloudflare.com/workers/authorization/workers-for-platforms/)
cover every current and future Worker in their namespace, not an individual
customer Worker. A customer must not receive a platform token for a shared
namespace. Tendriller authorizes ownership, code versions, and requested resources
before making deployment calls on the customer's behalf.

[Published Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)
is $25/month including 1,000 scripts, 20 million requests, and 60 million CPU
milliseconds; extra scripts cost $0.02 each per month, with request/CPU overages.
Storage, durable execution, and model/provider charges need separate budgeting.
The authority, privacy, effect-ledger, and budget requirements apply to both
execution modes. Qualify their exact resource support and economics before launch.

## Dynamic Worker isolation and cost

Dynamic Workers entered [open beta for paid Workers users](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/).
Treat the execution service as an optional capability with an explicit readiness
check and a disable switch while its platform dependencies evolve.

Set `globalOutbound: null` explicitly. It blocks global `fetch()` and `connect()`;
omitting it inherits the parent's network access. Grant only the broker bindings
needed for the invocation, following Cloudflare's [egress controls](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/).
Blocking networking does not constrain an overly broad broker, so all operation
checks still belong in trusted code. Strip transport credentials before passing
any request data to the sandbox.

The [loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/)
offers `load(code)`, which creates a fresh Worker, and `get(id, callback)`, which
may reuse an isolate. A cached ID must always identify identical code and
configuration; eviction is possible, so memory is never durable job state.
Use a fresh Worker for initial actions that process private inputs. If caching
is introduced, partition by action/configuration version and privacy principal,
and supply short-lived capabilities per invocation. Never share a private-data
isolate across principals. [New capabilities do not erase private data retained
in a cached Worker's memory](https://developers.cloudflare.com/dynamic-workers/usage/authentication/).

This choice affects cost. [Current pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
includes 1,000 creations per month and charges $0.002 per additional Dynamic
Worker per day. Each `load()` invocation counts as a creation; repeated use of
the same ID and code that day counts once. Requests and startup/execution CPU
are also charged under Workers rates. Creation charging began on 2026-05-26;
the earlier beta announcement's temporary pricing note is outdated. Include
creation cost and provider costs in product budgets before promising allowances.

Selected inputs are plaintext to the execution service and any provider that
receives them. Say exactly what leaves the device and how long it is retained.
Private page state stays on peers unless explicitly selected for that action;
server-side execution is not end-to-end secrecy from that executor.

## Jobs and retry safety

Keep a trusted effect ledger outside application reducers. Scope an operation ID
to the account and immutable action version and bind it to an input digest.
Reserve execution atomically: identical retries return the existing status or
result; reusing the ID with changed inputs fails. Apply equivalent idempotency to
each broker effect so a sandbox cannot duplicate an external action on retry.

Record pending, running, completed, failed, and uncertain outcomes. Use provider
idempotency keys where supported. If a provider may have committed an action
before a connection failure, reconcile it or require an explicit retry decision;
an application ledger alone cannot guarantee exactly-once external effects.
The job must retain the original signed intent and pinned version across retries.
Do not let a resumed job acquire newer, broader permissions automatically.

Return a bounded receipt that an authorized participant may append to Chronolog.
Define owner access and retention for any retained input/result; keep plaintext
payload retention off by default. The blind host never materializes a page to
discover jobs. Initially the initiating participant submits jobs explicitly.

## Resource limits and operational insight

Require per-account concurrency, runs/day, input/output size, provider-operation,
and spending limits, plus service-wide stop controls. Reserve budgets atomically
before effects and settle actual usage afterward. Apply [Dynamic Worker CPU and
subrequest ceilings](https://developers.cloudflare.com/dynamic-workers/usage/limits/).
Use deadlines and expiring broker capabilities to deny late side effects; a
caller timeout alone is not a guarantee that all execution has stopped.

The [current platform limit](https://developers.cloudflare.com/dynamic-workers/platform/limits/)
is four distinct in-flight Dynamic Workers per Worker request, or ten across a
Durable Object's shared I/O context. Bound fan-out rather than treating these as
per-account quotas. Measure real costs before choosing premium allowances.

Extend aggregate analytics with fixed numeric counters for attempts, outcomes,
duration buckets, creations, and provider units. No page IDs, account IDs, code,
URLs, inputs, outputs, secrets, or arbitrary exception text belong in global
metrics. Keep the restricted effect ledger and owner receipts separate.
Cloudflare [collects sandbox logs and discards them by default](https://developers.cloudflare.com/dynamic-workers/usage/observability/);
do not attach a tail that forwards arbitrary console output into persistent logs.
Use fixed outcome codes and sanitized operational events. Obtain actual CPU and
infrastructure usage from provider metrics, not inferred application counters.

## Suggested delivery sequence

1. Build the shared control plane, one or two trusted broker adapters,
   operator-provisioned connections, signed immutable manifests, owner grants,
   and the effect/budget ledger. No UI is required.
2. Implement both minimal execution paths: deploy/invoke a named customer agent
   through Workers for Platforms, and submit a bounded JavaScript task through
   Dynamic Workers. Use one permission and accounting model for both.
3. Qualify tenant isolation, changed-code rejection, denied egress, revoked access
   in warm Workers, budget races, provider uncertainty, and payload-free logs in
   an isolated staging environment. Verify real provider billing and retention.
4. Add owner-managed connections and reviewed action templates after defining
   secret lifecycle and quota capacity. A model adapter with cost limits or an
   integration scoped to one repository makes a useful first product surface.
5. Add webhook triggers, schedules, approval pauses, and resumable workflows as
   separate opt-ins. [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)
   provide durable steps; persisted step results need explicit data-retention rules.
6. Consider [Durable Object facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
   for actions that need their own isolated SQLite state under a trusted
   supervisor. Keep that state separate from private page replicas and secrets.
   A user-operated executor is another future option for people who prefer
   credentials and disclosed inputs to stay on their own infrastructure.

These are future execution capabilities. The present PR's admin permissions
remain limited to premium grants, their audit trail, and aggregate service usage.
