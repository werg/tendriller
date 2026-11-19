# Deploy a standalone assistant adapter

Tendriller-hosted applications use the [Cloudflare Worker setup](../../../docs/CLOUDFLARE_ASSISTANT.md). Use this standalone service when operating an external adapter.

This route prepares a Linux systemd service behind Caddy, with a dedicated
non-root bridge identity and persistent private stores. It uses the concrete
Tendriller host OAuth/account integration; no custom account adapter or
always-true authorization callback is needed. Preparation does not deploy a
Worker, install a service, link a human account or trigger a ChatGPT turn.

Use Node 24 or newer on the build machine and service host. The pinned public
session package is the events-only Chronolog build at
`d014879ecb29714e80311d6101cfa8973953d5c4`. SQL or native RTC variants require their
own matched build and qualification; the default application uses the maintained
encrypted relay fallback. Keep the coordinating participant available separately.

## 1. Build an exact release

Start with clean Tendriller and Chronolog source checkouts. Select a reviewed core
commit that includes these scripts and the host OAuth changes:

```sh
node integrations/chatgpt/deploy/build-release.mjs \
  --core-source /absolute/clean/tendriller \
  --core-ref VERIFIED_40_HEX_CORE_COMMIT \
  --chronolog-source /absolute/clean/chronolog-db \
  --output /absolute/private/new-release-build
```

The builder uses isolated checkouts, lockfile-based dependency installation,
the public SDK/tools/runtime/host archives and the pinned public Chronolog
archive. It enables the actual native cases in `test:chatgpt` and the packed
host-to-Node account gate in `test:chatgpt:host`, and refuses an unsuccessful or
skipped qualification before completing `release/`. The `RELEASE.json` manifest
records exact source revisions, actual archive hashes and every regular release
file's hash. The release also retains `qualification/host-account.json` with the
actual host gate evidence and its limits. Keep the manifest and qualification
output together.
Source and dependency pins make the build repeatable; they are not a claim that
different toolchains produce identical archive bytes.

The integration workflow retains the downloadable `tendriller-chatgpt-release`
artifact and a separate `chatgpt-integration-qualification` artifact. Select the
run for the exact reviewed source and inspect its manifest and reports before
installation. An uploaded artifact is build evidence; it does not record a
public deployment or a live assistant conversation.

The release contains the integration with its locked runtime dependencies and a
minimal `bridge-template/` installed from the exact public archives. Neither
contains private handles, native devices, delivery keys or a creator signer.
Do not substitute an assumed npm release of `@chronolog/peer-session`.

## 2. Provision and enroll the actual kitchen

Follow the [kitchen setup](../examples/kitchen/README.md) using those exact
archives. The owner must claim the real page. Configure the new immutable
version 2 definition, publish its signed UI, and enroll the browser and separate
bridge key after verification. Preserve the full creator project and its native
store; it coordinates writes and retains publisher/administrator authority.
The assistant bridge is only a reader/writer.

An existing version 1 application cannot be upgraded by publishing version 2 UI
or replacing its domain module. Use a new application, or build a matching
application-specific session module through a supported evolution procedure.

The source kitchen directory supplied below must contain the real private
`handle.json`, `descriptor.json` and `bridge-device.sqlite`. Its page ID and
application ID are read from those records. No example identifier is accepted
as proof of an existing page or an enrolled device.

## 3. Prepare private configuration

Copy [settings.example.json](settings.example.json) outside the source checkout,
make it private (`chmod 600`), and set the absolute installation/source paths,
actual HTTPS MCP resource, real Tendriller host origin, bridge ID and client ID.
The listener is fixed to loopback port 8788 by this packaging route. Caddy owns
the public HTTPS origin, including `/mcp` and `/connections`.

Copy the **actual callback URI shown by the intended ChatGPT client** into
`oauthClient.redirectUris`. The example intentionally contains an empty list;
the generator refuses it, wildcard URIs and obvious placeholders. Select exact
scopes and the authentication method used by that client. Both supported methods
use authorization code with S256 PKCE and an optional finite refresh grant:

- `oauthClient.tokenEndpointAuthMethod: "none"` (default) registers a public
  client without a client secret.
- `"client_secret_basic"` generates a distinct random client secret for secure
  registration with a confidential client. To preserve an already registered
  secret, set `oauthClient.clientSecretFile` to its absolute private file path.
  The supplied secret must contain 32–512 characters without control characters;
  a single trailing file newline is removed, and other characters are preserved.

The generator refuses a secret file when the method is `none`. It does not
provide dynamic client registration or guess a callback URL. Basic clients use
HTTP Basic at the token endpoint, with OAuth form encoding of the client ID and
secret; request-body `client_secret` is not supported by this host.

```sh
node integrations/chatgpt/deploy/prepare.mjs \
  --settings /absolute/private/assistant-settings.json \
  --output /absolute/private/new-assistant-setup
```

The new output directory contains:

| File | Purpose |
| --- | --- |
| `private/service.env` | Retained delivery encryption key, management CSRF key, bridge credential and exact paths/origins |
| `private/integration.config.mjs` | Imports the release's real `config.host-account.example.mjs` |
| `private/host-oauth-config.json` | Exact client redirects/scopes and bridge hash/application/callback allowlists |
| `private/host-signing-jwk.json` | A new RSA 3072-bit signing key with unique `kid`; install only in the host's secret store |
| `private/bridge-secret.txt` | The bridge credential, for private administration only |
| `private/oauth-client-secret.txt` | Present only for `client_secret_basic`; supply only to the intended registered ChatGPT client |
| `systemd/*.service` | Distinct non-root coordinator and assistant services |
| `Caddyfile` | HTTPS reverse proxy to loopback 8788 |
| `HANDOFF.md`, `deployment.json`, `READY.json` | Concrete review/install instructions and preparation status, with no secret values |

Files start mode 0600 and directories mode 0700. The generator refuses an
existing output directory and never rotates keys on retry. The raw OAuth client
secret is separate from the bridge credential: only its SHA-256 digest enters
host configuration, and it never enters the Node environment, returned status or
public handoff text. Install that raw secret only in the actual client setup.
Preserve the delivery
encryption key with the database. For an existing host OAuth configuration,
merge other reviewed clients/bridges deliberately; the generated single-app
configuration is not an instruction to replace unrelated registrations.

## 4. Configure the selected host environment

Use [the host OAuth deployment guide](../../../docs/INTEGRATION_OAUTH.md) and the
existing reviewed host deployment workflow. A fresh accounts database requires
`0001_accounts.sql` followed by `0002_integration_oauth.sql`; an existing current
accounts database receives the additive integration migration. Do not discard
accounts or page storage to enable this route.

Install `OAUTH_CONFIG_JSON` and `OAUTH_SIGNING_JWK` through the selected Worker's
secret manager. The issuer is the host's exact HTTPS `PUBLIC_BASE`. Keep the
signing private key out of the Node bridge and public assets. Retired verification
keys, if needed, go in `OAUTH_PUBLIC_JWKS` as public JWKs only. The generated bridge
entry binds one exact application ID and the exact Node management callback
`https://YOUR_ASSISTANT_ORIGIN/connections/callback`.

The account adapter uses the actual host login, page access and account status.
OAuth scopes, connection consent and native device grants remain separate.
Do not replace a missing prerequisite with a permissive callback.

## 5. Install the retained processes

Use the configured target paths and usernames from `deployment.json`; the
following commands show the example defaults. Install Node 24 and Caddy through
the target machine's supported package process first. Create two system users
without interactive login, `tendriller-chatgpt` and `tendriller-kitchen`.

Install `release/` under the configured immutable release directory, owned by
root and readable by the service accounts. Preserve every file and verify
`RELEASE.json` after transfer. Public code needs read/traverse permission; it
contains no private application state.

Create `/var/lib/tendriller-chatgpt` owned by root with group
`tendriller-chatgpt` and mode 0750. Create its `delivery/` subdirectory owned by
`tendriller-chatgpt`, mode 0700. The database lives at
`delivery/delivery.sqlite`. Keep the coordinator project at the separately
owned `/var/lib/tendriller-kitchen/project`, mode 0700.

Stop the source bridge before copying its identity. If relocating the creator,
stop its process and transfer its complete retained project coherently too;
exclude `bridge-device.sqlite` and its sidecars from the creator copy. Never run
the old and new copy of the same device concurrently. If an existing coordinator
already has reliable supervision, retain it and omit the extra coordinator unit.

Stage the dedicated bridge into a **new** destination, supplying the public key
that was actually verified and enrolled:

```sh
chmod 600 /absolute/private/configured-kitchen/.tendriller/bridge-device.sqlite
node /ABSOLUTE/RELEASE/integrations/chatgpt/deploy/stage-bridge.mjs \
  --source /absolute/private/configured-kitchen \
  --release /ABSOLUTE/RELEASE \
  --destination /var/lib/tendriller-chatgpt/kitchen \
  --expected-bridge-key VERIFIED_64_HEX_PUBLIC_KEY \
  --source-stopped
```

Staging verifies release hashes, copies only the minimal public runtime plus the
handle and pinned descriptor, takes a coherent SQLite backup of
`bridge-device.sqlite`, and checks its identity using the public native API.
It never copies the creator `device.sqlite`, bootstrap epoch key or enrollment
journals. The stopped-source flag is a deliberate operator assertion; the tool
cannot prove that another machine has stopped using a copied identity.

Keep the staged public modules, package files and `STAGED.json` root-owned,
readable by group `tendriller-chatgpt`, with no group write permission. Give that
service ownership of `kitchen/.tendriller/` only, mode 0700, and its files mode
0600. The generated systemd unit permits writes only to that directory and
`delivery/`, and blocks access to the creator project.

Install `service.env` and `integration.config.mjs` under `/etc/tendriller-chatgpt`
with root ownership, group `tendriller-chatgpt`, directory mode 0750 and files
mode 0640. Install the two unit files under `/etc/systemd/system/`, mode 0644.
Keep the other generated secret files in the operator's private secret storage.

On the actual target machine, validate before starting:

```sh
systemd-analyze verify /etc/systemd/system/tendriller-chatgpt.service /etc/systemd/system/tendriller-kitchen.service
caddy validate --config /absolute/private/new-assistant-setup/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now tendriller-kitchen.service
```

Install the reviewed Caddy site configuration using that machine's normal Caddy
service setup. Its hostname must resolve to the machine, and certificate
issuance needs the required public reachability. Preserve the original Host and
Authorization headers; the supplied proxy does not rewrite paths. Caddy's
[automatic HTTPS](https://caddyserver.com/docs/automatic-https) and
[reverse-proxy defaults](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults)
describe those boundaries. The systemd
[execution settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
document the user and filesystem restrictions.

## 6. Run preflight, then link the human account

Run preflight as the assistant service user. `--env` reads the generated data
format without executing shell text. The assistant service must be stopped
for `--online`, because preflight briefly owns its native device store.

```sh
sudo -u tendriller-chatgpt /usr/bin/node /ABSOLUTE/RELEASE/integrations/chatgpt/deploy/preflight.mjs \
  --config /etc/tendriller-chatgpt/integration.config.mjs \
  --env /etc/tendriller-chatgpt/service.env

sudo -u tendriller-chatgpt /usr/bin/node /ABSOLUTE/RELEASE/integrations/chatgpt/deploy/preflight.mjs \
  --config /etc/tendriller-chatgpt/integration.config.mjs \
  --env /etc/tendriller-chatgpt/service.env --online

sudo systemctl enable --now tendriller-chatgpt.service
```

Local checks verify Linux/Node/non-root execution, exact release and staged
runtime hashes, private writable stores, handle/descriptor scope, loopback
configuration and explicit allowlists. Online checks additionally validate the
actual authenticated host bridge configuration and its signing readiness,
read a real native selected revision, and require the correct reader/writer
grant with no coordinator/recovery/administrator/publisher rights. Preflight
has a one-minute CLI deadline and closes its integration. It never calls
`start()`, grants consent, subscribes, sends a callback or submits a command.

Open the real `/connections` page, sign in as the owner, select the exact
application/query/command/event consent, and link the MCP resource in the target
ChatGPT client. These human steps remain necessary after a successful preflight.
`GET /health` is process liveness; preflight is configuration/native readiness;
neither means a ChatGPT conversation has run.

## Acceptance and operation

For live acceptance, record the actual client callback and account link, owner
consent, bridge grant, signed subscription challenge, native kitchen request,
accepted event receipt, assistant turn, signed reply operation and page query.
Check reload and exact retry, revocation during queued work, recovery removing a
source, an unavailable coordinator, and a stale cooking step. Qualify the widget
with an explicit click in the actual host. If configuring Workspace Agent, also
record its real published channel and subsequent MCP write-back; provider
completion alone is insufficient. Use the manual request handoff when that
surface cannot receive background events.

Supervise both required processes and retain their original stores. Stop the
assistant before an online preflight, native CLI operation or coherent backup
against its device. Back up its native directory, delivery SQLite/WAL state and
matching encryption key together. Back up the creator separately. An unreadable
delivery journal needs its matching key restored, not a new key or silent reset.
Capacity errors require review/archival of retained receipts; deleting uncertain
records loses idempotency evidence. An upgrade replaces public code deliberately
while preserving compatible private state and keys. Do not rerun preparation as
an upgrade or republish a changed immutable definition into an existing app.

The local tests exercise private configuration generation, input rejection,
release/staged-byte checks, injected online readiness and cancellation, and a
real native bridge identity backup that excludes creator/bootstrap secrets.
They do not start systemd or Caddy, issue a public certificate, use a live OAuth
provider, or run a ChatGPT/Workspace conversation. Validate those on the target
machine and retain a separate live acceptance record.
