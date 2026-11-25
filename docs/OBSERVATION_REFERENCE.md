# Requested observation reference

The optional [observation example source](https://github.com/werg/tendriller/tree/master/docs/tutorial/shared/observation) connects a visible browser request card to a native participant using the existing public Chronolog session. It includes a deterministic simulated location source, a standard `navigator.geolocation.watchPosition` adapter, a review interface, and a durable pending-operation journal. It adds no Tendriller host endpoint and is excluded from the enumerated first-app archive.

Use [Sensors](SENSORS.md) for capability inspection and cooperative resource tracking, [Application signals](APPLICATION_SIGNALS.md) for disposable traffic, and [Session bootstrap](SESSION_BOOTSTRAP.md) for a real enrolled application. This example is an application-specific convention, not a mandatory sensor protocol.

## Run the maintained qualification

From the Tendriller repository, with Node 22.15 or newer and its installed dependencies:

```sh
npm ci
node --test scripts/test/media-*.test.mjs
node --test scripts/test/browser/observation-session.test.mjs
node scripts/qualify-observation.mjs
```

The browser test exercises Chromium and a native SQLite participant with distinct signing identities. The additional qualifier uses an actual Chromium Worker with the public page facade and current Tendriller runtime, verifies endpoint-bound stream identity, and writes `.results/observation.json` with completed stages and browser version. Both use installed Playwright Chromium; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing compatible Chromium. Each closes its own processes and temporary storage.

The checks cover an inert remote request, trusted Start, producer coalescing, native validation and a correlated response, explicit review, native applied reads, visible and global Stop, the standard geolocation API with browser-emulated coordinates, stale/disconnected state, and native SQLite reopen. Deterministic tests additionally cover late grants/replies, bounded backpressure, and pending-journal reopen with exact-input/id retry or inspection of an already applied operation. Public sessions authenticate, sign and encrypt traffic over bounded test bridges with separate reliable and disposable lanes. These checks do not qualify production host delivery, Internet transports, physical GPS accuracy or mobile permission UX.

## Compose with an existing application

Use a session already connected and enrolled by the ordinary bootstrap. Import the example as authored application code and supply the configured native device public key:

```js
import { mountObservations } from './observation/panel.mjs';

const observations = mountObservations({
  container: document.querySelector('#observations'),
  session,
  runtime: tendril,
  nativeDeviceId,
});
// Await observations.close() when removing this authored view.
```

The native process explicitly allows the browser identities from which it will accept observations:

```js
import { serveObservations } from './observation/receiver.mjs';

const receiver = serveObservations({
  session,
  allowedDevices: [browserDeviceId],
  onState: observation => renderNativeStatus(observation),
  signal: processLifetime,
});
await receiver.requestObservation(browserDeviceId, 'location');
await receiver.done;
```

The supplied `observation/native.mjs` CLI can attach to a page's owner inside the running `tendril agent run`; it accepts `--page SLUG`, `--allow BROWSER_DEVICE_ID` and optional `--request simulated` or `--request location`. It detaches on shutdown without claiming to keep the owner process alive.

A remote request only displays a card and expires after 30 seconds. The person can decline, or press the clearly labelled Start simulator sharing or Start location sharing button. Each start requires `event.isTrusted`. The location route is inspected with `tendril.capabilities(['location'])`, and a pending resource is registered before geolocation acquisition. Visible Stop, page hiding, view teardown, session shutdown, disconnection and global Stop sensors end the run. Reconnection does not restart capture. Late callbacks check the registration's aborted signal; late acknowledgements cannot replace a stopped review candidate.

Capability inspection never prompts and does not establish working hardware. The simulator remains usable when location is missing or denied. It is labelled `source: 'simulated'` and must never be interpreted as a physical location measurement.

## Transport and freshness decisions

Each Start creates a new stream ID. Authenticated author, signal session, stream, endpoint ID and endpoint incarnation identify the producer. Payload roles and claimed authors never authorize a sample. Request ID, source, stream, sample sequence and measurement timestamp correlate each native acknowledgement with the exact sent sample. A requested location observation cannot be answered by a simulator result. Signals are visible to authorized application readers; routing targets are not a confidentiality boundary.

The simulator acquires at 20 Hz while its default transport rate is at most twice per second. The producer keeps one send in flight and one replaceable pending sample. Stop and disconnection discard pending samples; there is no reconnect outbox. Receiver-side `mode: 'latest'` would not reduce producer sampling, signing or transmission work, so coalescing happens before `signals.send`.

Coordinates use decimal degrees, accuracy uses metres, and `sampledAtMs` records measurement time. The default receiver requires accuracy of 100 metres or better, a sample no more than five seconds old and no more than one second into the future. It validates exact payload shape, finite values, coordinate ranges and authenticated stream context. Sample age is checked independently of transport issue time. The UI exposes waiting, accepted/fresh, stale, stopped and disconnected states; reconnecting never makes an old measurement fresh. Choose accuracy, clock-skew and freshness tolerances for the task.

## Explicit review and durable retention

`observation/domain.mjs` declares `retainObservation` and `observations`. Use that definition when creating a new example application, or deliberately incorporate its bounded command schema into a new version of your own definition. Publishing a page alone does not change an existing application's authenticated definition.

Live samples and acknowledgements never execute commands. Retain reviewed observation requires another trusted click and human text. It freezes the exact displayed sample and text, stores them with an operation ID before dispatch, then calls the declared command. The record preserves source, stream/request correlation, measurement time, coordinates and accuracy. Retaining a past observation is distinct from claiming it is still fresh; deterministic replay does not consult the current wall clock or certify physical truth.

Uncertain dispatch keeps the original input and operation ID. Reopening the view reads its local journal without dispatching. Inspect pending operation can resolve an already applied operation; Retry same operation inspects first and reuses the original input and ID. Late edits cannot change an unresolved attempt. Only an applied result clears the pending journal. The native reopen checks verify that only explicitly reviewed observations enter durable history.

## Audio in the lean starter

`media/inference-protocol.mjs` exports `AUDIO_TYPES` and `MEDIA_TYPES` alongside the unchanged `IMAGE_TYPES`. The transport accepts bounded `audio/webm`, `audio/mp4`, `audio/ogg` and `audio/wav` clips. Browser codec parameters such as `audio/webm;codecs=opus` are normalized to a bare allowed content MIME type before staging; the digest covers the exact clip bytes. The existing 8 MiB evidence limit and request deadlines apply. Acquisition code must additionally bound recording duration and stop microphone tracks.

The bundled `provider-openai.mjs` remains image-only and rejects audio before making an HTTP request. Select an explicitly audio-capable provider for clips. The shipped media panel remains a photo/dictation reference, probes only camera and microphone, and keeps file and typed input available when sensor routes are missing or denied. Specialized controllers remain optional examples and cookbooks.
