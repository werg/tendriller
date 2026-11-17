# Host operations

Tendriller deploys one generic engine with a filtered Chronolog participant. Hosting supplies accounts, signed controls/code, introductions and lifecycle policy. Application execution stays in owned sessions.

## Fresh baseline

Use `node scripts/storage-schema.mjs` to identify the current Durable Object schema. This pre-release version supports only fresh matching storage. Initialize the account database from `server/migrations/0001_accounts.sql` and create fresh `Tendril` and `Admission` namespaces. Do not point a new application baseline at existing page storage or translate old application records.

`scripts/provision.mjs` plans/provisions explicitly named fresh resources and writes a complete configuration. Review the intended Worker, D1 database, R2 bucket, service domain and page-domain isolation before deploying that configuration. Checked-in staging/production configuration is not evidence that resources have been prepared for the current baseline. The service workflow requires an explicit ready variable and matching storage-schema declaration; advance these only after fresh provisioning and verification.

There is one Worker entry and one set of Durable Object classes. Staging, production and isolated branch previews consume that generic engine; no version-specific deployment subclass or cutover migration selects another implementation.

## Configuration

Keep the service origin separate from every page origin. Each page must have its own hostname; placing all pages below one shared origin would merge browser storage and account-session boundaries. Configure the wildcard page route/certificate, OAuth callbacks, account database, file bucket and intended anti-abuse credentials explicitly.

Store secrets in the platform's secret store. Agent bearer tokens and OAuth/page sessions are credentials; do not publish them in logs, code assets or example configuration. The runtime creates no second browser device secret. Chronolog device signing keys and epoch keys belong to the owned application store.

The service starts with creation paused. Configure and exercise owner sign-in, page claim, account status, page-origin isolation and signed publication before opening creation. Publish the exact runtime assets required by the engine. Changing configuration or building code does not deploy it.

## Validation and deployment

Run `npm run check:release` against an exact checkpoint. Verify source provenance and archive hashes. Use the existing release/deployment workflow only for an explicitly authorized target. Service smoke checks compare contract and immutable runtime identity and require the participant limits advertised by the host.

The current-generation application can operate without host requests while its coordinator is reachable. Test control outages separately from coordinator loss. A host restart must preserve signed authority, publication head, historical code and operation retries. Code rollback is always a new authorized signed publication.

## Isolated branch previews

The branch-preview controller selects a passing exact branch head and provisions isolated Worker/account/file resources. It checks that the branch still exists before deployment. Preview names and deletion targets derive from that branch; cleanup must remain scoped to its resources.

Previews use the same engine and code artifacts. They begin with creation paused and need their own working identity callbacks before accepting claims. Their disabled scheduled reconciliation means they do not qualify production scheduling. See `scripts/branch-preview.mjs plan --branch <branch>` for the concrete resource plan; deploying or deleting it is an external action.

## Operational response

Service state can pause creation or make the host read-only. Page/account holds revoke access and close introduction sockets; session device revocation is a separate signed control decision. Use account notices and appeal/review facilities for the host's moderation workflow.

Inspect reserved file bytes against host/account ledgers when diagnosing storage discrepancies. Retained signed releases keep their immutable file references; orphan cleanup must not delete those assets. Page/account deletion deliberately removes hosted resources, while independently retained application data remains subject to the application's own policy.

The account dashboard shows host lifecycle/publication activity. Local camera, microphone and location activity is tracked and stopped on the device; it is not a host sensor-history product. Use measured application/host traffic and actual deployment metrics when making capacity or cost claims.
