# Use the owned application session from a terminal

`tendril` has one application path: the public Chronolog session opened by the
application's own bootstrap module. Host lifecycle commands use the host's
metadata API. Application commands, queries, events, live signals, recovery and
page-code publication use the session and its explicit control participant.

## Start with only a domain

Install the tools archive using the artifact instructions in
[Build an app](https://tendriller.dev/docs/BUILD_AN_APP.md), then inspect the
workflow and the host before creating anything:

```sh
tendril guide --server https://tendriller.dev --pretty
tendril service --server https://tendriller.dev --pretty
```

`guide` prints structured steps, prerequisites, authorization checkpoints and
links for that service origin. It is offline: it creates no page, reads no
private handle, and does not claim the host is reachable. `service --server`
reads `/api/service` without credentials, even if page credentials are present
in the environment. Use the actual staging or self-hosted origin throughout.

`service --tendril NAME` still reads the selected page's effective limits.
Without either flag, a configured page is used if available; otherwise the
public descriptor comes from `TENDRIL_SERVER` or `https://tendriller.dev`.

Follow the [complete application workflow](https://tendriller.dev/docs/BUILD_AN_APP.md)
for initial authority, device enrollment, UI composition and publication. A
successful `new` command gives you a hosted page and independent application
identity. It does not configure application authority or open a Chronolog
session. The human owner must open the returned `page_url` and sign in to claim
the page. Keep its private handle and tokens out of the authored page files.

Initial configuration also needs a selected first generation. Save its signed
transition request before sending it, then verify the selected authority before
opening the session. `configureApplication` alone does not satisfy this step;
the tutorial's initialization command performs both stages.

## Supply the application composition

`--session /absolute/application.mjs` names a module exporting
`openSession({ signal })`. It returns `{ session, control? }`. The optional
control value is the result of `session.connectControlParticipant({ exchange })`.
The tool closes the session after the action and when the invocation is
interrupted. The session owns its signer store, transports, keyring and operation
journal. A single invocation never silently creates a missing identity.

The following is a **composition outline**, not a runnable first-app starter.
Its `deployment.mjs` import represents the setup outputs described in
[Build an app](https://tendriller.dev/docs/BUILD_AN_APP.md). Complete that setup
before using the commands below. A deployment module provides verified cached authority, the domain
definition, authorized keys, a host participant exchange and the configured peer
connection composition:

```js
import { openNativeDevice, openNativeApplication } from '@chronolog/peer-session/native';
import { authority, definition, epochKeys, exchange, connectPeers } from './deployment.mjs';

export async function openSession({ signal }) {
  const device = await openNativeDevice({ path: './device.sqlite' });
  const session = await openNativeApplication({ device, authority, definition, epochKeys });
  try {
    const control = session.connectControlParticipant({ exchange });
    await connectPeers(session, { signal });
    return { session, control };
  } catch (error) {
    await session.close();
    throw error;
  }
}
```

`deployment.mjs` is application setup, including enrollment and real routes; it
is not supplied by these tools. Use the same definition and execution artifacts
as the browser. Explicit device creation uses the native public API during
provisioning, before normal command invocations. Reopen that same device during
normal work; do not use `create: true` as a recovery strategy when a store or
identity is missing. Browser execution belongs in its owned Worker.

Before publishing, ensure that `openSession` returns its actual `control`
participant and that the device has an explicit `publisher: true` grant.
Page access, an agent bearer token and control administration do not by
themselves confer publication or application data rights. See
[troubleshooting](https://tendriller.dev/docs/TROUBLESHOOTING.md) for the next
step when authority, device storage, participation or publication is blocked.

## Inspect and submit domain work

```sh
tendril --session ./application.mjs describe
tendril --session ./application.mjs query board '{}'
tendril --session ./application.mjs command claimTask '{"taskId":"review"}' \
  --operation claim-review-1 --based-on '<captured revision JSON>'
tendril --session ./application.mjs operation claim-review-1
tendril --session ./application.mjs retry claim-review-1
```

Operation IDs are required and remain stable across exact retries. Commands wait
for applied execution by default. `--saved` returns after the exact attempt is
saved; `--shared` additionally waits for retained coverage. A timeout leaves the
original attempt available. Inspect it or retry that same identity. Applied and
shared observations can later be abandoned by an explicit recovery selection.

A reviewed reapplication names the old operation, a new identity, current input
and the current captured revision:

```sh
tendril --session ./application.mjs reapply claim-review-1 claimTask \
  '{"taskId":"review"}' --operation claim-review-2 \
  --based-on '<reviewed current revision JSON>'
```

The tool performs no automatic reapplication and dispatches no external effects.
An irreversible action requires a separately declared capability with its own
durable authority and reconciliation boundary.

## Events, signals and recovery

`events` captures a coherent applied view and releases it after reading. Its
opaque cursor belongs to that history. The caller commits derived state and its
processed cursor together; reading a batch does not acknowledge external work.
`watch` streams actual session changes, including explicit recovery notices,
with stdout backpressure. It creates no checkpoint file or polling loop.

```sh
tendril --session ./application.mjs events --topics '["message"]' --limit 100
tendril --session ./application.mjs watch
tendril --session ./application.mjs signal progress '{"complete":3}' --ttl 2000
tendril --session ./application.mjs recovery inspect
tendril --session ./application.mjs recovery takeover --transition recover-on-device-b
```

A handover uses `recovery handover <successor-device> --transition <id>` and
requires the successor's verified retained prefix. The session persists exact
signed transition requests. A lost control response retries its original base
and identity, without a tool-owned delivery queue. Live signals are disposable
and do not append application history.

## Publish signed page code

```sh
tendril --session ./application.mjs definition
tendril --session ./application.mjs publication
tendril --session ./application.mjs publish ./page --operation release-2026-11-17
```

The complete authored graph is hashed and passed to the session's
`preparePublication`. `publish` sends that saved signature and content addressed
bytes through the control participant. Reusing the same operation recovers the
same signed intent. A changed graph under that identity is refused. There is no
unsigned publication route, merge overlay or rollback alias. Deliberately
publishing earlier content is a new reviewed signed publication.

## Host lifecycle commands

`new [name] --owner VERIFIED_EMAIL` creates a page and saves its private handle
with restricted file permissions, including its stable `application.id`.
Choose that handle with `--tendril NAME`, or
supply `TENDRIL_API` and `TENDRIL_TOKEN`. `info`, `service`, `meta <json>`,
`release`, `activity`, `link` and `token` operate on host metadata and access.
`remove --yes` deletes hosted state. These routes do not carry domain commands.

Handles saved by older CLI builds may lack `application`. Retrieve the selected
page's `application.id` with `info`; use that identity when composing the host
client. Do not create a different application identity to fill the missing
local field.

The default invocation timeout is 30 seconds. `watch` continues until interrupted
unless `--timeout SECONDS` supplies a bound. `--pretty` formats the JSON result.
