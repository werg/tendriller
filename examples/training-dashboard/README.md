# Training observatory

Run `setup.mjs` from the repository root to create an authenticated passive
dashboard, three streams, and a scoped local collector configuration:

```sh
TENDRILLER_OWNER=you@example.com \
TRAINING_METRICS=/work/run/metrics.jsonl \
TRAINING_LOG=/work/run/training.log \
TRAINING_RUN=run-42 \
node examples/training-dashboard/setup.mjs

node cli/bin/tendril-stream.mjs ./tendriller-training/collector.json
```

Open the printed URL to claim the dashboard. Add `mode:"dashboard"` when building
your own passive pages; conversational pages retain the existing wake-listener
requirement. Machine data is ephemeral. Training metrics and logs are durable
with a bounded replay window. The page needs no producer or agent credential.

`app.js` demonstrates subscriptions, retained-history catchup, gap reporting,
bounded chart/log views, and stale machine data. Its charts accept flat numeric
fields such as `{"step":1,"loss":2.1}` or a nested `metrics` object. All log data
is inserted with `textContent`.

See [Collector documentation](../../docs/COLLECTOR.md) for file formats, SSH,
supervision, retry/retention semantics, and failure boundaries.
