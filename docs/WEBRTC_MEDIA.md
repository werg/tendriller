# WebRTC video, audio, custom streams & agent call following

Tendriller applications share one authenticated Chronolog WebRTC connection per peer (up to 16 peers per page). Beyond durable CRDT replication and ephemeral signals, every direct WebRTC link supports mid-session **RTP audio/video tracks** and custom **`app:*` binary/text DataChannels**, negotiated in-band over Chronolog's encrypted `ApplicationSecureChannel` via W3C Perfect Negotiation.

Start with [Build an app](BUILD_AN_APP.md), [Peer connections](PEER_CONNECTIONS.md), and [Session bootstrap](SESSION_BOOTSTRAP.md).

## How WebRTC integrates with Tendriller's model

| Layer | Owned by | What travels here | Offline / relay behavior |
| --- | --- | --- | --- |
| **Identity & admission** | Chronolog membership + epoch keys (`@tendriller/core/admission`) | Peer authentication (`peer.peerId` is the verified Chronolog signing public key); no separate call token or signaling auth | Revoking a device rotates the epoch key and closes its peer link |
| **Durable state** | `session.command` / `session.query` (authored-time CRDT) | Saved meeting notes, opt-in saved transcript utterances, room settings | Full local read/write offline; syncs over direct WebRTC or relay |
| **Ephemeral signals** | `session.signals` (signed, TTL-bounded) | Live captions (`call/utterance`), participant presence, waiting-room knocks, consent prompts | Works over both direct WebRTC (stream 1) and encrypted host relay |
| **Live media & binary streams** | `attachment.onPeer` (browser) / `session.onPeerLink` (native) | Mid-session RTP tracks (`addTrack`/`onTrack`) and custom `app:*` DataChannels (`openDataChannel`/`onDataChannel`), negotiated in-band (`kind: 'rtc'`) | Direct WebRTC only; honestly reports `mediaAvailable: false` on relay (never silently routed through host) |

## Lifecycle & transport boundaries

1. **Trickle ICE rendezvous (`tendriller.rendezvous.v2`)**: The host pairs two authorized participants with bounded SDP descriptions and trickled ICE candidates, then closes the signaling socket as soon as both sides report `connected`.
2. **In-band renegotiation (`kind: 'rtc'`)**: Adding/removing tracks, opening custom `app:*` DataChannels, or ICE restarts run peer-to-peer inside the encrypted Chronolog channel—zero extra host round-trips, with glare rollback and debounced ICE restart handled by Chronolog.
3. **Single-active-tab browser owner**: `openBrowserOwner` acquires an exclusive Web Lock per profile so the active tab owns `RTCPeerConnection` and local `MediaStreamTrack`s directly while a private 1:1 dedicated Worker owns device keys, storage, and Chronolog execution. By default (`takeover: 'auto'`), opening the page in a foreground tab or standalone PWA seamlessly transfers the lock and notifies the previous tab via `onOwnerReplaced`. Call pages can pass `takeover: false` to fail a second tab with `code: 'TAB_ACTIVE_ELSEWHERE'` until the user clicks **Use here** (`takeover: true`).
4. **Honest relay degradation & hybrid Cloudflare Realtime SFU/TURN**: When UDP/NAT blocks direct WebRTC, Chronolog falls back to the encrypted WebSocket relay automatically. Durable CRDT sync, chat, and on-device per-person transcripts keep working. On Pro, Team, or self-hosted deployments with Cloudflare Realtime credentials configured, `createHybridMediaTransport` (`shared/media/sfu-transport.mjs`) queries `_tendril/peers/ice` for short-lived TURN credentials and automatically promotes rooms from P2P mesh to Cloudflare Realtime SFU (`_tendril/peers/sfu/*`) when strict NAT blocks direct media or video participants exceed 4, degrading cleanly back to audio-only/P2P if a monthly media budget is exhausted.

## Quickstart: Video conferencing page with an AI agent

Scaffold the maintained `call` template in an agent workspace:

```sh
npm run page:new -- standup --template call --name "Team Standup"
npm run init -- standup
npm run deploy -- standup
npm run agent
```

### Browser page (`page.mjs`)

Mount `mountCallRoom` from `shared/ui/call-room.mjs` (which wraps `createMediaRoom` from `shared/media/call-room.mjs`) and handle `TAB_ACTIVE_ELSEWHERE` with `renderTabTakeoverBanner`:

```js
import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { createApplicationBackend } from '@chronolog/peer-session';
import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { mountCallRoom, renderTabTakeoverBanner } from '../../shared/ui/call-room.mjs';

let attachment, callUi;

async function connect(takeover = false) {
  try {
    attachment = await openBrowserOwner({
      workerUrl: new URL('./worker.mjs', import.meta.url),
      profileId: browserProfileId(configuration.applicationId),
      applicationId: configuration.applicationId,
      takeover,
      onOwnerReplaced() {
        void callUi?.dispose();
        renderTabTakeoverBanner(root, {
          message: 'This call moved to another tab.',
          onTakeover: () => connect(true),
        });
      },
    });
    const session = attachment.session;
    window.tendril.application.install(createApplicationBackend(session));
    window.tendril.signals.install(session.signals);
    window.tendril.transport.install(session);

    callUi = await mountCallRoom({
      runtime: window.tendril,
      session,
      attachment,
      peers: window.tendril.host.peers,
      container: root,
      title: 'Team Standup',
      transcription: 'model',   // continuous on-device speech-to-text ('model' | 'off')
      persistTranscript: false, // opt-in durable transcript saving in Chronolog
      agentAudio: 'ask',        // 'never' | 'ask' (explicit consent) | 'auto'
    });
    window.tendril.ready();
  } catch (error) {
    if (error?.code === 'TAB_ACTIVE_ELSEWHERE') {
      renderTabTakeoverBanner(root, {
        message: 'This call page is already open in another tab.',
        onTakeover: () => connect(true),
      });
      return;
    }
    throw error;
  }
}
```

What `mountCallRoom` + `createMediaRoom` provide out of the box:

- **Hair-check lobby** with local camera preview before joining; camera/mic acquisition always requires a trusted user gesture.
- **Responsive desktop & 320px video grid**, mute/unmute, camera toggle, screen share, and active-speaker rings.
- **Continuous on-device per-person captions** via `createStreamTranscriber` (`@tendriller/runtime/voice`): each participant transcribes their own microphone locally (never pausing the AudioWorklet during inference) and publishes signed `call/utterance` signals attributed to their exact Chronolog signing key—so speaker attribution works even across relay links and without sending raw audio to any third party.
- **Opt-in durable transcripts & notes**: toggling **Save transcript** commits utterances via `call-domain.mjs` (`commitUtterance`, `upsertNote`), displaying a persistent **Saving transcript** pill.
- **Persistent agent disclosure & audio consent**: the header always shows whether each present agent is in **Transcript only** mode or **Listening to audio** (requiring explicit human approval when `agentAudio: 'ask'`).
- **Live hot-swappable stage & URL-addressable facets (`stage: true`)**: while joined, `mountCallRoom` automatically holds full-page reloads (`tendril.publication.hold()`) and mounts `facets.json` (`facets/stage.mjs`, `facets/notes.mjs`) via `tendril.publication.mountFacets(...)`. When an agent edits only `facets/*.mjs` or `facets.json` and runs `deploy`, the runtime diffs the new atomic publication manifest and hot-swaps the stage live inside its Shadow DOM—keeping WebRTC media, canvases, and audio completely uninterrupted. Anyone opening `?view=notes` or `?view=stage` sees that exact view over the same Chronolog state.

### Native agent following the call (`agent.mjs`)

Use `createCallAgent` from `shared/media/call-agent.mjs` in your native agent participant:

```js
import { createCallAgent } from '../../shared/media/call-agent.mjs';

// Default: follow per-person transcripts (zero audio bandwidth, works on relay too)
const agent = createCallAgent({
  session,
  callId: 'main',
  handle: 'notetaker',
  mode: 'transcript', // default: 'transcript' | 'audio' | 'av'
  onUtterance(utterance) {
    console.log(`[${utterance.displayName}] ${utterance.text}`);
  },
  onParticipant(peer) {
    console.log(`Participant ${peer.displayName}: joined=${peer.joined}`);
  },
});

// Optional: request raw per-person Opus/PCM audio when a human approves
const audioAgent = createCallAgent({
  session,
  callId: 'main',
  handle: 'voice-coach',
  mode: 'audio',
  onUtterance(utterance) { /* still receives transcripts */ },
  onAudioTrack({ peerKey, displayName, rtpStream, pcmStream, utterancesStream }) {
    // rtpStream: raw Opus RTP frames from werift
    // pcmStream: decoded 16 kHz mono Float32Array PCM chunks (via shared/media/native-audio.mjs)
    // utterancesStream: energy/VAD-segmented speech turns ready for local STT/LLM
  },
});
```

## Cookbook: Custom WebRTC streams & tracks

You do not need `mountCallRoom` to use WebRTC media or binary DataChannels. Both browsers and native Node agents expose the authenticated peer link directly.

### Browser: custom `app:*` binary DataChannel (telemetry, canvas, files)

Use `attachment.peers()` and `attachment.onPeer(listener)` on the page. Every `PagePeerHandle` corresponds to an active direct `RTCPeerConnection` owned by the current tab:

```js
const off = attachment.onPeer(peer => {
  // Listen for incoming custom DataChannels opened by the remote peer.
  peer.onDataChannel(channel => {
    if (channel.label !== 'app:whiteboard') return;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', event => {
      applyStrokePacket(peer.peerId, new Uint8Array(event.data));
    });
  });

  // Open an unordered, unreliable low-latency binary DataChannel.
  // Label MUST begin with "app:" (Chronolog reserves its own internal channels).
  const dc = peer.openDataChannel('app:whiteboard', {
    ordered: false,
    maxRetransmits: 0,
  });
  dc.binaryType = 'arraybuffer';
  dc.addEventListener('open', () => {
    dc.send(encodeStroke({ x: 120, y: 48 }));
  });
});
```

### Browser: add/remove media tracks mid-session

Adding or removing a track on a `PagePeerHandle` automatically triggers in-band Perfect Negotiation with that peer:

```js
const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
for (const peer of attachment.peers()) {
  for (const track of stream.getTracks()) {
    peer.addTrack(track, stream);
  }
}

attachment.onPeer(peer => {
  peer.onTrack(({ track, streams }) => {
    const mediaStream = streams[0] ?? new MediaStream([track]);
    attachRemoteVideoElement(peer.peerId, mediaStream);
  });
});
```

### Native Node (`werift`): binary DataChannels & RTP tracks

In a native agent using `participateNativeApplication`, inspect active peer links via `session.peerLinks()` and `session.onPeerLink(listener)`:

```js
import { createNativeAudioTrack } from '@chronolog/peer-session/webrtc-native';

session.onPeerLink(link => {
  if (link.route.kind !== 'direct') {
    // Relay link: durable Chronolog sync & session.signals still work;
    // direct RTP tracks & app:* DataChannels require a direct WebRTC link.
    return;
  }

  // Receive custom app:* binary DataChannels from browsers or other native peers
  link.onDataChannel?.(channel => {
    if (channel.label === 'app:telemetry') {
      channel.addEventListener('message', event => handleTelemetry(link.peerId, event.data));
    }
  });

  // Receive remote audio/video tracks (werift MediaStreamTrack with onReceiveRtp)
  link.onTrack?.(({ track }) => {
    if (track.kind === 'audio') {
      track.onReceiveRtp.subscribe(rtpPacket => processOpusFrame(link.peerId, rtpPacket));
    }
  });

  // Publish synthetic or TTS Opus RTP audio back into the room
  const outboundAudio = createNativeAudioTrack();
  link.addTrack?.(outboundAudio);
});
```

## Guardrails & limits

- **Peer cap**: Up to **16** concurrent peers per page (`SESSION_PEER_LIMIT = 16`, rendezvous capacity `32`). Full-mesh A/V video works comfortably for small-group calls; larger rooms can disable video or keep text/transcript sync active over Chronolog.
- **Channel namespace**: Custom DataChannel labels must start with `app:` (e.g. `app:audio-meta`, `app:canvas`, `app:file-transfer`). Stream 0 (reliable Chronolog sync) and stream 1 (disposable signals) remain reserved.
- **No durable writes for media**: Never write raw video frames, PCM audio, or cursor ticks into Chronolog commands. Carry live streams over RTP tracks or `app:*` DataChannels, and commit only reviewed artifacts, notes, or explicitly saved transcript utterances to Chronolog.
- **Lifecycle cleanup**: Stop local `MediaStreamTrack`s on `pagehide`, leave, or `onOwnerReplaced`, and always verify camera/mic/screen capture in a real browser at desktop and 320px phone widths (see [Sensors](SENSORS.md) and [Delivery](AGENT_DELIVERY.md)).
