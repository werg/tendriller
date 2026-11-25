# First-party integration OAuth

The Tendriller host acts as the OAuth 2.1 authorization server for its same-origin `/mcp` gateway (see [Cloudflare assistant setup](CLOUDFLARE_ASSISTANT.md)). It uses the existing GitHub/Google browser login and current account and page ownership records in `server/migrations/0001_accounts.sql`.

OAuth is optional. Without `OAUTH_CONFIG_JSON`, its routes return 404. When misconfigured, they return 503 and issue no credentials. Enabling OAuth does not enroll a Chronolog device, grant per-app capabilities, or publish code.

## Host setup

1. Deploy Tendriller with working GitHub/Google login, HTTPS, per-page origin isolation, and the unified account schema (`0001_accounts.sql`, packaged as `@tendriller/engine/accounts-schema`). `PUBLIC_BASE` must be the exact HTTPS service origin without a trailing slash.
2. Set the OAuth `resource` to `<PUBLIC_BASE>/mcp` (no query, fragment, userinfo, or wildcard).
3. Register each allowed client with its exact canonical HTTPS `redirectUris`.
   - For ChatGPT's Client ID Metadata Document flow, set `metadataDocument: true`, `tokenEndpointAuthMethod: "none"`, `id: "https://chatgpt.com/oauth/client.json"`, and pin its exact redirect URI. The host verifies the public metadata document on consent.
   - Confidential clients use `tokenEndpointAuthMethod: "client_secret_basic"` with `clientSecretSha256` (lowercase SHA-256 hex of a 32–512 character secret). HTTP Basic uses OAuth form encoding; request-body `client_secret` is rejected.
   - **All clients require PKCE S256.**
4. Install `OAUTH_CONFIG_JSON` and the private signing key `OAUTH_SIGNING_JWK` via your deployment secret store.

## Configuration schema (`OAUTH_CONFIG_JSON`)

```json
{
  "resource": "https://tendriller.dev/mcp",
  "clients": [{
    "id": "https://chatgpt.com/oauth/client.json",
    "name": "ChatGPT",
    "metadataDocument": true,
    "redirectUris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
    "scopes": ["tendrils:list", "tendrils:create", "applications:read", "applications:write", "events:subscribe"],
    "tokenEndpointAuthMethod": "none",
    "allowRefresh": true
  }],
  "accessTokenTtlSeconds": 300,
  "grantTtlSeconds": 604800
}
```

### Supported scopes

| Scope | Ceiling |
| --- | --- |
| `tendrils:list` | List assistant-connected pages for the linked account. |
| `tendrils:create` | Use `register_agent` to give the assistant an account-level agent credential (one `ta_` token, one signing key) that creates and maintains the account's pages. |
| `applications:read` | Execute approved read queries and read retained events. |
| `applications:write` | Execute approved commands. |
| `events:subscribe` | Register approved application event subscriptions. |
| `pages:publish` | Use explicit reviewed publication flows. |

Scopes are ceilings only; current account status, per-page owner consent, and Chronolog device grants are checked independently. Every authorization request presents an explicit Allow/Cancel consent screen.

Defaults: `accessTokenTtlSeconds` = 300 (range 60–600), `grantTtlSeconds` = 604800 (range 600–2,592,000). Refresh requires `allowRefresh: true` on the client. Configuration allows at most 32 clients and 8 redirects per client; unknown fields, duplicate IDs/redirects, or unsupported scopes fail closed.

### Signing keys and rotation

- `OAUTH_SIGNING_JWK` (secret): private JWK with unique `kid` and `alg` (`RS256` with ≥2048-bit RSA, prefer 3072-bit; or `ES256` P-256). Symmetric keys are rejected.
- `OAUTH_PUBLIC_JWKS` (optional): `{"keys":[...]}` with up to four retired public keys retained during rotation. Private parameters are rejected. `/oauth/jwks` serves only public keys.

Rotate by installing the new `OAUTH_SIGNING_JWK` and keeping the previous public key in `OAUTH_PUBLIC_JWKS` for at least the max access-token lifetime plus clock skew. Token validation always verifies the live grant and account state in D1; a valid signature alone never overrides revocation.

## Endpoints

All OAuth endpoints live on `PUBLIC_BASE` (never on page subdomains):

| Endpoint | Behavior |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` | OAuth 2.1 server metadata (code flow, S256, scopes, endpoints). |
| `GET /.well-known/oauth-protected-resource/mcp` | Protected resource metadata binding `<PUBLIC_BASE>/mcp` to the issuer. |
| `GET /oauth/jwks` | Active and retained public signing keys. |
| `GET /oauth/authorize` | Validates `response_type=code`, registered `client_id`, exact `redirect_uri`, exact `resource`, `state`, `code_challenge`, `code_challenge_method=S256`; signs in via host login and renders explicit consent. |
| `POST /oauth/authorize` | Requires host session and single-use consent intent; issues a 2-minute single-use code. |
| `POST /oauth/token` | Exchanges code (with PKCE verifier and exact `resource`/`redirect_uri`) or rotates an enabled `refresh_token`. |
| `POST /oauth/revoke` | Authenticated client revocation; idempotently revokes the entire grant. |
| `GET/POST /oauth/connections` | Logged-in account view to inspect and revoke active OAuth grants. |

Access tokens are `at+jwt` JWTs containing `iss`, `sub` (Tendriller account ID), `aud` (`<PUBLIC_BASE>/mcp`), `client_id`, `scope`, `iat`, `exp`, `jti`, and `sid` (grant ID). Refresh tokens rotate on every use; replay of a spent refresh token or a PKCE-proven spent authorization code revokes the entire grant immediately.

## Account-bound agent registration

With `tendrils:create`, `register_agent {handle, bio?, publicKey, wrapKey}` registers an agent under the caller's linked account. The client generates and retains an Ed25519 signing key and an X25519 wrap key and sends only the base64url signing public key and the hex wrap public key; the result carries the agent's `ta_` credential once. Calling it again with the same name rotates the token and key. The agent creates pages with `POST /api/agent/pages`, and the owner grants any existing page from the dashboard. See [Agents and grants](AGENT_BINDINGS.md).

## Security invariants

- Keep `OAUTH_SIGNING_JWK`, client secrets, cookies, and tokens out of logs, source control, and published UI.
- Page subdomains cannot reach `/oauth/*` or `/mcp`.
- Invalid or unregistered `redirect_uri` values return a local error without redirecting.
- Account suspension or grant revocation immediately blocks subsequent `/mcp` dispatches.
