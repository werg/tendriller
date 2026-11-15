# Machine collectors and training dashboards

The optional `tendril-stream` process collects data independently of the agent
conversation. It opens outbound HTTPS connections to Tendriller; the training
machine needs no public listener. It never holds an agent token and cannot
publish page files, execute browser code, or wake an agent. Its `tp_` credential
can append only to the custom streams granted when it was created.

## A working dashboard

From a checkout, with Node 22.15 or newer:

```sh
TENDRILLER_OWNER=you@example.com \
TRAINING_METRICS=/absolute/path/metrics.jsonl \
TRAINING_LOG=/absolute/path/training.log \
TRAINING_RUN=experiment-42 \
node examples/training-dashboard/setup.mjs

node cli/bin/tendril-stream.mjs ./tendriller-training/collector.json
```

Use an email verified by your GitHub or Google account. The setup script creates
a page with `mode:"dashboard"`, so an agent conversation listener is not required.
It creates three owner-readable streams:

| Stream | Policy | Input |
| --- | --- | --- |
| `machine.utilization` | Ephemeral | CPU, RAM, load average, optional NVIDIA GPU measurements |
| `training.metrics` | Durable | JSONL records with training step and numeric metrics |
| `training.logs` | Durable | Complete lines from a text log |

Open the printed page URL to claim the page. The ordinary page/account lifetime
rules still apply; a long-running dashboard should be made resident after claim
with the existing lifetime API. A collector heartbeat does not claim a page or
keep an AI conversation available.

The dashboard displays machine freshness, a selectable training chart, and a
bounded log tail. Durable subscriptions load retained history and resume from a
cursor; ephemeral subscriptions start with the next live sample. Charts retain
the latest 2,000 metric records in the browser and the log view retains 200 lines.
A history-gap banner identifies missing server history. No data is fabricated
when the producer is absent.

`tendriller-training/page.json` contains the administrative agent handle;
`collector.json` contains the restricted producer credential. The script creates
both with mode `0600`. Run it again to republish the dashboard while preserving
the collector's configuration. It does not print either credential. Set
`TENDRILLER_DASHBOARD_DIR` to use a different private directory or
`TENDRILLER_SERVICE_BASE` for a self-hosted service.

## Training records

Have the training job append and flush JSON lines to its normal metrics file:

```json
{"step":120,"loss":2.14,"learning_rate":0.0001,"tokens_per_second":38400}
{"step":121,"loss":2.09,"learning_rate":0.0001,"tokens_per_second":38610}
```

The collector reads complete lines independently. A job never waits for a
Tendriller request. `ts` may be an epoch-millisecond timestamp. The optional
envelope `{"ts":...,"type":"metrics","data":{...}}` is also accepted. The
collector adds the configured `source` and `run` to each record's data. It does
not parse text logs into chart values; emit numeric metrics explicitly.

## Configuration

```json
{
  "api": "https://tendriller.dev/api/t/abcdefghijkl",
  "token": "<scoped producer credential>",
  "spool_dir": "./spool",
  "max_spool_bytes": 16777216,
  "sources": [
    {
      "id": "local-machine",
      "type": "host",
      "stream": "machine.utilization",
      "durability": "ephemeral",
      "interval_ms": 5000,
      "gpu": true
    },
    {
      "id": "training-metrics",
      "type": "jsonl",
      "stream": "training.metrics",
      "durability": "durable",
      "path": "/work/run/metrics.jsonl",
      "run": "experiment-42"
    }
  ]
}
```

Paths are resolved relative to the configuration file. Source IDs must be unique.
Configure at most 32 sources. Poll intervals are 500–3,600,000 milliseconds;
defaults are five seconds for host samples and one second for files. File sources
require durable streams. The configured durability must agree with the server;
a mismatch stops the collector with queued records preserved.

Host sampling uses Node's CPU and memory counters. The initial CPU value is null
until a second sample establishes an interval. Optional GPU sampling invokes
`nvidia-smi` with a fixed read-only query and a three-second timeout. A missing
driver/tool reports `gpu_status:"unavailable"`; CPU and RAM collection continues.
This initial adapter does not collect per-process, disk, or network counters.

## SSH sources

The local collector can launch a configured read-only command on another host
using its existing SSH access. For example, install the same helper on a training
machine and add:

```json
{
  "id": "gpu-worker-2",
  "type": "ssh",
  "host": "trainer@gpu-worker-2",
  "command": ["node", "/opt/tendriller/cli/bin/tendril-stream.mjs", "--sample", "5000", "--gpu"],
  "stream": "machine.utilization",
  "durability": "ephemeral"
}
```

`--sample` emits JSONL to stdout and uses no Tendriller credential on the remote
machine. The main collector adds the source identity and publishes it through
its local producer token. A command can instead emit training JSONL, or set
`format:"log"` for text lines. `port` is optional. Use an SSH config alias for
ProxyJump or identity settings.

Hosts and command arguments are configured locally, never supplied by a page.
Arguments are individually quoted for the remote shell. SSH uses batch mode,
strict host-key checking, connection timeout, and keepalives. Establish the host's
known-host entry and noninteractive authentication beforehand. Password prompts
and automatic host-key acceptance are intentionally unavailable. SSH keys stay
on the collector machine.

SSH reconnects with bounded exponential backoff. This adapter is a live reader:
an SSH disconnection or a full local spool can lose remote output, and emits an
explicit `ssh_disconnected_gap` or `spool_full_ssh_gap` status. It cannot recover
output produced while disconnected. For remote history that must replay, run a
collector on that machine with its own local spool and a separately scoped
producer credential, or use a remote command that resumes from its own durable
checkpoint. Do not pipe the training process itself through this SSH connection.

## Delivery and retention

- **Durable:** records and file offsets are committed together to a bounded local
  outbox before upload. Atomic replacement and fsync preserve the outbox across
  process restarts. IDs survive retries after a lost acknowledgement. The server
  deduplicates by stream, producer, and ID while the original record is retained.
- **Ephemeral:** only the latest pending sample per source is held in memory. A
  failed upload is discarded and no payload is written to disk. There is no
  replay after a disconnect or restart.
- **Backpressure:** the default spool is 16 MiB, configurable from 64 KiB to
  64 MiB. A full spool stops advancing file offsets; it does not block or modify
  the training job. File rotation/deletion during a prolonged outage can still
  remove data before collection. Rotated filenames are not followed after rename;
  the collector starts reading the replacement file.
- **Input limits:** lines above 32 KiB and malformed JSON produce explicit
  `collector_error` records. Partial UTF-8 lines wait for their newline. Rename,
  truncation, and copytruncate/regrowth are detected using file identity, size,
  and a checkpoint boundary fingerprint.
- **Retries:** requests time out after ten seconds. Transient failures retry with
  backoff up to 30 seconds. A rejected credential, missing stream, invalid data,
  or conflicting ID stops collection and preserves queued durable work for
  diagnosis. Server 429 and 413 responses retry because rate/storage limits can
  recover. Queue order is preserved; a blocked durable stream can delay others.

Retention is bounded at both ends. The example retains at most 10,000 records or
24 hours per durable stream, whichever is reached first. A retry after server
retention has removed its original ID can be appended again. This is not an
exactly-once or unlimited-history guarantee. Adjust retention to the sampling
rate and use an external archive for long experiments.

One process owns a spool directory. A lock rejects a second process. After an
unclean crash, inspect `collector.lock`, verify that its PID is stopped, and remove
only that lock before restarting; preserve `outbox.json`. Automatic stale-lock
removal is avoided because concurrent restart attempts could otherwise remove
each other's new lock and corrupt the outbox. A spool is bound to the service and
producer credential. Revoking/replacing that credential requires an explicit
decision about old queued work and a new spool directory, rather than silently
republishing old records as a different producer.

## Supervision and status

For unattended training, supervise the process with your service manager. Example
Linux user unit (replace both absolute paths):

```ini
[Unit]
Description=Tendriller machine collector
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/tendriller/cli/bin/tendril-stream.mjs /home/you/tendriller-training/collector.json
Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=default.target
```

SIGINT/SIGTERM abort outstanding requests, stop SSH children, preserve durable
work, and release the spool lock. Status changes are JSON lines on stderr with
source, state, and timestamp. Network responses, credentials, and remote stderr
are never copied into those notices. Check `spool_full`, `buffering`,
`waiting_for_file`, `gpu_unavailable`, and SSH gap states in the service log.

Tests: `node --test cli/test/stream-collector.test.mjs` exercises lost
acknowledgements/restart, bounded atomic checkpoints, ephemeral nonpersistence,
UTF-8 and rotation, SSH argument safety, lock ownership, invalid acknowledgements,
and process shutdown. It does not contact a real GPU or SSH host.
