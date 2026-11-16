# Reliable inputs and captured media

## A result means one of three things

`await tendril.send(data)` returns a tagged result:

- `status: "accepted", seq`: the server accepted the event. This does not mean an agent has handled it.
- `status: "queued"`: the input is waiting for delivery. Keep a visible queued state until its acknowledgement or a reply arrives.
- `status: "rejected", error, message`: the server rejected it. Keep the input and show the message; do not render “Sent”.

Check `status` before clearing an editable field. A connected socket alone does not imply that a request was accepted.

The `send_result` event reports accepted or rejected non-instruction inputs, including inputs replayed after a reload. It contains the result fields, `cid`, original scope/generation metadata, and the original `data`. Include a stable application ID such as `observation_id` in the data to reconcile a locally saved card with its later receipt. Conversation input uses `conversation_result` with stable `cid`, `text`, and `status`. A rejected queued input remains in the local transcript as explicitly rejected, including after reload, so an authored interface can recover its text without showing it as still sending.

## Capture media and its meaning together

Use `uploadEvent` for a photo, recording, file, or drawing that represents an input:

```js
const result = await tendril.uploadEvent(photo, {
  name: "hinge.jpg",
  data: { submission_id: crypto.randomUUID(), type: "input", modality: "photo", note: "Which part is loose?", at: Date.now() },
  keep: true
});
```

The runtime stores the blob and the semantic input in one IndexedDB outbox record before making a network request. It reserves an immutable upload session with the original command ID, byte length, and SHA-256 digest; sends raw bytes only when needed; and verifies the completion receipt. It persists that receipt before any requested pin operation, then persists the pin receipt before sending the semantic event. Reloads, interrupted uploads, and reconnects resume the saved phase with the original identities and guards.

The event contains the original data plus `blob`, `url`, and `capture_id`. An accepted result includes `seq`, `capture_id`, and a complete blob reference: `{id, sha256, size, type, url, created_at, retention}` with optional `name`. The browser returns an absolute URL for the immutable blob. An offline call returns `status:"queued"` after the local storage transaction commits, so the UI can finish the capture without waiting for a network connection.

Each `uploadEvent` call creates new work with a runtime-owned `capture_id`.
Its options do not accept a command ID; unknown options such as `cid` fail validation
before any queue write or upload. Give the reviewed input its own `data.submission_id`
before asynchronous work when the page needs to identify a draft or outcome card.
That application ID and the runtime's capture ID have separate purposes.

`capture_queue` entries include both `capture_id` and the original `data`, so the
page can persist their association as soon as the durable queue changes. The
promise's result also carries `capture_id`; associate it with the submitted card
in that call's closure. This handles a storage rejection, which never enters the
queue. `upload_event` carries a result and capture ID, without repeating the original
data, so reconcile it against the saved association. An early terminal event can
arrive before the original promise's continuation; applying the same outcome twice
must be harmless.

If a component wraps a value, set `dataPath`, for example:

```js
await tendril.uploadEvent(drawing, {
  data: { type: "ui", block: "sketch", value: { width: 640, height: 320 } },
  dataPath: ["value"]
});
```

This adds the media reference to `data.value` while keeping `capture_id` at the event's top level. Prototype keys are forbidden in `dataPath`.

Do not compose `await upload(blob); await send(metadata)` for durable capture flows: a reload between those calls can lose the metadata. The lower-level `upload(blob,{name?,keep?,scope?,expected_generations?})` API remains available for standalone assets. It also commits its upload identity and optional pin command before I/O. Its promise resolves to the verified blob reference after completion; it remains pending while offline. The `upload` event reports `{cid,name,...blob}` after delivery, including after a reload when the original promise no longer exists.

### Recovery

Listen for `upload_event` to update a card after offline replay. Its payload is a capture result with the same `capture_id`. `capture_queue` reports the pending/rejected queue after storage opens and after changes. Read `tendril.captures()` on mount as well, because a listener may attach after initialization.

`tendril.retryCapture(capture_id)` retries a rejected capture using its saved blob and metadata. The retry retains the original upload, pin, and event command IDs and scope generations. It reuses a received upload session or persisted blob receipt instead of duplicating media. Use this operation to retry saved work; calling `uploadEvent` again creates a separate submission. A stale-generation rejection stays rejected until the person deliberately creates new work after review; retry never relabels a capture. An expired or aborted transfer also requires explicit new work after review. `tendril.discardCapture(capture_id)` removes the local queued capture. Discarding is not an undo of a request already accepted by the server.

When browser storage is unavailable or a durable write fails, `uploadEvent` returns `storage_unavailable` rather than claiming the capture was saved. Keep the local preview open so the person can retry or save the file elsewhere. Device storage can still be evicted by the browser; installation and available storage affect offline reliability.

## Scope metadata is captured before asynchronous work

Scopes are explicit platform metadata. For a capture associated with a protected
scope, call `tendril.scopes.capture(scopeId)` when the user begins that action,
then pass the returned `{scope,expected_generations}` to `uploadEvent`. Keep those
values even if recording, processing, or upload finishes after a scope rotation.
The runtime persists them with the capture; application fields such as `type` or
`session` have no platform meaning.

Uploading bytes and accepting their semantic event are separate server steps.
The `capture_complete` envelope contains the uploaded blob ID outside `data`, the
original command ID, and the captured preconditions. The server checks capture
bindings and any explicitly selected scope in the same transaction as storing
the event and receipt. It exposes validated context separately from event data.
A duplicate accepted completion returns the saved receipt without storing a
second event.

For shared-state changes, the runtime derives protected paths from authoritative
scope descriptors. Root replacement and ancestor writes include every overlapping
scope. All queued operations retain their first captured preconditions. An
outdated optimistic change is excluded when reconstructing the current view.

## Retention is separate from page lifetime

Unreferenced uploads expire 30 days after upload, including on resident tendrils. This applies equally to page and agent uploads. Upload responses and blob metadata expose:

```json
{"retention":{"expires_at":1900000000000,"reasons":["unreferenced_upload"]}}
```

Owners may select “Keep” during capture (`uploadEvent(..., {keep: true})`) or use `await tendril.setBlobRetention(id, {keep: true, ...context})` later. Pin commands include a separate command ID and captured scope generations. Guests can upload ordinary captures but cannot pin them.

Pinned blobs, current shared files, retained file history, publication graphs, and the install icon are explicit retention roots. Their metadata has `expires_at: null` and reports the applicable `reasons`, such as `"pinned"`, `"shared_file"`, `"file_history"`, `"publication"`, or `"icon"`. They count toward storage quota. Unpinning removes only the pin reason: other references continue retaining the blob. Once no references remain, the original upload expiry applies and may already be past. A blob ID written into arbitrary application JSON does not retain its bytes. Making a page resident does not change these rules.

The HTTP protocol is the same under the agent API base and the page's `_tendril` base: `POST /uploads`, `PUT /uploads/<id>/content`, and `POST /uploads/<id>/complete` transfer bytes; `GET /blobs/<id>/info` reads metadata; `GET /blobs/<id>` reads bytes; and `PUT /blobs/<id>/pin` accepts `{cid,expected_generations,scope?,keep}`. The agent SDK exposes `client.blobs`; browser captures use the narrow upload primitive internally. Neither path encodes upload bytes as base64.
