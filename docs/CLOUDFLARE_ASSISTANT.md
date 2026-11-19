# Connect ChatGPT through the Tendriller Worker

The existing service origin serves `/mcp`, protected resource metadata and
`/connections`. The selected page's existing `Tendril` Durable Object owns the
bridge device and encrypted delivery journal. The page's control participant
continues to use its original control-only signer. The bridge has its own signed
Chronolog grant and uses the application's selected history.

## Enable the kitchen application

The bundled application adapter is kitchen version 2. Its executable definition
is deployment-trusted code and opens only against the matching signed Chronolog
descriptor. An uploaded publication cannot install an executable host adapter.
The Worker exposes one configured kitchen page per deployment.

1. Create and claim the kitchen page using the [kitchen setup](https://github.com/werg/tendriller/tree/master/integrations/chatgpt/examples/kitchen). Keep its native coordinator available and publish the browser UI normally. The same coordinator serves browser and assistant peers.
2. Apply the existing additive account OAuth migration. Use the exact service origin plus `/mcp` for `OAUTH_CONFIG_JSON.resource`. Register the actual ChatGPT callback and secret method. For the Worker route, the OAuth `bridges` array can be empty. Install the normal `OAUTH_SIGNING_JWK` secret. [OAuth details](INTEGRATION_OAUTH.md)
3. Set `ASSISTANT_PAGE_ID` to the claimed page ID. Set `ASSISTANT_PAGE_TOKEN` to a dedicated agent token for this page and `ASSISTANT_STORE_KEY` to 32 random bytes encoded in base64. Keep both values in the Worker's secrets. Set `ASSISTANT_CALLBACK_ORIGINS` to the exact approved HTTPS callback origins, separated by whitespace. An empty allowlist permits query and command tools while declining webhook subscriptions.
4. Call `POST /api/t/{pageId}/assistant/device` with the page agent token. Save the returned public key. Run `npm run enroll -- PUBLIC_KEY` from the kitchen project to grant that worker device reader/writer access. The installed bridge needs neither coordination nor recovery, publishing or administration rights. Repeating device provisioning returns the original public key.
5. Start the existing kitchen coordinator with `TENDRILLER_WORKER_ASSISTANT=1 npm run peer`. It posts an authenticated wake after observing a changed request count or selected generation. On restart it sends an initial snapshot notice and the Worker resumes from its retained cursor. It sends no event payload.
6. Sign in at `/connections` on the same service origin. Approve the exact allowed queries, commands and events. Register `/mcp` in the intended ChatGPT client, confirm a read, and subscribe only in a supported chat. Verify a real page request produces one correlated reply.

## Wake, delivery and retries

An assistant invocation briefly opens one peer connection to the selected
coordinator, synchronizes verified history, performs its bounded work and
closes its relay. Subscribe verification and OAuth metadata can use the Worker
without a permanently running assistant connection. A delivery wake coalesces
with notices already queued. Each pass reads from a retained cursor, persists
the cursor and generated delivery jobs together, and sends at most four due
callbacks. The bridge keeps the same callback event identity on retry. The
page's existing alarm schedules continuation and retry work. A page with no
assistant work adds no assistant timer, peer advertisement or polling request.

Webhook destination origins are operator allowlisted. The Worker refuses
redirects and checks current page access, the exact OAuth grant, connection
consent and selected Chronolog history before each delivery. The callback
receives bounded event metadata. Owners can choose whether detailed read tools
may reveal application content. Failed peer scans back off and pause after
eight consecutive failures. A new notice or successful MCP POST can resume
retained work. Existing subscriptions and their initial cursor survive object
eviction. An unreachable coordinator delays synchronization and delivery until
it is reachable again.

The relay sockets opened by an invocation are closed when it returns. Incoming
page requests and existing hibernatable relay sockets retain their normal
lifecycle. Revocation is checked on future calls and deliveries, and page
deletion removes durable bridge state with the page.

## Staging checks

Use a configured staging page and a separate OAuth registration. Compare the
same page with the integration disabled and then enabled during a fixed idle
window. Record Worker and Durable Object requests, elapsed duration, SQL rows
and alarms. Include a cold MCP read, a burst of wake notices, a callback
failure followed by eviction before retry, and an actual ChatGPT reply in the
intended client. The local Worker tests exercise registration, selected event
delivery and restart behavior using a simulated callback receiver.
