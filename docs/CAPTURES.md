# Reliable inputs and captured media

## A result means one of three things

`await tendril.send(data)` returns a tagged result:

- `status: "accepted", queued: false, seq`: the server accepted the event. This does not mean an agent has handled it.
- `status: "queued", queued: true`: the input is waiting for delivery. Keep a visible queued state until its acknowledgement or a reply arrives.
- `status: "rejected", queued: false, error, message`: the server rejected it. Keep the input and show the message; do not render “Sent”.

The existing `queued` field remains for compatibility. New code should check `status` before clearing an editable field. A connected socket alone does not imply that a request was accepted.

The `send_result` event reports accepted or rejected non-instruction inputs, including inputs replayed after a reload. It contains the result fields, `cid`, and the original `data`. Include a stable application ID such as `observation_id` in the data to reconcile a locally saved card with its later receipt. Owner instructions use `instruction_ack` or `instruction_rejected` with `cid` and `text`; a rejected instruction is removed from the optimistic transcript so it cannot reappear as still sending.

## Capture media and its meaning together

Use `uploadEvent` for a photo, recording, file, or drawing that represents an input:

```js
const result = await tendril.uploadEvent(photo, {
  name: "hinge.jpg",
  data: { type: "input", modality: "photo", note: "Which part is loose?", at: Date.now() },
  keep: true
});
```

The runtime stores the blob and the semantic input in one IndexedDB outbox record. It persists the upload receipt before sending the event. Reloads, interrupted uploads, and reconnects resume the same transaction. The event contains the original data plus `blob`, `url`, and `capture_id`. An accepted result includes `seq`, `capture_id`, and `blob: {id, url, retention}`. An offline call returns `queued` after the local storage transaction commits, so the UI can finish the capture without waiting for a network connection.

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

`tendril.retryCapture(capture_id)` retries a rejected capture using its saved blob and metadata. It uses a new semantic event attempt ID because the server may have cached the prior rejection; it reuses an uploaded blob instead of duplicating media. `tendril.discardCapture(capture_id)` removes the local queued capture. Discarding is not an undo of a request already accepted by the server.

When browser storage is unavailable or a durable write fails, `uploadEvent` returns `storage_unavailable` rather than claiming the capture was saved. Keep the local preview open so the person can retry or save the file elsewhere. Device storage can still be evicted by the browser; installation and available storage affect offline reliability.

## Retention is separate from page lifetime

Page captures normally expire 30 days after upload, including on resident tendrils. Upload responses and blob metadata expose:

```json
{"retention":{"keep":false,"expires_at":1900000000000,"reason":"page_default"}}
```

Owners may select “Keep” during capture (`uploadEvent(..., {keep: true})`) or use `await tendril.setBlobRetention(id, {keep: true})` later. Kept captures have `expires_at: null` and count toward the existing storage quota. They remain until explicitly deleted or the tendril/account is deleted. Unpinning restores the original expiry, which may already be past. Agent assets and the install icon have retained policies identified by `reason`; making a page resident does not change capture retention.

Agent APIs: `GET A/blobs` and `GET A/blobs/<id>/info` return metadata and retention; `PATCH A/blobs/<id>` accepts `{keep: boolean}`. Page API: `GET/PATCH P_tendril/blob/<id>/retention`; only an authenticated owner can mutate it. A page upload may include `X-Tendril-Keep: true`, again only for the owner. Guests can upload ordinary captures but cannot extend their retention.
