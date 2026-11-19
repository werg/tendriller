# Authentication and connection consent

This integration consumes access tokens from a separately configured OAuth 2.1
authorization server. It does not replace Tendriller account sign-in, issue
Chronolog device identities, or turn OAuth scopes into application grants.

## Configure the authorization provider

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
Account-to-application lookup must still validate that identity against Tendriller
account access. Neither an email nor a user-supplied page URL establishes access.
Return a persisted opaque profile ID from a designated authenticated profile tool;
never generate a different ID for each token or use mutable email as identity.

Use an `OAuthError`'s `status`, `code` and `challenge` when forming HTTP failures.
Publish per-tool OAuth `securitySchemes`; tool-level reauthorization also needs
an error result with `_meta['mcp/www_authenticate']`. Do not return tokens or raw
provider errors to the model. JWT expiry is checked on each invocation. Immediate
application disconnect must revoke local consent and/or device grants rather
than wait for token expiry; provider-level immediate JWT revocation needs a
provider introspection/denylist layer in front of this verifier.

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
and grant/disconnect form endpoint. Supply an exact public HTTPS `origin`, a
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
secure account-cookie/login policy; this helper does not create a login session.

An unconfigured deployment can use `renderConnectionsHtml(principal)` as a
read-only status view. It has no mutation controls without CSRF context. Do not
expose a generic MCP tool that silently grants new connections. Actual remote
reader enrollment, outbound content consent and publisher permission must remain
reviewable, explicit actions.

## Verification and deployment boundary

Run `node --test integrations/chatgpt/test/auth.test.mjs
integrations/chatgpt/test/consent.test.mjs` for signature, claim, scope, cache,
rotation, malformed-input, consent isolation/revocation and management-CSRF
checks using generated local keys and a synthetic transactional store.
Those tests do not establish a configured live provider, an account linking
round-trip, public HTTPS deployment, or access to a real Chronolog application.
All of those remain explicit deployment prerequisites.

The current provider contract was checked against [OpenAI authentication
documentation](https://developers.openai.com/plugins/build/auth) on 19 November
2026. The implementation uses Node's built-in crypto and Fetch APIs and has no
additional runtime dependencies.
