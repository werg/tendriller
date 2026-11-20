# Live application signals

Signals carry ephemeral observations through the application session. They have no durable operation identity or replay cursor. Use them for presence, cursor position, previews, progress and device observations that are useful only while fresh.

Install the session's signal port with `tendril.signals.install(session.signals)`, or pass `signals` when calling `startRuntime`. The binding can be installed independently from the durable application binding. An uninstalled port rejects immediately and queues nothing for later replay.

```js
await tendril.signals.send('typing', { active: true }, { ttlMs: 1000 });
for await (const signal of tendril.signals.subscribe({
  topics: ['typing'], mode: 'latest', signal: abort.signal,
})) {
  renderTyping(signal.authorId, signal.payload);
}
```

Choose `latest` for replaceable state and `all` for bounded FIFO delivery. Respect cancellation, expiration and the authenticated sender context supplied by Chronolog. Application payloads cannot claim another sender's identity.

## Independent runs and endpoints

Use signed stream identity for simultaneous runs. Select streams **before** the
subscription coalesces values; filtering a merged payload afterward can lose a
sibling run's last update.

```js
await session.signals.send('work.progress', { percent: 40 }, {
  ttlMs: 2000,
  stream: { streamId: runId, target: taskId },
});
for await (const update of session.signals.subscribe({
  topics: ['work.progress'],
  streams: [{ authorId: workerSigner, streamId: runId, target: taskId }],
  mode: 'latest', signal: stopped.signal,
})) renderProgress(update.payload);
```

The owner supplies each attachment's endpoint ID and incarnation. Signed author,
signal-session incarnation, topic, endpoint, stream and target all participate in
the latest-value key. An expiring stream does not expire another run. Selectors
restrict observation; a target is not a read grant or an execution claim.

## Reach, local echo and limits

Opening the session explicitly chooses `signals.delivery`: `neighbors` sends on
currently attached peer routes; `application` enables bounded forwarding with
deduplication. Inspect `session.signals.delivery` rather than assuming a sparse
graph is a broadcast network. Neither mode acknowledges every participant, stores
offline notifications or guarantees future delivery after a partition.

Use `signals.localEcho: true` when several local views should observe the owner's
verified sends without a remote round trip. Transport-only attachment and signal
use do not initialize the application data engine. Subscription and queue quotas
remain bounded per attachment and owner; quota errors affect that client and do
not convert dropped live progress into durable work. Save final results through
the application's guarded command path.

A live preview and its durable completion are separate operations. For example, drag previews may be replaced or lost; the final location is submitted as an ordinary application command with an operation ID. Stopping or disconnecting a signal source must not enqueue its expired previews into durable history.

Tendriller's control transport refuses `ephemeral/signal`. The host's allowed ephemeral action is the small connection invitation, which contains routing intent only. Live application signals travel through the session's authenticated peer transport. There is no built-in hosted signal channel or automatic role-based alternative.
