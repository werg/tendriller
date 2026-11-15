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

Machine data here is ephemeral. Training metrics and logs are durable with a
bounded replay window. Page code needs no producer or agent credential.

`app.js` demonstrates subscriptions, retained-history catchup, gap reporting,
bounded chart/log views, and stale machine data. It uses the reusable
`_tendril/snippets/chart.js` chart module. Its charts accept flat numeric
fields such as `{"step":1,"loss":2.1}` or a nested `metrics` object. All log data
is inserted with `textContent`.

## Use the same dashboard with a conversation

The `setup.mjs` shortcut creates a passive `mode:"dashboard"` page. **An
interactive page supports these same streams and the built-in conversation
control together.** No chat implementation or extra stream is needed: keep the
page's Tendriller control visible, handle owner instructions through your host
receiver, and reply with `say`. Stream uploads do not wake the conversation or
mark the agent as attentive.

For example, with the [optional `tendril` CLI](../../cli/README.md) installed:

```sh
tendril new "Training conversation" --server https://tendriller.dev \
  --owner you@example.com --mode interactive --as training-chat
```

The CLI saves the private handle to `~/.config/tendril/training-chat.json` by
default. Attach that handle to the intended conversation using the
[host receiver guide](../../agent.md#attach-a-host-receiver), and verify its two
delivery probes. For long-running Claude Code sessions, prefer the channel when
available; a `Monitor` watch requires periodic model turns to re-arm it.

Save this spec as `streams.json`, adjusting file paths and retention to your run:

```json
{
  "producer": "training-host",
  "streams": [
    {"name": "machine.utilization", "durability": "ephemeral"},
    {"name": "training.metrics", "durability": "durable", "max_records": 3000},
    {"name": "training.logs", "durability": "durable", "max_records": 1000}
  ],
  "sources": [
    {"id": "host", "type": "host", "stream": "machine.utilization", "gpu": true},
    {"id": "metrics", "type": "jsonl", "stream": "training.metrics",
      "path": "/work/run/metrics.jsonl", "run": "run-42"},
    {"id": "logs", "type": "log", "stream": "training.logs",
      "path": "/work/run/training.log", "run": "run-42"}
  ]
}
```

Provision the collector, then publish the downloaded dashboard files:

```sh
node tendril-stream.mjs init --page ~/.config/tendril/training-chat.json \
  --streams streams.json --out private/collector.json
tendril --tendril training-chat push ./dashboard
```

Have the owner open the page and sign in **before** starting collection. For an
unattended interactive dashboard, make the claimed page resident, then run:

```sh
tendril --tendril training-chat meta --lifetime resident
node tendril-stream.mjs private/collector.json
```

Residency keeps the page; the host receiver must still be running for live
replies. The equivalent HTTP creation/upload flow is in `agent.md`; the collector
initializer accepts its private creation-response file directly too. Keep that
handle, the collector configuration and spool outside the uploaded `dashboard`
directory. Use a fresh page for this recipe: mode and stream policies are
immutable, and `init` rejects conflicting existing policies or producer names.

## Retention and unavailable measurements

Before keeping several runs, estimate bytes per record × retained steps × runs
and add the log/event windows. All custom streams share 8 MiB and 20,000 retained
records after claim. See the [sizing recipe](../../docs/STREAMS.md#size-the-retained-window-before-collecting)
for envelope overhead, per-stream limits and aggregation. The chart's 2,000-point
view and optional smoothing do not reduce server retention.

An unavailable GPU reading displays `—` with the collector's reason, including
after conversion from bytes to GiB. On known unified-memory hardware such as
[DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/known-issues.html), GPU memory is
part of system RAM; do not interpret an unsupported dedicated-memory counter as
zero GPU memory or add a separate VRAM total to RAM. An `N/A` counter alone does
not identify the architecture, and host RAM usage is not GPU-only usage.

See [Collector documentation](../../docs/COLLECTOR.md) for file formats, SSH,
supervision, retry/retention semantics, and failure boundaries.
