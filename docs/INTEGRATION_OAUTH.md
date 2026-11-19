# First-party integration OAuth and current account access

The Tendriller account host can serve as the authorization server for its
[optional ChatGPT integration](https://github.com/werg/tendriller/blob/master/integrations/chatgpt/README.md). It uses the
existing GitHub/Google browser login and the same current account and page
ownership records. The Node integration can use the included host account
adapter instead of requiring a separate identity provider or account database.

This feature is optional. Without `OAUTH_CONFIG_JSON`, its routes return 404.
When enabled but misconfigured, they fail with a generic 503 and issue no
credentials. Enabling it does not enroll a Chronolog device, grant application
consent, publish code, or establish a live ChatGPT connection.

## Prepare the host and client

1. Use a selected Tendriller deployment with working GitHub or Google login,
   HTTPS, page-origin isolation, and the existing account database. `PUBLIC_BASE`
   must be its exact HTTPS origin, without a trailing slash. The issuer is that
   origin; `/auth/*` continues to own upstream provider login.
2. Apply `server/migrations/0002_integration_oauth.sql` to that account database
   before enabling the feature. An existing current account database already
   has `0001_accounts.sql`; apply only the additive migration. For a fresh
   database, apply 0001 and then 0002. No existing account or page data is
   rewritten, and no Durable Object schema revision changes.
3. Choose the Node service's exact public HTTPS MCP resource, such as
   `https://assistant.example/mcp`. The same complete value must appear in the
   host configuration, Node resource metadata, OAuth authorization request,
   token exchange and token audience. Resource URLs cannot contain a query,
   fragment, user information or wildcard.
4. Create a predefined OAuth client registration. Copy the **actual callback
   URL shown by the intended ChatGPT connector setup** into `redirectUris`.
   The issuer-identifying and older per-connector callback forms differ;
   do not infer a callback from an example or permit a wildcard. Enroll every
   permitted redirect as its exact canonical HTTPS string.
5. Create a separate bridge credential for the Node service. Its raw value is
   at least 32 random bytes encoded as unpadded base64url. The host stores only
   its lowercase SHA-256 hex digest; the Node service retains the raw secret
   privately. This credential is independent from the OAuth client secret.
6. Install the validated configuration and private signing key below through
   the deployment's configuration and secret facilities. Configure the Node
   host account adapter with the same origin, bridge ID, raw bridge secret,
   resource, actual application IDs and actual page IDs.
7. Run the integration's read-only online preflight, then complete the real
   browser linking and application consent flow. Building or testing this
   source does not deploy a Worker, apply a remote migration or configure
   ChatGPT.

The public engine archive includes both SQL files. Existing consumers keep
`@tendriller/engine/accounts-schema`; the new
`@tendriller/engine/integration-oauth-schema` export resolves the additive SQL.
Both are included in the engine's provenance hashes. An external Worker
deployment must deliberately apply the second file before configuring OAuth.
The repository's normal service and isolated branch-preview workflows already
apply pending D1 migrations before deployment, including this additive file.
The extra tables remain dormant when OAuth is disabled. The existing
`scripts/storage-schema.mjs` gate still reports Durable Object revision 9.
An enabled host missing the optional tables returns a 503 naming
`0002_integration_oauth.sql`, including from discovery and bridge preflight.
The read-only schema readiness result is cached for at most five seconds.

## Configuration contract

`OAUTH_CONFIG_JSON` is a JSON string with this shape. Values in angle brackets
are required operator inputs, not working defaults:

```json
{
  "resource": "https://assistant.example/mcp",
  "clients": [{
    "id": "tendriller-chatgpt",
    "name": "ChatGPT",
    "redirectUris": ["<exact callback copied from ChatGPT setup>"],
    "scopes": ["applications:read", "applications:write", "events:subscribe"],
    "tokenEndpointAuthMethod": "none",
    "allowRefresh": true
  }],
  "bridges": [{
    "id": "assistant-bridge",
    "name": "Tendriller connection settings",
    "secretSha256": "<64 lowercase hexadecimal characters>",
    "applicationIds": ["<actual 64-character application identity>"],
    "managementRedirectUris": ["https://assistant.example/connections/callback"]
  }],
  "accessTokenTtlSeconds": 300,
  "grantTtlSeconds": 604800
}
```

Public clients use `tokenEndpointAuthMethod: "none"` and send `client_id` at
the token endpoint. Confidential clients use `"client_secret_basic"` and add
`clientSecretSha256`, the lowercase SHA-256 digest of a separately generated
secret of 32–512 characters. Supply that raw client secret only to the actual
registered client. HTTP Basic uses OAuth form encoding for the client ID and
secret. Request-body `client_secret` is rejected. **Both client types require
PKCE S256.** Register only the method the actual connector will use.

The supported scopes are:

| Scope | Integration boundary |
| --- | --- |
| `tendrils:list` | List the authorized page catalog. |
| `tendrils:create` | Use separately enabled page creation with a currently verified account email. |
| `applications:read` | Read explicitly connected application queries and selected event details. |
| `applications:write` | Submit separately permitted application commands. |
| `events:subscribe` | Register separately consented application event subscriptions. |
| `pages:publish` | Use separately configured exact-review publication procedures. |

Scopes are ceilings, not substitutes for current host access, owner consent,
native device grants or publisher approval. Register the smallest set the
deployment actually provides. An empty scope set identifies the linked account
without granting those operations. The server presents requested permissions
for an explicit Allow/Cancel decision on every authorization request.

Defaults are 300 seconds for access tokens and seven days for renewable grants.
Access-token lifetime is configurable from 60–600 seconds; grant lifetime is
600–2,592,000 seconds. Refresh is disabled unless the individual client sets
`allowRefresh: true`. A client without refresh receives a grant that lasts only
the access-token lifetime. Neither scope nor refresh lifetime can be selected
by an unregistered client.

Configuration accepts at most 32 clients, eight registered redirects per
client, eight bridges, 128 application IDs per bridge and eight management
callbacks per bridge. Unknown fields, duplicate IDs, duplicate redirects,
unsupported scopes and duplicate bridge secret hashes fail closed. Omitting
`applicationIds` denies all page checks for that bridge. Omitting
`managementRedirectUris` disables its browser handoff. Every management callback
is independently registered; it is not an OAuth client callback.

### Signing keys and rotation

Set `OAUTH_SIGNING_JWK` as a **secret**, containing a private JWK with a unique
`kid`, `alg`, and private key material. Supported algorithms are RS256 with an
RSA key of at least 2048 bits, and ES256 with a P-256 key. Prefer 3072-bit RSA
when choosing RS256. Symmetric JWT keys and token-supplied signing endpoints
are not accepted. The active key is imported for signing and verified against
its published public key before configuration is considered usable.

Optionally set `OAUTH_PUBLIC_JWKS` to `{"keys":[...]}` containing up to four
retired **public** keys. Each needs a distinct `kid` and its correct `alg`.
Private parameters are rejected. `/oauth/jwks` publishes the active public key
plus these retained verification keys; it never returns private key fields.

Rotate by installing the new private key and retaining the previous public
key for at least the longest previously issued token lifetime plus the
verifier's configured clock tolerance. Keep old keys only as long as intended
for validation. Introspection still checks exact grant/account revocation;
possession of a cryptographically valid expired or revoked JWT is insufficient.
Keep signing keys, raw bridge/client secrets, browser cookies and token bodies
out of source control, rendered assets and request logs.

## Protocol endpoints

All endpoints below belong to `PUBLIC_BASE`. Page subdomains cannot access
the service account routes. OAuth success and redirected error responses
include the original `state` and the exact issuer in `iss`. Invalid or
unregistered callbacks receive a local error without a redirect.

| Endpoint | Contract |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` | Public metadata advertises code flow, S256, exact endpoints, configured authentication methods, scopes and optional refresh. |
| `GET /oauth/jwks` | Public signing keys only. |
| `GET /oauth/authorize` | Requires `response_type=code`, registered `client_id`, exact `redirect_uri`, exact `resource`, `state`, `code_challenge`, `code_challenge_method=S256`; optional `scope`. Signs in through the existing host login, then displays explicit consent. |
| `POST /oauth/authorize` | Existing host browser session, exact same-origin form and single-use session-bound approval intent. Issues a two-minute, one-use authorization code after Allow. |
| `POST /oauth/token` | Form-encoded code exchange with exact `resource`, `redirect_uri`, PKCE verifier and configured client authentication; or an enabled `refresh_token` grant with the same resource. |
| `POST /oauth/revoke` | Registered client authentication and form `token`; idempotently revokes that token's complete authorization grant. |
| `POST /oauth/introspect` | Registered **bridge** Bearer credential and form `token`; returns current active status and issued claims for an exact stored access-token hash. |
| `GET/POST /oauth/connections` | Existing host browser login; lists only that account's grants and allows explicit same-origin revocation. |

Access tokens are asymmetrically signed JWTs with `typ: at+jwt`, `iss`, `sub`,
`aud`, `client_id`, `scope`, `iat`, `exp`, `jti` and `sid`. `sub` is the real
Tendriller account ID; `sid` is the exact authorization grant ID. The Node
adapter verifies the signature, issuer, audience, time and scopes, then
authenticates to introspection and compares current claims. It preserves the
trusted grant ID when binding subscriptions to their owner.

Refresh tokens rotate on every successful use. The old token and replacement
relationship are retained until grant expiry or revocation cleanup. A replay
of a used refresh token revokes the whole grant, including any concurrently
issued replacement. A correctly authenticated and PKCE-proven reuse of an
authorization code also revokes its grant. A wrong verifier does not consume
the code or revoke credentials. Lost refresh/code responses can therefore
require a new browser authorization; clients must not silently retry a used
credential indefinitely.

This is a predefined-client OAuth server. It does not provide dynamic client
registration, Client ID Metadata Documents, OIDC ID tokens, UserInfo or
enterprise email-domain verification. Configure the intended connector with
its actual client registration. If that surface requires additional identity
features, use a compatible external provider through the integration's
[external issuer interface](https://github.com/werg/tendriller/blob/master/integrations/chatgpt/AUTH.md).

## Current account and page authority

`POST /oauth/account-access` requires the registered bridge Bearer credential
and JSON containing `issuer` and `subject`. For a page check, include both
`applicationId` and `pageId`; the Node deployment supplies this mapping from
the real page handle and application descriptor. Optional `grantId` binds
the check to one exact OAuth authorization. Optional `managementSessionId`
binds it to an exchanged browser handoff.

```json
{
  "issuer": "https://tendriller.example",
  "subject": "<actual account ID>",
  "applicationId": "<actual application identity>",
  "pageId": "<actual page ID>",
  "grantId": "<trusted sid from verified and introspected OAuth token>"
}
```

The result contains `active`, `access`, `owner`, `oauthAuthorized` and `scopes`.
A valid page-scoped request always echoes `applicationId` and `pageId`,
including denials. Active accounts also receive `account: {id,issuer}`.
Account-only lookups may include `account.email`, and only when the account
currently has that verified email in its linked identity records. Tokens do
not supply account or email authority.

Page access requires the application's presence in the bridge's configured
allowlist, the page's actual selected application, current account status,
current page-owner agreement between D1 and the Durable Object, and either
ownership or a currently approved guest invitation. Guest invitation deletion,
expiry, page holds and account suspension are checked against current state.
The internal Durable Object route is not reachable from public HTTP.

When `grantId` is supplied, `oauthAuthorized` and `scopes` describe exactly
that live grant for the same account and configured resource. Another active
grant never replaces a revoked grant. The Node OAuth adapter must require
`active && access && oauthAuthorized` and the original required scopes for a
protected application operation. `owner` is a separate check for changing
application consent. Account-only service lookup is not proof that a browser
or OAuth client is authenticated.

`POST /oauth/bridge-status` accepts the bridge Bearer credential and an empty
JSON object. It returns only that bridge's `bridgeId`, `resource`,
`applicationIds`, `managementRedirectUris` and
`authorizationServerReady: true`. Configuration and actual signing-key/JWKS
usability are validated first. This read-only preflight creates no account,
grant or browser session and reveals no other bridge's configuration.

## Browser connection-management handoff

The Node `/connections/login` route generates a private random state and PKCE
verifier, then redirects to `/oauth/management/login` with the bridge ID as
`client_id`, its exact registered management `redirect_uri`, state, and S256
challenge. The host requires an existing real browser login and a separate
explicit Continue/Cancel decision. This step grants no application permission.

The approved one-use handoff code lasts 60 seconds. The Node service exchanges
it at `POST /oauth/management/exchange` using its bridge Bearer credential and
JSON `{code, redirect_uri, code_verifier}`. A successful response is:

```json
{
  "id": "<actual account ID>",
  "issuer": "https://tendriller.example",
  "expiresAt": 1795090500000,
  "managementSessionId": "<opaque random proof>"
}
```

`expiresAt` is epoch milliseconds, bounded by both 15 minutes and the original
host browser session. The opaque proof is stored only as a hash in D1 and is
bound to the exact bridge, account, MCP resource, registered callback and
original host session. The Node service stores it in its encrypted session
state and sends it on **every** browser account/owner check. It must never
fall back to an account-only lookup when the proof is missing or invalid.

An invalid, expired or revoked supplied ticket makes `active`, `access`,
`owner` and `oauthAuthorized` false, with no account identity returned. Host
logout deletes the original session and invalidates exchanged tickets through
the database relationship. Suspension, account deletion, session expiry,
resource changes and removal of the registered callback also deny use. Node
logout deletes its local browser session; a fresh sign-in is required to obtain
another usable ticket. The host keeps at most 20 live management tickets per
account.

OAuth grants remain independent from browser login sessions. Signing out of
the host invalidates browser management tickets, while deliberately granted
background OAuth authorization continues until expiry or explicit revocation
at `/oauth/connections`. Changing per-application consent in the Node manager
is a separate owner-authorized decision.

## Bounds, verification and operational limits

OAuth forms are limited to 32 KiB and 32 distinct parameters; JSON service
requests to 8 KiB. Reads have a ten-second deadline. URL length, client lists,
scope lists, authorization intents and token histories are bounded. Public
authorization traffic uses the host authentication rate limiter; authenticated
bridge traffic uses the account rate limiter under its bridge ID, with failed
credentials limited separately. Limits are admission controls, not a claim
of production capacity.

The implementation stores hashes of codes, access tokens, refresh tokens,
handoff codes and management tickets. It retains only the minimum issued
claims and authority bindings needed for revocation and replay detection.
Cleanup removes expired short-lived records and expired grants; revoked grants
are retained briefly for failure/replay handling before cascading cleanup.
The Node service must keep its own delivery and consent store encrypted and
must recheck current host access before protected operations and deliveries.

`server/test/integration-oauth.public.test.ts` runs against real workerd,
WebCrypto, D1 and page Durable Objects. It exercises signing/discovery,
explicit browser approvals, PKCE, exact callbacks/resources, current owner
and guest access, code replay, refresh rotation races, exact grant revocation,
management ticket binding, host logout and secret-free rejection responses.
Its browser accounts and callback transport are test fixtures; it does not
authenticate to live GitHub/Google or connect an actual ChatGPT client.

The independent package consumer also applies the exported account baseline
and OAuth migration from the packed engine. Keep live deployment qualification
separate: verify the selected host's real login, exact connector callback,
explicit app permissions, a native command and event round trip, current
revocation, and restart of the same private device/store before claiming an
operational integration.

## Protocol sources

- [OpenAI: MCP authentication](https://developers.openai.com/plugins/build/auth)
  describes predefined clients, PKCE, exact resource binding and connector callbacks.
- [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html) defines authorization-server metadata.
- [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html) defines OAuth resource indicators.
- [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) defines the authorization-response issuer identifier.
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) specifies OAuth security practices, including refresh-token replay protection.
- [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html) defines the JWT access-token profile.
- [RFC 7662](https://www.rfc-editor.org/rfc/rfc7662.html) defines token introspection.
- [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html) defines token revocation.
