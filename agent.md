# Give your agent a page

Tendriller hosts the page and joins its Chronolog protocol as a light control participant. Open one Chronolog application session for application work. The host receives only the control, publication and introduction updates allowed by its transport policy.

## Create and claim the page

Read `/api/service` to check the host contract and limits. Create a page with `POST /api/tendrils` and an owner email:

```json
{"owner":"owner@example.com","name":"Shared work"}
```

The result includes `page_url`, the agent `api` and token, and `application:{id}`. The generated application ID is a stable 32-byte lowercase hex identity, independent of the page ID. Supply `application:{id}` explicitly when binding a known application. There is no backend or profile selector.

Give `page_url` to the human owner. They open it and sign in to claim the page. Agent credentials cannot claim a page for them. An unclaimed page expires after 24 hours. After claim, explicit host lifecycle operations may make it resident; residency retains control and code without a continuously running application process.

## Configure authority and open the application

Use the public SDK's `createClient(handle, {applicationId: handle.application.id})`. The host SDK has `peers`, `request`, `info` and `service`. Its construction starts no traffic.

Configure the initial descriptor through `host.peers.configureApplication`. Provide the immutable public application definition, execution-manifest digest, schema administrator, initial epoch/key digest, and enrolled device grants. SQL applications also provide their signed schema. The host validates the definition/schema bindings and retains the signed authority. Application identity exists before configuration; reading unconfigured authority reports that state explicitly.

Chronolog owns the device signer, local byte store, database, operation journal, peer connections and replication. Use its native or browser Worker session entry for your environment. Bootstrap from the host's public definition and authority, pin the descriptor, and verify all signed evidence through Chronolog. Keep browser execution and replication in the owned Worker.

Connect the host to the session through the common participant transport:

```js
const control = session.connectControlParticipant({
  exchange: (message, options) => host.peers.exchange(message, options),
});
```

Install the session's one participation controller with the host introduction adapter:

```js
import { createPeerIntroductions } from '@tendriller/core/peers';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
const participation = await session.participate({
  control,
  ...createPeerIntroductions({
    peers: host.peers,
    identity: session.deviceId,
    openDirectConnection, // The native or owned Worker raw RTC opener.
    openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
  }),
});
```

The session owns discovery, connection retries, authentication, reconnect grace, candidate policy and recovery. Each host-adapter attempt tries direct RTC, then the opaque WebSocket relay after direct failure or its five-second budget. Both use the same authenticated encrypted peer channels and application session. Use the controller's status to show connection progress and any exact recovery proposal requiring approval. Do not add application-level election or retry loops. See [peer participation](docs/PEER_CONNECTIONS.md) for the environment openers and lifecycle.

Ordinary commands, queries, signals and replication require no host control call. Direct traffic bypasses the host; relay traffic consumes host bandwidth and requires the relay to remain available. Coarse availability-lease renewal is separate lifecycle traffic, independent of application edits.

## Compose the browser runtime

The default entry supplies `window.tendril`. Install the one matching application backend and the session's live signals:

```js
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';

const backend = createApplicationBackend({
  id: session.applicationId,
  session,
  eventCommand: 'publishEvent', // An ordinary declared domain command, if provided.
});
tendril.application.install(backend);
tendril.signals.install(session.signals);
```

`ready()` and `available` on the application binding describe installation. Use `session.status` and its subscriptions for actual connection, generation and recovery state. The session's `deviceId` is the signing identity; the page runtime creates no additional device credential.

A separately composed page may call `startRuntime(configuration, {application: backend, signals: session.signals})` from `@tendriller/runtime/kernel`. That kernel mounts no UI and starts no transport. Both compositions use the same application contract.

## Commands, live signals and recovery

Use the least durable mechanism that fits the task:

| Need | Mechanism |
| --- | --- |
| Local drafts, focus, scroll | Page-local state |
| Live presence, previews, progress | `session.signals` or the installed signal binding |
| A retained change and emitted facts | A declared application command |
| A coherent query/event read | A captured applied read view, released after use |
| Operation progress | Original operation identity and operation-state inspection |
| Recovery after unavailable data | Explicit selected-generation recovery and loss reporting |
| External side effects | A declared policy, protected prerequisites where needed, and provider reconciliation |

Preserve the caller's operation ID and exact signed attempt on uncertain replies. `saved` means locally durable work; `applied` identifies an outcome in a selected generation. `shared` reports retained coverage separately. Recovery can abandon a recent suffix. Show `abandoned` and `needsReapply` explicitly; reapplication uses a fresh reviewed attempt with current guards. Never silently merge an abandoned branch or reinterpret a read view as finality.

## Publish code through Chronolog

Prepare a complete manifest with canonical sorted file paths, content hashes, sizes and media types. The entry is an authored HTML file. The session's control participant saves the signed intent before returning it:

```js
const signed = await control.preparePublication({
  operationId: 'release-2026-11-17-a',
  entry: 'index.html',
  files,
});
const receipt = await control.publish(signed, assets);
```

Each asset is `{hash, bytes}`, with canonical base64 bytes. The signed manifest binds application/history identity, current control revision, author, operation identity, previous release and immutable definition/engine commitments. Publishing requires an explicit current `publisher: true` device grant and authorized host account. Control administration does not imply publication rights, and a publisher can be granted no application data access. The host checks every supplied byte before storage effects and selects the release atomically. An exact retry returns its original receipt; a stale predecessor conflicts.

`control.publication()` verifies and remembers the selected release chain. Historical code remains available at its immutable publication URL. Restoring old code requires a new signed publication; diagnostics and the management page cannot silently switch the selected code. Application recovery and code publication have separate histories.

## Help people keep a useful page

After the page has helped with the task, naturally suggest **Page options → Add to Home Screen** for repeat use on a phone. The default runtime provides native installation when the browser supports it, iPhone/iPad Share instructions, and a quiet mobile suggestion with a remembered **Not now** choice. Keep setup optional. Do not force installation, open prompts on load, or add a competing automatic nudge. For authored controls, use [`tendril.installation`](docs/BROWSER_API.md#home-screen-setup) and invoke `prompt()` directly from a click.

Give the page a recognizable `name`, short Home Screen label and appropriate icon using the existing agent API: `PATCH` the returned agent `api` URL with `name`, `short_name`, `icon` (an HTTPS URL), and optionally `theme_color` and `background_color`. The host supplies default install metadata; authored manifest and icon tags can provide more specific branding. The Home Screen launch targets the stable page URL and selected publication, while an already open page remains pinned to its publication.

Offer **Save for offline use** when retaining this version's code is useful. Explain separately what the application can do with disconnected data or peers. Installing the Home Screen app does not save its code or transfer a device signer; iOS may require sign-in and the session's normal device connection/recovery again. See [browser setup and storage details](docs/BROWSER_API.md#home-screen-setup).

## Verify the result

Check the actual application behavior in the intended browser/native environment. Exercise lost replies, offline local work, explicit recovery, revoked access, stale publication heads and the page's stop/cancel controls where relevant. Confirm ordinary application traffic leaves the host idle. Report the exact artifacts and limits of the checks performed.

Use the [CLI](docs/tools/CLI.md), [preview](docs/tools/PREVIEW.md) and [cookbooks](https://github.com/werg/tendriller-contrib) as public consumers. Preview needs an explicit bootstrap for session-backed behavior. Publishing files or reading a guide cannot install server application code.
