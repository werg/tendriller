# Reviewed live observation reference

This optional application example combines a simulated source and standard browser
`navigator.geolocation.watchPosition` with the current Tendriller lifecycle and
Chronolog session APIs. It is kept outside the enumerated first-app archive.
It introduces no sensor endpoint, host upload route, runtime acquisition wrapper,
provider key, or mandatory cross-application observation protocol.

## Run the verified reference

From the Tendriller repository, with its normal dependencies and Playwright Chromium
installed:

```sh
node --test scripts/test/media-observation.test.mjs
node --test scripts/test/browser/observation-session.test.mjs
node scripts/qualify-observation.mjs
```

The first command tests malformed and stale samples, authenticated identity,
pending permission cancellation, late callbacks, and visibility teardown. The
second opens a real Chromium page and a native SQLite-backed session using public
`@chronolog/peer-session` packages. It runs the simulator and the actual browser
geolocation API with supplied test coordinates, checks correlation, freshness and
Stop sensors, and verifies that one reviewed command survives native reopen.
The additional qualifier exercises a real browser Worker and public page facade,
including endpoint-bound stream identity, and writes `.results/observation.json`.
The fixtures use bounded embedded frame transports across Chromium and Node;
the sessions execute their normal authenticated, encrypted protocol. It does not
qualify WebRTC, relay deployment, real GPS accuracy, mobile permission UX, or
physical camera/microphone hardware. No provider or production service is called.

## Use in an authored application

For a **new** example application, copy this directory beside the starter's
`helpers/` directory. Import `definition` from `observation/domain.mjs` in both the
native and browser session bootstrap before creating its signed descriptor.
Keep normal setup, publication, enrollment, and participation from the
[session bootstrap guide](../../SESSION_BOOTSTRAP.md). Do not replace an existing
history's definition with this one. A different app can instead declare an
appropriate reviewed-retention command in its own definition.

After obtaining the existing authenticated browser session and runtime, mount:

```js
import { mountObservations } from './observation/panel.mjs';

const observations = mountObservations({
  container: document.querySelector('#observations'),
  session,
  runtime: tendril,
  nativeDeviceId: approvedNativeDeviceId,
});
// Await observations.close() when removing this authored view.
```

Only **Start simulator sharing** or **Start location sharing**, reached through a
trusted local gesture, can start acquisition. Location is inspected with
`tendril.capabilities(['location'])` without prompting. Missing or denied location
keeps the simulator usable. The panel shows whether it is sharing and whether the
native receiver is waiting, accepted, stale, or disconnected. **Stop sharing**,
**Stop sensors**, hiding the page, leaving it, closing the session, and closing the
view all stop its resource. Pending work registers before permission acquisition;
a late callback cannot resume a stopped run.

In the native participant or an existing authenticated attachment:

```js
import { serveObservations } from './observation/receiver.mjs';

const observer = serveObservations({
  session,
  allowedDevices: [approvedBrowserDeviceId],
  onState: value => console.log(value),
});
// This sends a visible request card. It cannot activate browser hardware.
await observer.requestObservation(approvedBrowserDeviceId, 'location');
// Keep the process alive while observing; await observer.close() on shutdown.
```

The optional CLI attaches to the running retained owner exported by the starter's
`session.mjs`. Run it from that application directory, substituting its verified
browser device ID:

```sh
node observation/native.mjs --session ./session.mjs --allow BROWSER_DEVICE_ID --request simulated
```

Omit `--request` to observe only locally initiated sharing. Use `--request location`
for a location card. Ctrl-C/SIGTERM closes this observer and detaches; the existing
owner keeps its normal process lifetime. Requests expire after 30 seconds and are
never an instruction to activate a sensor automatically. A displayed request can
be declined. The same request ID follows the accepted sample and native reply.

## Data and lifecycle contract

The simulator acquires at 20 Hz and the producer sends at most once per 500 ms by
default. There is one in-flight send and one replaceable pending sample. Queued
samples are discarded on Stop, disconnection, or expiry; there is no reconnect
backlog. `mode: 'all'` on a receiver is not producer throttling. Each run gets a new
stream ID; the actual `session.signals` stream context binds the author, signal
session, stream ID, endpoint ID and endpoint incarnation. A native response is
accepted only from the configured authenticated signer and for an exact sent
stream, sample sequence, request ID and sample timestamp.

Each bounded sample declares `source`, `latitude`, `longitude`, `accuracyM` and
`sampledAtMs`. Degrees and meters are explicit. The adapters reject fixes worse
than 100 meters. The native receiver independently validates the full schema,
allowlisted envelope author, application scope, stream metadata, numeric ranges,
sequence, and sample age. Its default age limit is five seconds; a transport
`issuedAtMs` cannot refresh an old measurement. A sample more than one second in
the receiver's future is rejected. This wall-clock freshness policy assumes the
devices are synchronized within that bound; an application with looser clocks
must choose and document another policy.

The `sensing-reference/*` topics are this example's optional convention. Target
metadata is a routing hint, not a confidentiality boundary. All signals can be
visible to authorized application readers. A bounded Stop marker speeds up
receiver feedback; missing markers fall back to age expiry. Stop-before-sample
and duplicate messages do not revive closed streams. The native snapshot displays
the current series per authorized device, with bounded replay tracking.

Live samples, requests and replies never call `session.command`. To retain one,
write/edit its meaning and press **Retain reviewed observation**. The declared
`retainObservation` command freezes that exact displayed sample and reviewed text.
The panel saves the operation ID and input locally before dispatch, keeps an
uncertain attempt locked, and offers explicit inspection or retry of the same
identity. Reload never automatically resubmits it. A command records a person's
review, not proof that a sensor or model was correct. No live sample enters a
durable journal until that explicit choice.

## Related media transport

The starter's `media/inference-protocol.mjs` preserves `IMAGE_TYPES` and exports
`AUDIO_TYPES` and `MEDIA_TYPES`. It accepts `audio/webm`, `audio/mp4`, `audio/ogg`, and
`audio/wav` clips (including bounded recorder codec metadata) within the existing
8 MiB evidence ceiling. Content references use the canonical container MIME type
(for example `audio/webm`); the original Blob, bytes and digest remain unchanged.
The client validates type and size before content staging;
the native service revalidates the immutable reference and digest. Acquisition
controllers must also bound recording duration. The bundled
`media/provider-openai.mjs` remains image-only and rejects audio before HTTP; pair
an audio-capable provider explicitly and name the destination in the review UI.
Use the contributed sensor cookbooks for screen frames and bounded audio capture.
