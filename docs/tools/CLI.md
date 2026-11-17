# Use the owned application session from a terminal

`tendril` has one application path: the public Chronolog session opened by the
application's own bootstrap module. Host lifecycle commands use the host's
metadata API. Application commands, queries, events, live signals, recovery and
page-code publication use the session and its explicit control participant.

## Supply the application composition

`--session /absolute/application.mjs` names a module exporting
`openSession({ signal })`. It returns `{ session, control? }`. The optional
control value is the result of `session.connectControlParticipant({ exchange })`.
The tool closes the session after the action and when the invocation is
interrupted. The session owns its signer store, transports, keyring and operation
journal. A single invocation never silently creates a missing identity.

A deployment module can provide verified cached authority, the domain
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
provisioning, before normal command invocations.

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
with restricted file permissions. Choose that handle with `--tendril NAME`, or
supply `TENDRIL_API` and `TENDRIL_TOKEN`. `info`, `service`, `meta <json>`,
`release`, `activity`, `link` and `token` operate on host metadata and access.
`remove --yes` deletes hosted state. These routes do not carry domain commands.

The default invocation timeout is 30 seconds. `watch` continues until interrupted
unless `--timeout SECONDS` supplies a bound. `--pretty` formats the JSON result.
