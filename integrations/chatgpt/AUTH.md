# Authentication and connection consent

This integration accepts OAuth access tokens and checks current Tendriller
account access separately from application consent and native device authority.
The included Tendriller host authorization server uses the host's existing
GitHub/Google login. An external OAuth provider remains an optional alternative.
Neither route issues Chronolog device identities or turns scopes into native
application grants.

## Use the Tendriller account host

Use [config.host-account.example.mjs](config.host-account.example.mjs) or the
[deployment preparation tools](deploy/README.md) for the first-party route.
The [host OAuth guide](../../docs/INTEGRATION_OAUTH.md) describes the additive
account migration, private signing key, predefined client registration and
separate bridge credential. Register the exact callback shown by the intended
ChatGPT connector and the Node service's exact `/connections/callback` URL.
The OAuth client and the service bridge have different credentials and duties.

`createIntegration({resource, applications, storePath, storeKey, hostAccount})`
composes the included account adapter and owner browser handoff. `hostAccount`
contains the exact host `origin`, registered `bridgeId`, private `bridgeSecret`
and a random `csrfKey` of at least 32 bytes. Each application supplies its actual
`pageId`, immutable application ID, dedicated session opener and permission
allowlists. The factory rejects mixing this mode with external authentication
or account callback overrides.

The adapter checks JWT signatures against the host's public JWKS, introspects
each access token, and binds the principal to that exact OAuth grant. Before
protected operations and event delivery it checks current account/page access
and the same grant again. Another active grant cannot replace a revoked one.
Background subscriptions retain only the trusted grant ID and scopes, never
the bearer token.

`/connections/login` sends the browser through the real host login and an
explicit Continue/Cancel decision. The one-use exchange requires the private
bridge credential, S256 proof and exact registered callback. The Node service
uses an opaque secure cookie and encrypted session state. Its management ticket
is bound to the original host browser session and is rechecked on every owner
action. Host logout or account suspension invalidates that ticket. Node logout
clears its own session. OAuth grants remain independently revocable at the
host's `/oauth/connections` page.

Signing in grants no application permissions. The owner still reviews the exact
queries, commands, events and optional event-detail access on `/connections`.
The host checks current page ownership against its account database and page
Durable Object; the Node mapping comes from the actual page handle and immutable
application descriptor. A supplied email or application ID cannot establish
ownership. `integration.account.checkHostConfiguration()` provides a read-only
check of the registered resource, bridge, application allowlist and callback;
it does not claim a linked ChatGPT client or owner consent.

## Configure an external authorization provider

Use the deployment's existing identity provider. Configure an authorization-code
flow with PKCE `S256` and an exact resource audience for the MCP endpoint. Publish
OAuth authorization-server or OpenID Connect metadata, including the issuer,
authorization endpoint, token endpoint, and supported client-authentication
methods. Use CIMD, dynamic registration, or a predefined OAuth client as supported
by that provider and the host. Copy the exact redirect URI shown in the ChatGPT
plugin management page into the provider's allowlist.

If `authorization_response_iss_parameter_supported` is advertised, every success
and error authorization response must include the same exact `iss`. Enable all
advertised OIDC scopes. Preserve `resource` through authorization and code
exchange, and issue short-lived JWT access tokens with that audience. Token
refresh/revocation remains the provider's responsibility.

Configure `createOAuthVerifier` with trusted deployment values:

```js
import { createOAuthVerifier } from './auth.mjs';

const auth = createOAuthVerifier({
  issuer: 'https://identity.example.org',
  resource: 'https://mcp.example.org/mcp',
  jwksUri: 'https://identity.example.org/.well-known/jwks.json',
  scopesSupported: [
    'tendrils:list', 'applications:read', 'applications:write',
    'events:subscribe', 'pages:publish',
  ],
});

// GET /.well-known/oauth-protected-resource
// Return JSON.stringify(auth.metadata).
// Authenticate every MCP operation before consulting account/app permissions.
const principal = await auth.authenticate(request, {
  requiredScopes: ['applications:read'],
});
```

The issuer and JWKS URL are operator configuration, never tool arguments or token
headers. JWKS redirects are rejected. Keys are fetched over HTTPS with a bounded
response, timeout, five-minute cache and five-second refresh cooldown. Unknown
key IDs refresh after that cooldown; providers should publish overlapping keys
before issuing tokens with new IDs. Unavailable/invalid signing keys fail closed.
Supported algorithms are RS256 (RSA at least 2048 bits), ES256 (P-256), and EdDSA
(Ed25519). Narrow `algorithms` when the provider uses only one. Symmetric tokens,
embedded/untrusted key URLs, duplicate JSON members/key IDs, expired tokens,
wrong issuers/audiences, and incompatible key types are rejected.

`authenticate()` returns only the stable subject, issuer, scopes and expiration.
For this external-provider route, the supplied account-to-application lookup
must validate that identity against Tendriller account access. Neither an email
nor a user-supplied page URL establishes access.
Return a persisted opaque profile ID from a designated authenticated profile tool;
never generate a different ID for each token or use mutable email as identity.

Use an `OAuthError`'s `status`, `code` and `challenge` when forming HTTP failures.
Publish per-tool OAuth `securitySchemes`; tool-level reauthorization also needs
an error result with `_meta['mcp/www_authenticate']`. Do not return tokens or raw
provider errors to the model. JWT expiry is checked on each invocation. Immediate
application disconnect must revoke local consent and/or device grants rather
than wait for token expiry; provider-level immediate JWT revocation needs a
provider introspection/denylist layer in front of this verifier. The included
host account adapter already supplies that layer for the first-party route.

## Explicit application connections

`createConsentService({store, authorizeOwner})` maintains only
`state.chatgptConnections` in the injected encrypted delivery store. `store.read()`
returns a snapshot; `store.transaction(mutator)` atomically commits a synchronous
mutation. Reuse the same durable store on restart. The service never writes
application history or device authority.

The required `authorizeOwner(principal, applicationId)` callback must look up
current ownership through Tendriller's account/page authorization. It must return
the boolean `true` to allow a new or replacement grant. A missing callback denies
grants. Do not implement this callback as a claim, scope, email, or page-URL check.

```js
const consent = createConsentService({ store, authorizeOwner });
// Call only after the authenticated owner reviews this exact selection.
await consent.grant(principal, {
  applicationId,
  queries: ['assistanceStatus'],
  commands: ['replyToAssistance'],
  events: ['assistant.help_requested'],
  readEvents: false,
});
await consent.assertAccess(principal, {
  applicationId, kind: 'command', name: 'replyToAssistance',
});
// Then enforce current account access, OAuth scopes AND live Chronolog grants.
```

There is one deterministic connection per issuer/subject/application. Re-granting
replaces the full selection, preserving its identity and creation time. Grants
expire in 30 days by default; callers can explicitly select a finite expiration
within one year or `null` for no expiry. Scope names use exact matches; wildcards
and undeclared privilege fields are refused. `event-details` requires both
`readEvents: true` and the exact selected event name. Notification consent alone
does not authorize reading detailed content.

`list(principal)` returns that account's connections and active/expired/revoked
status. `revoke(principal,{id})` is owner-bound and idempotent. An account may
always disconnect its own connection even if it no longer owns the application.
Every tool and delivery must call `assertAccess` again so revocation takes effect
before the next action. An HTTP request already sent cannot be recalled.
Grant changes use a version check: disconnect or another consent change while
ownership verification is pending prevents the older grant from activating.

### Browser management surface

`createConsentManagementHandler` provides an optional `/connections` HTML page
and grant/disconnect form endpoint. The `hostAccount` factory configuration
supplies its authenticated browser session and current owner catalog. For an
external account integration, supply an exact public HTTPS `origin`, a
random `csrfKey` of at least 32 bytes, the consent `service`, a real authenticated
account-session callback `authenticate(request)`, and
`applicationsForPrincipal(principal)`. The latter must return an authorized
server-side catalog of `{applicationId,label,queries,commands,events,
allowEventDetails}`; derive declared names from the application, not form inputs.

The page selects no permissions automatically. Submission checks a same-origin
request, a signed five-minute CSRF token bound to issuer/subject, the live
application catalog, and ownership. It rejects unknown fields, oversized forms,
and unlisted permissions. Responses are non-cacheable, forbid framing, and use
no JavaScript. The injected session must itself enforce the deployment's normal
secure account-cookie/login policy. The standalone consent helper does not
create a login session; the first-party account browser supplies one.

An unconfigured deployment can use `renderConnectionsHtml(principal)` as a
read-only status view. It has no mutation controls without CSRF context. Do not
expose a generic MCP tool that silently grants new connections. Actual remote
reader enrollment, outbound content consent and publisher permission must remain
reviewable, explicit actions.

## Verification and deployment boundary

Run `npm run test:chatgpt` on Node 24 for signature, claim, scope, cache,
rotation, current account/grant binding, browser handoff, real Node HTTP cookie
handling, consent isolation/revocation and management-CSRF checks. The host's
`server/test/integration-oauth.public.test.ts` additionally exercises real
workerd, D1, WebCrypto and page authorization. These local tests use generated
keys and synthetic browser accounts. They do not establish upstream
GitHub/Google sign-in, public HTTPS deployment or a real ChatGPT account link.
Complete those checks against the selected deployment before reporting a live
connection.

The current provider contract was checked against [OpenAI authentication
documentation](https://developers.openai.com/plugins/build/auth) on 19 November
2026. The authentication implementation uses Node's built-in crypto and Fetch
APIs and has no additional runtime dependencies.
