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
  data: { type: "input", modality: "photo", note: "Which part is loose?", at: Date.now() },
  keep: true
});
```

The runtime stores the blob and the semantic input in one IndexedDB outbox record. It persists the upload receipt before sending the event. Reloads, interrupted uploads, and reconnects resume the same transaction. The event contains the original data plus `blob`, `url`, and `capture_id`. An accepted result includes `seq`, `capture_id`, and `blob: {id, url, retention}`. An offline call returns `status:"queued"` after the local storage transaction commits, so the UI can finish the capture without waiting for a network connection.

If a component wraps a value, set `dataPath`, for example:

```js
await tendril.uploadEvent(drawing, {
  data: { type: "ui", block: "sketch", value: { width: 640, height: 320 } },
  dataPath: ["value"]
});
```

This adds the media reference to `data.value` while keeping `capture_id` at the event's top level. Prototype keys are forbidden in `dataPath`.

Do not compose `await upload(blob); await send(metadata)` for durable capture flows: a reload between those calls can lose the metadata. The lower-level `upload` API remains available for standalone assets.

### Recovery

Listen for `upload_event` to update a card after offline replay. Its payload is a capture result with the same `capture_id`. `capture_queue` reports the pending/rejected queue after storage opens and after changes. Read `tendril.captures()` on mount as well, because a listener may attach after initialization.

`tendril.retryCapture(capture_id)` retries a rejected capture using its saved blob and metadata. The retry retains the original command ID and scope generations. It reuses an uploaded blob instead of duplicating media. A stale-generation rejection stays rejected until the person deliberately creates new work after review; retry never relabels a capture. `tendril.discardCapture(capture_id)` removes the local queued capture. Discarding is not an undo of a request already accepted by the server.

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

Page captures normally expire 30 days after upload, including on resident tendrils. Upload responses and blob metadata expose:

```json
{"retention":{"keep":false,"expires_at":1900000000000,"reason":"page_default"}}
```

Owners may select “Keep” during capture (`uploadEvent(..., {keep: true})`) or use `await tendril.setBlobRetention(id, {keep: true})` later. Kept captures have `expires_at: null` and count toward the existing storage quota. They remain until explicitly deleted or the tendril/account is deleted. Unpinning restores the original expiry, which may already be past. Agent assets and the install icon have retained policies identified by `reason`; making a page resident does not change capture retention.

Agent APIs: `GET A/blobs` and `GET A/blobs/<id>/info` return metadata and retention; `PATCH A/blobs/<id>` accepts `{keep: boolean}`. Page API: `GET/PATCH P_tendril/blob/<id>/retention`; only an authenticated owner can mutate it. A page upload may include `X-Tendril-Keep: true`, again only for the owner. Guests can upload ordinary captures but cannot extend their retention.
