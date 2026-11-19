# Capture evidence, review AI suggestions, and commit deliberately

Use the **Review a photo** panel in the live Shared Notes application to choose a photo,
optionally ask an authorized native peer for a suggestion, edit the result, and
submit one declared `addEvidence` command. The application stays useful with a
file and a manually written description when camera, voice, or inference is
unavailable. Opening the page, selecting a file, and receiving a suggestion do
not submit that command.

First complete [Build an app](BUILD_AN_APP.md): create and claim the page,
initialize its authority, publish its complete source, enroll the browser device,
and connect the actual native/browser session. The result to deliver is the
hosted page with these connections working. The
[first-app source archive](/downloads/tendriller-first-app.tgz) supplies all the
files named below; their paths are relative to its extracted directory. This
guide does not require a second HTTP backend, database, upload service or SSE
channel. [The capability map](CAPABILITIES.md) identifies the existing pieces.
The shipped `media/panel.mjs` composes the controls described here; `page.mjs`
owns the shared session, pending operation reference and retry controls.

## 1. Choose and review the actual evidence

On the connected page, use **Choose a photo** to select a file, or select **Open
camera**, inspect the live preview and choose **Take photo**. Capture stops the
live camera before encoding the image. **Stop camera**, discarding the candidate,
page backgrounding and the runtime's **Stop all** boundary stop camera activity
and invalidate obsolete acquisition work. A late camera permission grant is
released instead of reopening the preview. The captured photo remains visible
for review until it is replaced or deliberately discarded.

Keep the candidate visible while writing its description. The current helpers
accept JPEG, PNG or WebP images up to 8 MiB. Camera frames are bounded to a
1280-pixel longest edge by default. A file is a complete alternative to camera
permission, and a typed description is a complete alternative to model output.
The helper's file-size and MIME checks do not establish the quality or meaning
of the evidence.

Capture task context **before** asynchronous recording, encoding or inference.
The starter retains the revision from a coherent `session.query('notes', null)`
result. It copies that context with the candidate and computes a SHA-256 digest
of the immutable bytes. Later edits or another photo must not change the meaning
of an already submitted candidate.

The starter's notes collection is append-only. Its captured revision provides
context and an ordering prerequisite; it is not a mutable-task version guard.
For a task whose question, inventory or approval can change, include the domain
version in the captured context and enforce that guard in the declared command.
See [state models and the SQL example](STATE_MODELS.md).

## 2. Explicitly authorize a native inference peer

Inference is optional. Choosing **Analyze photo** sends the selected image and prompt
to the provider configured by the native process. Tell the person which provider
will receive those bytes before they choose that action. Authorizing a camera or
enrolling an application device does not authorize a provider request.
The shipped panel explicitly names **OpenAI**, matching the bundled default
provider. Before using a custom provider, update the paragraph and sharing
checkbox in `index.html` and the analysis-consent error in `media/panel.mjs` to
identify that actual recipient, then rebuild and publish those changes.

There are two separate approvals in this example:

- The native operator selects the provider/model, supplies its credential, allows
  exact browser device public keys, and bounds the number of requests.
- The person using the page reviews the outgoing evidence and deliberately asks
  for analysis. The result remains an editable suggestion.

Obtain the **browser device public key** displayed by the connected page. It is
the signer enrolled with `npm run enroll -- BROWSER_PUBLIC_KEY`, not an account
email, agent bearer token, page ID or the native device key. The inference
allowlist is an additional permission to use the native provider budget.

Stop the ordinary `npm run peer` process with Ctrl-C. The inference launcher
opens the same native session and signer, so it **replaces** that process. Two
processes must not open the same exclusive device store.

In the extracted starter directory, supply the credential through the native
environment or secret manager, select an image-capable model explicitly, and run:

```sh
node media/inference-peer.mjs \
  --model YOUR_EXPLICIT_IMAGE_CAPABLE_MODEL \
  --allow-device BROWSER_PUBLIC_KEY \
  --max-requests 1
```

The bundled `media/provider-openai.mjs` reads `OPENAI_API_KEY` only in this native
process. For a manual Bash session, this reads it without placing the value in
the command history or echoing it:

```sh
read -r -s -p 'OpenAI API key for the native process: ' OPENAI_API_KEY
printf '\n'
export OPENAI_API_KEY
```

Then run the launcher above. After stopping it, `unset OPENAI_API_KEY` removes
that shell's copy. Use a secret manager for ongoing operation. Never place the
key in an HTML file, browser configuration, device grant, signal payload, content
reference, published asset, screenshot or source commit.

The launcher prints its native inference device public key. The starter's build
already records that same initialized native device as `nativeDeviceId` in public
`configuration.json`; there is no second key-entry step in the panel. A request
names this target, and the browser accepts replies only from that authenticated
signer. If you deliberately change the native identity, rebuild and republish
the matching public configuration and authority. No private credential is needed
in the page.

`--allow-device` can be repeated for deliberately authorized devices.
`--max-requests` defaults to **one admitted request for this process lifetime**;
the supported range is 1–100. `--max-output-tokens` defaults to 600 and accepts
1–2000. These bounds do not promise a fixed price: use the selected provider's
account controls and model limits. An admitted request that later fails or is
cancelled still consumes the local request budget.

The peer remains connected after its budget is exhausted, and reports an explicit
budget error for a new inference request. Restarting it renews that process
budget and its in-memory deduplication state. Restart is a deliberate operator
decision, not an automatic retry or a durable spending ledger.

## 3. Analyze without giving the model command authority

After the person selects the provider-sharing checkbox and **Analyze photo**,
the browser stages the exact candidate through `session.content.stage`, writes
its bounded chunks, and commits an immutable
content reference. This uses the application's existing content owner and store.
Analysis can therefore retain/share evidence bytes even though it has not
submitted a business command.

The browser sends a small authenticated session signal containing the request
identity, content reference, candidate ID, SHA-256, copied context and prompt. The
native listener checks the envelope's verified author against its explicit
allowlist; a payload claiming `owner`, another device, or an authorized role
grants nothing. It validates application/history scope, size and media type,
fetches content through the session, and checks the actual bytes against the
requested digest before calling the provider.

The inference callback receives bytes, metadata, a prompt and a cancellation
signal. It receives no session, signer, application command function or
publication authority. The bundled provider returns `{ text }`. The native
listener sends that bounded JSON as a suggestion associated with the original
request and source. It never calls `session.command`.

**Session signals are visible to authorized application readers.** A target or
recipient field routes work; it is not private per-recipient messaging. Content
membership likewise determines who can obtain evidence. Keep private evidence
in an application whose actual membership is appropriate; hiding a field in a
query or sending a device-targeted signal does not change membership.

Signals are ephemeral. Sending a request does not prove delivery, and an offline
native process cannot perform inference. Keep the candidate if no reply arrives.
The example does not create a hidden background queue or automatically charge
for another attempt. A deliberate new Analyze action is a new request.

### The actual browser adapter

`media/inference-client.mjs` is ordinary starter source, not a new SDK export.
Inside the connected page, compose it with the existing session:

```js
import { createPeerInferenceClient } from './media/inference-client.mjs';

const inference = createPeerInferenceClient({
  session,
  workerDeviceId: configuration.nativeDeviceId,
  prompt: 'Suggest a concise description of this image. State uncertainty.',
});

const analysis = await inference.analyze({ candidate, signal });
// analysis.suggestion: editable JSON, e.g. { text: '...' }
// analysis.source: { candidateId, sha256, reference }
```

Here `session` is the already enrolled browser Worker facade; `candidate` comes
from the review controller below. `configuration` is the starter's published
`configuration.json`, loaded by `page.mjs`; its native public key is public
configuration. `analysis.source` is reconstructed from the client's captured
request and committed reference, after checking the reply's signer and identity;
it is never accepted from a model-provided source field.

Call `inference.close()` when disposing the view or changing its inference peer.
The default overall timeout is 45 seconds and the default byte limit is 8 MiB.
The native listener separately bounds an inference attempt to 30 seconds. The
client accepts optional `timeoutMs` and `maxEvidenceBytes` within its declared
limits.

## 4. Edit the suggestion, then submit one reviewed command

The actual panel has two deliberate routes:

1. **Manual review:** write a description in **Your reviewed observation** and
   choose **Save reviewed observation**. No provider is needed.
2. **Optional analysis:** first confirm the owner has identified the provider
   receiving this image, select the sharing checkbox, and choose **Analyze photo**.
   Inspect the returned suggestion separately from your existing text. Choose
   **Copy suggestion into review** only if you want to use it, edit the text, then
   choose **Save reviewed observation**. A suggestion never saves itself.

Both routes retain the reviewed text and the photo's immutable content reference.
The reviewed text must contain 1–2000 characters; a longer suggestion or transcript
must be edited before saving, rather than silently truncated. **Discard candidate
/ cancel analysis** is available before a prepared submission becomes pending.
After the operation resolves, **Start another observation** opens a fresh review.

`helpers/reviewed-input.mjs` exports `createReviewedInput`. It separates local
capture, optional analysis, explicit editing and durable commit:

```js
import { createReviewedInput } from './helpers/reviewed-input.mjs';

const review = createReviewedInput({
  analyze: input => inference.analyze(input),
  commit: submitEvidence,
  onChange(snapshot) { renderMediaReview(snapshot); },
});

await review.capture({ blob, context });
const analysis = await review.analyze(); // Only from the person's Analyze photo action.

// Only after the person reviews/edits the candidate and proposed text:
const reviewed = review.edit({ text: editedText, source: analysis.source });
const operationId = crypto.randomUUID();
await prepareEvidence({ candidate: review.snapshot.candidate, reviewed,
  operationId, signal });
await review.commit({ operationId, signal });
```

These are the integration points used by `media/panel.mjs`: `blob` is the chosen
file/frame, `context` is the earlier coherent query context, and the rendering
callback owns the visible review controls. The parent page passes its real
`prepareEvidence` and `submitEvidence` functions as `prepareCommit` and `commit`;
they are application functions, not additional SDK exports. The panel supplies
the cancellable lifetime `signal`. Analysis never invokes `edit` or
`commit` automatically. An arriving suggestion does not overwrite human edits.
Editing or replacing a candidate invalidates obsolete analysis.

Preparation validates the reviewed values, obtains the content reference if
needed, and retains the exact pending input, operation ID and captured revision
before dispatch. A staging or local-storage error before retaining that pending
reference leaves the candidate available for editing or another deliberate Save.
The shared preparation guard prevents a note submission from overwriting it.
Once preparation succeeds, `submitEvidence` dispatches that matching prepared
intent. Its declared command is:

```js
const input = {
  text: reviewed.text,
  source: reviewed.source,
  capturedRevision: JSON.stringify(candidate.context.revision),
};
const operation = await session.command('addEvidence', input, {
  operationId,
  basedOn: candidate.context.revision,
});
const result = await operation.applied({ signal });
```

`source` is exactly `{ candidateId, sha256, reference }`, text is bounded to
2000 characters, and the serialized captured revision is bounded to 16,384
characters. The command emits a note containing the reviewed description,
source and captured revision. Its authenticated author and operation identity
come from the session. The page then uses its normal operation inspection,
exact retry and recovery UI.

For **manual review**, write the description without Analyze. After explicit
Save, `prepareEvidence` stages the same immutable candidate through session
content and constructs the source reference itself, before invoking the review
controller's commit. If analysis already supplied the validated source reference,
preparation reuses it. Neither route replaces session content with another upload
service or treats an upload receipt as command acceptance.

A failed or cancelled response wait cannot establish whether a command was
saved. Once commit has been dispatched, the review controller preserves the
operation identity and refuses to silently discard, retry or reapply it. Use
**Inspect operation** and **Retry same operation** above the photo panel. The
page reads `session.operations` and preserves the original pending input and
identity, including after a reload. A recovery that abandons an attempt requires
deliberate reapplication under a new identity;
the existing **Reapply after reviewing current notes** control supplies that
explicit action when the original operation is eligible. Do not silently
reconstruct the command from the current form.

## Camera, sensor tracking and voice are distinct pieces

`media/camera.mjs` acquires the camera with native `getUserMedia`, owns its preview
element, extracts a frame with canvas, and releases its resources. The runtime's
`tendril.sensors.status/on/stopAll` observes tracked active/pending use and supplies
the page-wide Stop all boundary. It does not acquire or select a photo.

```js
import { createCameraController } from './media/camera.mjs';

const camera = createCameraController({ runtime: tendril, video, onStatus });
await camera.start(trustedClickEvent);
const blob = await camera.capture(); // Unsubmitted image; camera tracks stop.
// Or: const blob = camera.useFile(fileInput.files[0]);
```

Bind `start` to a real button/keyboard action and preserve context before media
work. `stop()` cancels this controller; `stopAll()` invokes the runtime's wider
sensor cancellation boundary. A browser-owned permission dialog may remain
visible after cancellation, but a late stream is stopped. The default source
supports no automatic capture loop. Dispose the controller on teardown.

`media/voice.mjs` wraps the existing optional `createVoice` lifecycle. By default
it loads `import(tendril.assetUrl('voice.mjs'))`, preserving the selected runtime.
A bundled app can supply `loadVoice: () => import('@tendriller/runtime/voice')`.
`@tendriller/core/voice` supplies types, not this runtime constructor.

```js
import { createVoiceController } from './media/voice.mjs';

const voice = createVoiceController({
  runtime: tendril,
  consent: request => showVoiceConsent(request),
  onDraft: ({ text, context, attemptId }) => offerEditableTranscript({ text, context, attemptId }),
  onStatus: renderVoiceStatus,
});
await voice.prepare(trustedPrepareEvent); // Selected resources; no microphone.
await voice.start(trustedRecordEvent, { context });
voice.finish(); // Produces an editable transcript candidate, never a command.
```

Typed input remains available while resources load or transcription fails. The
starter's **Dictate a draft note** controls use this sequence: select **Allow voice
preparation and microphone use for this draft**, choose **Prepare voice** and
respond to its explicit consent request, then choose **Dictate** and **Finish**.
The recognized text appears in a separate transcript field. **Copy transcript
into note draft** appends it to the current note draft; it does not overwrite
typing or save a command. Edit the resulting note, then choose **Save note**
separately. This uses the normal `addNote` route, without an image or provider
analysis. The voice wrapper retains captured context for applications that need
it; copying text into this append-only notes form starts an ordinary note review.

The page owns whether a transcript replaces, appends to, or is discarded beside
its current text; a late transcript must not overwrite new typing. `cancel()`, Stop
all, backgrounding and disposal stop voice activity and invalidate obsolete
results. Optional output requires `enableOutput(event, engine)` before explicit
`speak(text)`. See [the voice guide](HANDS_FREE.md) for local transcription, wake
mode, output-engine and device limits. A transcript is not an image, and is not
passed to this image-inference adapter as if it were one.

## Provider integration and process lifetime

The shipped OpenAI module uses the official
[Responses HTTP API](https://developers.openai.com/api/reference/resources/responses/methods/create)
with the documented [image-input data URL format](https://developers.openai.com/api/docs/guides/images-vision).
It requests a text suggestion with no application tools, sets
`store: false`, bounds output and rejects incomplete or oversized replies. This
setting is not a general zero-retention promise. Check the selected provider's
current account/data controls and supported model before offering it to a user.
The example chooses no default model and silently substitutes no provider.

To use a different provider, first publish the matching recipient disclosure
described above, then pass `--provider ./your-native-provider.mjs`. That module
must export `createInferenceProvider(options)` returning an async function
with this interface:

```js
infer({ bytes, mediaType, prompt, context, source, signal })
  // Resolves to bounded suggestion JSON, e.g. { text: 'Review this text.' }.
```

The module is intentionally trusted native code selected by the operator. Keep
credentials in its native closure, respect cancellation, and return suggestions
only. `media/inference-service.mjs` composes that callback as
`servePeerInference({session, allowedDevices, maxRequests, infer, signal})`; the
returned object exposes `done`, `snapshot()` and `close()`. It reads content and
signals from the already opened session. It never starts an HTTP data service.

Keep this native process running while inference is needed. Closing the browser
stops its local work; closing the native process ends this inference participant.
A published page does not host that computation. A signed request, a running
watcher or an MCP connection also does not create a ChatGPT conversation wake or
handoff. Follow [the application delivery contract](AGENT_DELIVERY.md) when a
task requires a dependable ongoing owner or host integration.

## Cancellation, receipts and honest verification

Cancel invalidates the page's attempt immediately and sends a best-effort cancel
signal to the authorized native peer. The native listener also has its own
deadline. A lost cancellation or a provider that cannot stop may still finish or
incur cost; a late result cannot become a reviewed command. The listener retains
its physical concurrency slot until an outstanding provider call actually settles.
Exact repeated requests reuse the process's recorded result instead of invoking
the provider again, but this is not durable deduplication across process restart.
Discarding a local candidate removes its preview and invalidates local work;
it does not delete already committed session content or retract bytes already
shared with another reader or provider.

Keep these observations distinct:

| Observation | What it establishes |
| --- | --- |
| Local candidate | Exact bytes and copied context are available in this page's review controller |
| Committed content reference | The session identified those immutable evidence bytes; copying/retention elsewhere is a separate observation |
| Inference suggestion | The selected peer returned a result for the matching source; a person has not necessarily approved it |
| Saved command | The session retained the command's signed intent under its operation ID |
| Applied accepted command | The declared command was accepted in the selected application history |
| Shared/retained coverage | Another peer reported the specific retained coverage; this is not irreversible finality |

Neither analysis nor an applied command is a general external-action transaction.
The example is **credential-protected inference**, not a protected recovery floor
or an automatic external-effect dispatcher.

Verify the complete hosted flow with a real enrolled browser: select a file,
review manually, commit, reload, and inspect the same operation/source; then
exercise the camera and optional voice on the actual target device. With explicit
provider authorization, analyze once, edit its suggestion, and verify that only
the separate commit changes notes. Deny a device, exhaust the request budget,
cancel during processing, replace a candidate, disconnect the native peer and
cancel a command wait. Retain the original evidence and operation identity at the
appropriate checkpoint.

`scripts/test/media-controllers.test.mjs` exercises the actual core sensor/voice
logic with browser-device mocks. `scripts/test/media-inference.test.mjs` checks
the peer API contract, authenticated-envelope policy, source validation,
cancellation, deduplication, request budget and a stubbed provider HTTP response.
These unit tests do not establish a live provider result, physical camera quality,
speech accuracy, Internet reachability or a deployed ChatGPT handoff. Record the
exact live checks performed and any remaining blockers rather than inheriting
those claims from a passing mock or a local preview.
