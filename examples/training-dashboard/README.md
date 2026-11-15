# Training observatory

Create an authenticated dashboard, three streams, and a scoped local collector
configuration with Node.js 22.15+. No repository checkout or npm install is
needed. Download the helper and the complete example from the service:

```sh
curl -fsS https://tendriller.dev/tendril-stream.mjs -o tendril-stream.mjs
mkdir -p dashboard
for file in setup.mjs index.html app.js model.mjs; do
  curl -fsS "https://tendriller.dev/examples/training-dashboard/$file" -o "dashboard/$file"
done
```

Then create and publish the page:

```sh
TENDRILLER_SERVICE_BASE=https://tendriller.dev \
TENDRILLER_OWNER=you@example.com \
TRAINING_METRICS=/work/run/metrics.jsonl \
TRAINING_LOG=/work/run/training.log \
TRAINING_RUN=run-42 \
node dashboard/setup.mjs
```

**Open the printed URL and sign in to claim the page before starting collection.**
Custom stream retention is 1 MiB while unclaimed and 8 MiB once claimed. Edit the
source paths and run name in the private collector configuration, then run:

```sh
node tendril-stream.mjs ./tendriller-training/collector.json
```

Rerunning setup with the same owner/service and output directory reuses its
saved page and producer configuration. Keep `page.json`, `collector.json`, and
the spool private. In a checkout, run `node examples/training-dashboard/setup.mjs`
and `node cli/bin/tendril-stream.mjs` with the same configuration instead.

This example uses `mode:"dashboard"` for a passive page. **Interactive pages
support the same streams together with conversation.** For a conversational
dashboard, create an interactive page and attach its host receiver before
publishing these source files. Stream uploads never wake the conversation or
mark the agent as attentive. They extend an ad-hoc dashboard's idle lifetime;
for an unattended interactive dashboard, use residency or keep its conversation
receiver active.
Machine data here is ephemeral. Training metrics and logs are durable with a
bounded replay window. Page code needs no producer or agent credential.

`app.js` demonstrates subscriptions, retained-history catchup, gap reporting,
bounded chart/log views, and stale machine data. It uses the reusable
`_tendril/snippets/chart.js` chart module. Its charts accept flat numeric
fields such as `{"step":1,"loss":2.1}` or a nested `metrics` object. All log data
is inserted with `textContent`.

See [Collector documentation](../../docs/COLLECTOR.md) for file formats, SSH,
supervision, retry/retention semantics, and failure boundaries.
