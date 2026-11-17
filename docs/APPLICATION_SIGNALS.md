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

Choose `latest` for replaceable state and bounded FIFO delivery for observations that need ordering within a live session. Respect cancellation, expiration and the authenticated sender context supplied by Chronolog. Application payloads cannot claim another sender's identity.

A live preview and its durable completion are separate operations. For example, drag previews may be replaced or lost; the final location is submitted as an ordinary application command with an operation ID. Stopping or disconnecting a signal source must not enqueue its expired previews into durable history.

Tendriller's control transport refuses `ephemeral/signal`. The host's allowed ephemeral action is the small connection invitation, which contains routing intent only. Live application signals travel through the session's authenticated peer transport. There is no built-in hosted signal channel or automatic role-based alternative.
