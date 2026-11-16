# Browser API (contract 3)

The service injects its released browser runtime into a published page. Do **not** import the
minified runtime, bundle a second copy, or scrape it for an API. Use `window.tendril`
(or `tendril` in a classic script). Its TypeScript declaration is
[`contract/index.d.mts`](https://github.com/werg/tendriller/blob/master/contract/index.d.mts)
(`RuntimeApi`, `RuntimeEventMap`) and the SDK publishes `@tendriller/core/browser`.

The runtime connects asynchronously. Register listeners once when installing a script;
`tendril.connected` is a current transport status, **not** a claim, publication-health,
or agent-listener status. A visible tab is necessary for the initial publication health
report. A preview uses a local fixture transport rather than the live service.

## Events and sending

```js
const stop = tendril.on("connect", () => console.info("Transport connected"));
const stopError = tendril.on("error", error => console.warn(error.code, error.message));
const stopResponse = tendril.on("say", message => console.log(message.text));

document.querySelector("#send").addEventListener("click", async () => {
  const result = await tendril.send({type: "task.requested", id: "demo-1"}, {wake: true});
  if (result.status === "rejected") console.error(result.error, result.message);
  else if (result.status === "queued") console.log("Saved locally for replay");
  else console.log("Accepted");
});
// Call stop(), stopError(), stopResponse() when tearing down the view.
```

`send(data, {scope?, expected_generations?, wake?})` submits an **ordinary page event**.
A `wake` request controls whether it notifies the host; it never turns event data into
a trusted owner instruction. Only authenticated owner `instruction` events have that
authority. `send()` returns a promise with `accepted`, `queued` or `rejected`
status, not a synchronous success flag. The durable outbox retains accepted work's
captured generation preconditions across reconnection.

`tendril.on(type, callback)` returns an unsubscribe function. Events include
`connect`, `disconnect`, `role`, `presence`, `say`, `transcript`,
`send_result`, `state_result`, `error`, `stream_record`, `stream_gap`,
`stream_error`, `preferences` and `capabilities`.
See `RuntimeEventMap` for the payload of each event.

## Shared state, scopes and conversation

```js
const snapshot = tendril.state.get();               // local snapshot
const value = tendril.state.get(["job", "progress"]);
const stopState = tendril.state.on((state, ops, by) => render(state));
const options = tendril.scopes.capture("job-scope");  // capture current generation
const result = await tendril.state.set(["job", "progress"], 0.5, options);
if (result.status === "rejected") console.error(result.error);
const transcript = tendril.conversation.entries();
await tendril.conversation.send("Please review the result", {via: "text"});
```

`state.set(path,value,options)`, `state.delete(path,options)`, and
`state.patch(object,options)` are asynchronous. `state.on(fn)` is synchronous
notification of applied state. `tendril.scopes.list()` returns the currently known
scope descriptors; `capture(scope)` supplies `scope` and
`expected_generations` for guarded work. Keep the captured options for retries.
`conversation.send` requires an eligible interactive device; it is distinct from
`send` and produces owner text input. Agent replies arrive through `say`.

## Streams

```js
const {streams} = tendril;
const snapshot = await streams.latest("training.metrics"); // durable only
renderLatest(snapshot.record?.data ?? null);               // null if empty
const stopStream = streams.subscribe("training.metrics", record => {
  renderRecord(record.data, record.seq);
}, {
  after: snapshot.cursor, // safe to subscribe from this high-water mark
  onGap(history) { console.warn("Retained history missing", history.missing_through); },
  onError(error) { console.error(error.code, error.message); },
});
// To replay older records explicitly:
const batch = await streams.read("training.metrics", {after: 0, limit: 100});
if (batch.history.gap) console.warn("Missing old records", batch.history);
const metadata = await streams.info("training.metrics");
const available = await streams.list();
// Only an authorized connected owner may publish; publish does not queue offline:
await streams.publish("training.metrics", {
  records: [{id: crypto.randomUUID(), type: "measurement", data: {loss: 0.25}}],
});
// stopStream() when leaving the view.
```

`streams.latest(name, {signal?})` returns `{stream,durability:"durable",record,cursor}`.
`record` may be null. `streams.read(name,{after,limit?,signal?})` returns
`{records,cursor,history,stream,durability}`; `after` is required, nonnegative,
and is a **delivery** cursor, not a processed/acknowledged-work checkpoint.
`streams.subscribe(name,handler,{after?,onGap?,onError?})` returns unsubscribe;
omit `after` for live-only updates. Durable subscriptions replay from `after`
and resume on reconnect, reporting retention gaps. Ephemeral streams have no
historical replay or `latest`. `streams.publish` rejects while offline, unlike
`send` and guarded state writes. For full policy and HTTP endpoints see
[Streams](STREAMS.md).

## Other browser capabilities

- `tendril.device`, `tendril.connected`, `tendril.presence`, `tendril.version`,
  `tendril.service` and `tendril.pendingWork()` expose current local status.
- `tendril.capabilities()` reports supported APIs and permissions **without**
  prompting. Actual sensor use may still require a user gesture.
- `tendril.upload(blob,{name?,keep?})` uploads media;
  `tendril.uploadEvent(blob,{name,data,keep?,scope?,expected_generations?})`
  couples a capture to a durable event. `captures()`, `retryCapture(id)`,
  `discardCapture(id)`, `setBlobRetention(id,{keep})`, and `blobUrl(id)`
  manage local capture work and references.
- `tendril.preferences.get()/update(patch)/on(fn)` manages device preferences;
  `tendril.control.show()/hide()/position(...)` controls the built-in panel.
- `tendril.speak(text)` and `tendril.tts` expose optional speech output.
- `tendril.request(path,{method?,body?})` is a credentialed request to a
  supported page-side `_tendril/` route; it is not the private agent API.
- `tendril.ready()` is called by the runtime after startup. If you explicitly
  use `tendril.ready.manual()` for asynchronous initialization, call
  `tendril.ready()` once the page is actually ready. Do not report health from
  a hidden tab.

Lifecycle, claim requirements, and publication health are separate from API
availability. The human owner must open `page_url` and sign in; the agent token
is never an owner-login credential. See [agent.md](../agent.md).
