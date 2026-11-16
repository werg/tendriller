# Public peer connections and bootstrap

`@tendriller/core/peers` exposes a transport-only boundary for browser and native
peers. It carries opaque bounded frames and measures the selected route. It does
not interpret SQL, provide database membership, assign order, retain records, or
issue finality evidence. Chronolog adapters use only this public export.

For the resident agent topology, prefer a publicly reachable direct WSS endpoint
when the deployment supports one. Tendriller's paired WSS relay is a correctness
baseline for browsers behind NAT. Every byte through that relay still crosses
Cloudflare; a relay connection is not a bandwidth saving claim. WebRTC, native
Iroh, and other paths can implement the same small connection contract after
separate qualification. No DHT or mesh is required.

## Connection contract

```js
import { connectPeer } from '@tendriller/core/peers';
const peer = connectPeer({ route: 'direct', url: 'wss://resident.example/peer' });
await peer.ready;
await peer.send({ domain: 'records', payload: signedProtocolBytes });
for await (const frame of peer.frames) {
  // The database adapter validates identity, grant, protocol domain, and contents.
  await databaseTransport.receive(frame);
}
```

`createPeerConnection(socket, {route,relayHandshake?,queueBytes?})` adapts a
WebSocket-like event target. `PeerConnection` has `route`, `ready`, `frames`,
`send(frame,{signal?})`, `close()`, and a read-only `stats` snapshot. There is one
active frame reader. Sends preserve their call order, are bounded before waiting,
and abort even before relay readiness. `close()` is idempotent, including after
the remote transport closes; pending sends are rejected when the session ends.
A closed or overflowing session is an
explicit error; durable sync restarts from the replica's verified stored progress.

`stats.sentBytes` and `receivedBytes` count encoded application frames, including
the three-byte Tendriller envelope. `queuedBytes` counts local queued send and
receive frames. `openedAt` marks peer readiness. These counters exclude WebSocket,
TLS, TCP, relay ready/credit controls, and provider billing overhead. The reported
`route` is the explicitly chosen path, not an inference from endpoint names or a
claim of measured direct-connect success.

## Distinct domains and bounds

The wire envelope is three bytes followed by the opaque payload: magic `0x54`,
version `1`, and domain index `0` records / `1` signals / `2` control. Payloads must
be nonempty. Unknown versions/domains, text application frames, oversized frames,
and queue overflow fail closed.

| Resource | Bound |
| --- | --- |
| Record or control payload | 256 KiB |
| Ephemeral signal payload | 16 KiB |
| Local send queue or receive queue | 4 MiB maximum |
| Relay receiver outstanding bytes | 4 MiB |
| Pending authorization per sender | 128 messages / 4 MiB |
| Text relay credit control | 128 bytes |
| Relay forwarded bytes per endpoint per second | 4 MiB |
| Concurrent relay sessions per page | 16 pairs |
| Bootstrap endpoints | 8 |

The database framing adapter must chunk bounded range replies to fit these frame
limits. A signal's database protocol supplies its signed session ID, sequence,
expiry, and active membership checks. Tendriller's domain tag alone does not make
an unsigned packet authenticated. Signals have no durable cursor or finality and
are never inserted into the record log or application history.

## Paired host relay

```js
// Authenticated browser page:
const pagePeer = tendril.peers.connect(channelId, browserPeerId);

// Native host, with a private ordinary Tendriller agent token:
const client = createClient({ api, token });
const agentPeer = client.peers.connect(channelId, agentPeerId, {
  socket: (url, protocols) => new WebSocket(url, protocols),
});
```

A channel pairs exactly two distinct endpoint IDs within one page. Each ID is
1–160 characters from letters, numbers, underscore, dot, colon, and hyphen. The
host checks authenticated page/agent access and the page's session/origin policy.
Agent tokens travel only in the WebSocket subprotocol header, never in URLs or
bootstrap hints. Peers must independently authenticate the database handshake;
knowledge of a channel does not confer a group capability. Use an unpredictable
session channel to avoid accidental collisions with other authorized host users.

The route is `peers/socket?channel=<id>&peerId=<id>`, under the agent API or page
`_tendril/` prefix, with subprotocol `tendriller.peer.v1`. The public helper waits
for both endpoints before resolving `ready`. The relay checks current local
credentials and current account access before forwarding; revoked recipients
are not sent later frames. A disconnected peer closes its partner and frees the
session. A durable pair identity isolates later reuse of the same channel from
old traffic and delayed close callbacks. The relay processes each sender's frames
in order across asynchronous authorization. Pending authorization is bounded to
128 messages and 4 MiB per socket; overflow closes the connection so peers can
resume from durable progress. There is no disconnected recipient mailbox.

Receiver credits bound bytes in flight. The initial window is 4 MiB. Consuming a
frame returns only its encoded byte count as a small relay control message.
Credits acknowledge receive-buffer consumption, not durable application
processing. Invalid or inflated credit closes the session. A slow reader leaves
its partner waiting within the bound, or an oversized/backpressure violation
closes the connection. A durable consumer checkpoint remains entirely separate.

The existing `events/socket` remains a count-only wake connection for the
Cloudflare application deployment. It carries no peer record payloads and has no
peer handshake. The new relay is a separate connection and authorization path.

## Bootstrap hints

`client.peers.setBootstrap({version:1,endpoints:[{url,route}]})` stores bounded
host hints. `client.peers.bootstrap()` and `tendril.peers.bootstrap()` read them.
Only an owner or agent can replace hints; authorized nondisplay page identities
can read them. WSS is required, except loopback WS for local development. Embedded
URL credentials and fragments are rejected. Never place application grants,
private keys, agent tokens, or decryption keys in a hint URL or query.

Hints guide connection attempts. A caller explicitly chooses direct or relay;
the helper does not probe unrelated endpoints, switch authority, or fall back to
a different database policy. The application's enrollment flow independently
maps the authenticated transport endpoint to permitted database roles.

## Operational qualification

Tests exercise the actual Worker relay with a page session and private agent
credential, binary records/signals, quotas, revocation, disconnects, and zero
retained application records. Direct public-agent endpoints, browser/native
WebRTC with ICE/TURN, and Iroh browser/native paths require their own real-network
measurements. Report route, reconnect count, catch-up bytes, and latency for the
path actually used. No browser direct-connect rate or cost saving is asserted by
the relay tests.
