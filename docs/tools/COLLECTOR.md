# Machine collectors and training dashboards

The optional `tendril-stream` process collects data independently of the agent
conversation. It opens outbound HTTPS connections to Tendriller; the training
machine needs no public listener. It never holds an agent token and cannot
publish page files, execute browser code, or wake an agent. Its `tp_` credential
can append only to the custom streams granted when it was created.

## A working dashboard

Install the standalone collector and example with Node 22.15 or newer. These
files come from one immutable contrib release; no repository checkout or npm
dependencies are needed:

```sh
umask 077
curl -fL https://github.com/werg/tendriller-contrib/releases/download/v0.2.0-rc.3/manifest.json -o manifest.json
curl -fL https://github.com/werg/tendriller-contrib/releases/download/v0.2.0-rc.3/tendriller-tools-0.2.0-rc.3.tgz -o tools.tgz
# Verify tools.tgz against the manifest before extracting.
mkdir tendriller-tools
tar -xzf tools.tgz -C tendriller-tools
cp tendriller-tools/tools/collector/bin/tendril-stream.mjs ./tendril-stream.mjs
cp -R tendriller-tools/examples/training-dashboard ./dashboard
```

The downloaded page files are editable template source. The setup script
publishes them through the authenticated API:

```sh
TENDRILLER_SERVICE_BASE=https://tendriller.dev \
TENDRILLER_OWNER=you@example.com \
TRAINING_METRICS=/absolute/path/metrics.jsonl \
TRAINING_LOG=/absolute/path/training.log \
TRAINING_RUN=experiment-42 \
node dashboard/setup.mjs
```

Use an email verified by your GitHub or Google account. The setup script creates
a page with `mode:"dashboard"`, so an agent conversation listener is not required.
It creates three owner-readable streams:

| Stream | Policy | Input |
| --- | --- | --- |
| `machine.utilization` | Ephemeral | CPU, RAM, load average, optional NVIDIA GPU measurements |
| `training.metrics` | Durable | JSONL records with training step and numeric metrics |
| `training.logs` | Durable | Complete lines from a text log |

**Open the printed page URL and sign in to claim the page before starting the
collector.** Custom streams share a 1 MiB allowance while the page is unclaimed
and 8 MiB after claim. Starting a large backlog before claim can fill the smaller
allowance and leave the collector buffering. Then start collection:

```sh
node ./tendril-stream.mjs ./tendriller-training/collector.json
```

The ordinary page/account lifetime rules still apply; a long-running dashboard
should be made resident after claim with the existing lifetime API. A collector
heartbeat does not claim a page or keep an AI conversation available. From a
source checkout, use `node examples/training-dashboard/setup.mjs` and
`node tools/collector/bin/tendril-stream.mjs ./tendriller-training/collector.json` instead;
the configuration is the same.

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

## Initialize a collector for an existing page

The same downloaded helper can provision a collector for any existing page,
including an interactive page that also has an agent conversation. Save its
creation response (`api` and administrative `token`) in a private `page.json`,
then describe the streams and their sources together in `streams.json`:

```json
{
  "producer": "workstation-a",
  "spool_dir": "./spool",
  "streams": [
    { "name": "machine", "durability": "ephemeral" },
    { "name": "metrics", "durability": "durable" },
    { "name": "table", "durability": "durable", "max_records": 1 }
  ],
  "sources": [
    { "id": "host", "type": "host", "stream": "machine", "gpu": true },
    { "id": "training", "type": "jsonl", "stream": "metrics", "path": "./metrics.jsonl" },
    {
      "id": "table", "type": "command", "stream": "table",
      "command": ["python3", "snapshot.py"], "cwd": ".",
      "max_line_bytes": 1048576, "interval_ms": 30000
    }
  ]
}
```

```sh
node ./tendril-stream.mjs init --page ./page.json --streams ./streams.json --out ./private/collector.json
node ./tendril-stream.mjs ./private/collector.json
```

`init` validates the whole spec and existing resources before creating missing
streams and one named, scoped producer. It never creates a page or starts source
commands. Each stream uses the public `streamCreate` fields; each source uses
the collector options below. All declared streams must have a source, and all
sources must reference a declared stream. Source durability is derived from that
definition; an explicit conflicting value fails. The spec also accepts the
ordinary `max_spool_bytes` option. File paths and command `cwd` resolve relative
to the spec; `spool_dir` resolves relative to the output configuration.

Streams default to owner readers, with durable retention of 10,000 records and
86,400 seconds. An existing stream is reused only if its readers, durability and
both retention limits match exactly. A durable stream with `max_records:1`
automatically gives its sources a 192 KiB `max_record_bytes` limit; other streams
use 64 KiB and reject a larger configured limit. These limits include the record
envelope. Large JSON lines still require an explicit `max_line_bytes`, as above.
Source options such as field selection and flattening apply before the record
limit is checked.

The output path must be unused. The helper saves the producer credential
atomically with mode `0600` and prints only a summary with the configuration
path, producer name, and created/reused stream names. The administrative page
token stays in the input handle. An occupied producer name fails without
revocation or rotation, because its original credential cannot be retrieved.
Use its saved configuration or deliberately choose a new producer name and
output file. The helper also accepts the dashboard example's `page.json`, which
wraps the creation response under `handle`.

Provisioning uses separate API requests. A failed or lost response can leave
created resources; the helper reports partial setup and does not claim rollback.
If saving the final path fails after receiving a credential, it names a private
recovery file and states whether writing it completed. Recover that configuration
locally before retrying; a lost creation response may have created a producer
whose credential was never received. Existing matching streams can be reused,
but no existing file, stream policy or producer is silently replaced.

## Training records

Have the training job append and flush JSON lines to its normal metrics file:

```json
{"step":120,"loss":2.14,"learning_rate":0.0001,"tokens_per_second":38400}
{"step":121,"loss":2.09,"learning_rate":0.0001,"tokens_per_second":38610}
```

The collector reads complete lines independently. A job never waits for a
Tendriller request. `ts` may be an epoch-millisecond timestamp. The optional
envelope `{"ts":...,"type":"metrics","data":{...}}` is also accepted. Explicit
`source` and `run` values in the input data are preserved, including `null`, empty
strings, and other JSON values. When a key is absent, the collector supplies its
configured source `id`, and optional configured `run` **only if set**. A missing `run` remains absent (instead of injecting `run:null` into every record); explicitly supplied `run:null` is preserved. A file containing several runs
therefore keeps those run identities. These are application metadata; stream
authorization and the server-assigned producer identity are unchanged. The
collector does not parse text logs into chart values; emit numeric metrics explicitly.

### Select fields from an existing wide log

A JSONL source can read the training job's existing output directly, selecting
only the fields the dashboard needs before creating an upload record:

```json
{
  "id": "training-metrics",
  "type": "jsonl",
  "path": "/work/run/train.jsonl",
  "stream": "training.metrics",
  "durability": "durable",
  "max_line_bytes": 1048576,
  "fields": {
    "step": ["global_step"],
    "loss": ["metrics", "train/loss"],
    "tokens_per_second": ["throughput", "tokens_per_second"]
  },
  "run": "experiment-42"
}
```

`fields` maps output names to literal key paths. `["train.loss"]` selects one
key containing a period; `["train", "loss"]` selects a nested property. Numeric
segments address array indexes. For an envelope with `data`, paths start inside
`data`; otherwise they start at the whole JSON value. Missing paths are omitted,
and JSON values retain their types, including `null`. The original `ts` and
`type` envelope values are preserved. Input `source` and `run` are also carried
through even when they are not listed in `fields`; configured values fill absent
keys only. Those two names remain reserved as projection targets, so selecting
metrics cannot discard or rename run/source metadata. Projection is selection
and renaming only; it runs no expressions or application code. It works for file,
SSH, command, and host sources.

There can be 1–64 selected fields, each with at most 16 path segments. Input lines
default to 32 KiB. Set `max_line_bytes` from 1 KiB to 1 MiB when wider input is
expected. The output record, including its envelope, defaults to a 64 KiB limit.
Increasing the input limit does not increase output or storage limits. Larger
whole-table snapshots can set `max_record_bytes` explicitly as described below.
Omit both `fields` and `flatten` to preserve the existing complete record behavior.
Collector-generated diagnostics retain their reason and configured source/run
defaults; they bypass field selection, flattening, and a custom output limit.

### Flatten selected metric subtrees

For logs with many related metrics, select entire subtrees and flatten their
leaves instead of listing every metric path:

```json
{
  "id": "training-metrics",
  "type": "jsonl",
  "path": "/work/run/train.jsonl",
  "stream": "training.metrics",
  "durability": "durable",
  "max_line_bytes": 1048576,
  "fields": {
    "step": ["step"],
    "behaviour": ["behaviour"],
    "phase_s": ["phase_s"],
    "gain": ["gain"]
  },
  "flatten": { "max_fields": 120, "numeric_only": true }
}
```

`flatten` runs after `fields`; omit `fields` to flatten the whole input payload.
It walks own properties only and emits scalar leaves under dotted keys. Array
indexes become path segments, so a nested value at `["layers", 0, "gain"]` becomes
`layers.0.gain`. Empty objects and arrays contribute no leaves. A scalar input
uses the key `value`. Keys are visited in lexical order.

Literal periods and backslashes in a segment are escaped with a backslash.
The nested path `["train", "loss"]` becomes `train.loss`, while the single literal
key `["train.loss"]` becomes `train\.loss`. A literal backslash is doubled.
The reserved prototype segments `__proto__`, `constructor`, and `prototype` are
prefixed with a backslash: `constructor` becomes `\constructor`, while a literal
`\constructor` becomes `\\constructor`. These names remain valid stream data.
This keeps distinct paths distinct; output keys are literal JSON property names,
not expressions to evaluate.

`numeric_only:true` emits only finite JSON numbers. It does not convert strings,
booleans, or `null` into numbers. Omit it or set it to `false` to retain all scalar
JSON types. The original `source` and `run` values are always carried through
unchanged and are excluded from both flattening and the leaf count.

`max_fields` is required and must be 1–1024. This bound applies to the expanded
leaves, including `step` and every metric selected from the three subtrees, so
the example can select more than 64 metrics without listing their individual paths.
Output paths may contain at most 16 segments. Exceeding either bound rejects the
whole observation with `flatten_too_many_fields` or `flatten_too_deep`; metrics
are never silently truncated. Files and SSH emit a `collector_error` record and
can continue with the next line; a local command rejects that invocation.
The final serialized record must also fit its output byte limit.

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
defaults are five seconds for host samples and one second for files and commands. File sources (including `latest`)
require durable streams. The configured durability must agree with the server;
a mismatch stops the collector with queued records preserved.

Host sampling uses Node's CPU and memory counters. The initial CPU value is null
until a second sample establishes an interval. Optional GPU sampling invokes
`nvidia-smi` with a fixed read-only query and a three-second timeout. A missing
driver/tool reports `gpu_status:"unavailable"`; CPU and RAM collection continues.
This initial adapter does not collect per-process, disk, or network counters.

GPU fields retain actual zero readings, but unavailable measurements remain
`null`, including memory counters. An optional per-GPU `unavailable` object gives
the reason for each missing field:

```json
{
  "index": 0,
  "utilization_percent": 42,
  "memory_used_bytes": null,
  "memory_total_bytes": null,
  "temperature_c": 61,
  "unavailable": {
    "memory_used_bytes": "not_available",
    "memory_total_bytes": "not_available"
  }
}
```

Reasons are `not_available` for `N/A`, `not_supported` for an explicit
`[Not Supported]`, `not_reported` for an empty field, or `invalid_value` for
malformed/nonfinite numeric output. `gpu_status:"available"` means the query
returned GPU rows; individual fields can still be unavailable. Empty output
reports `gpu_reason:"no_devices_reported"`; a failed query reports
`gpu_reason:"query_failed"`.

Availability depends on the device, driver, and environment. The
[NVIDIA System Management Interface manual](https://docs.nvidia.com/deploy/nvidia-smi/index.html)
documents unsupported fields as `N/A` and explains that OS memory accounting can
affect reported GPU memory on NUMA systems. An absent counter does not identify
a shared/unified-memory architecture. Host RAM remains a separate measurement.
Consumers should check for `null` before converting bytes to GiB.

On known unified-memory hardware such as
[DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/known-issues.html), the GPU shares
system RAM and has no separate dedicated framebuffer total to add to RAM.
NVIDIA documents an unsupported GPU memory-usage counter on these systems.
Show that counter as unavailable, with its reason, and explain that GPU memory
is part of system RAM; the host RAM measurement is not GPU-only usage. The
training dashboard preserves `null` through unit conversion and displays the
reported reason instead of a misleading `0 GiB`.

## Periodic local commands and table snapshots

Use a `command` source for an existing local program that reports data, such as
a process inventory, disk status, job queue, or experiment summary:

```json
{
  "id": "processes",
  "type": "command",
  "command": ["python3", "/work/tools/process-snapshot.py", "--json"],
  "cwd": "/work",
  "interval_ms": 5000,
  "timeout_ms": 3000,
  "stream": "machine.processes",
  "durability": "durable",
  "max_line_bytes": 262144,
  "max_record_bytes": 196608,
  "fields": {"processes": ["processes"]}
}
```

The configured program emits JSONL, or one JSON value with no final newline.
For a table, emit one record containing the complete current table, for example
`{"type":"process_snapshot","data":{"processes":[{"pid":321,"cpu_percent":4.2}]}}`.
An empty `processes` array explicitly replaces the prior table with an empty one.
Use stable application keys such as a process identity for browser row updates.

For a table that must be available when a page opens, create its ordinary
durable stream with `max_records:1` and an appropriate `max_age_seconds`, then
read the latest snapshot and subscribe from its cursor:

```js
const name = "machine.processes";
const snapshot = await tendril.streams.latest(name);
let cursor = snapshot.cursor;
renderTable(snapshot.record?.data.processes ?? []);
tendril.streams.subscribe(name, record => {
  if (record.seq > cursor) {
    cursor = record.seq;
    renderTable(record.data.processes);
  }
}, {
  after: snapshot.cursor,
  onGap: () => {
    // The one retained record may have changed or expired. Reconcile the table.
    void tendril.streams.latest(name).then(current => {
      if (current.cursor >= cursor) {
        cursor = current.cursor;
        renderTable(current.record?.data.processes ?? []);
      }
    });
  },
});
```

The `after` cursor closes the gap between the initial read and subscription;
`onGap` reloads the current table when older history is no longer retained.
Each snapshot replaces the previous retained record. This provides
one last-known value for the whole stream, not a keyed database: include all
current rows in each record, and use a separate stream per independent snapshot.
Use an ephemeral stream when only currently connected subscribers need the
table. Its next snapshot will populate the view; it has no retained initial value.

Larger whole-table snapshots can use `max_record_bytes` from 1 KiB to 192 KiB
(196608 bytes); the default remains 64 KiB. Values above 64 KiB require a durable
source, and server records above 64 KiB are accepted only by a custom durable
stream configured with `max_records:1`. Set `max_line_bytes` separately to fit
the input JSON. The limit includes the collector's record envelope and metadata.
One larger snapshot is uploaded alone within the unchanged 256 KiB batch limit;
normal stream limits and aggregate retention quotas still apply. Oversized
observations fail explicitly rather than publishing a partial table.

The executable and every argument are passed directly to the operating system;
there is no implicit local shell. Pipes, redirects, and variable expansion are
literal arguments. `cwd` is optional and, like file paths, resolves relative to
the configuration file. Keep programs/configuration on the collector machine;
page data does not choose commands. `format:"log"` accepts text output instead.

An invocation has a ten-second default timeout, configurable with `timeout_ms`
from 100 to 300,000 milliseconds. Its stdout is limited to 1 MiB and 100 records.
A timeout, nonzero exit, excessive output, or shutdown discards that invocation's
partial result and reports a source status. The collector closes its stdout
reader and stops the command, escalating to SIGKILL after two seconds if needed.
On POSIX systems the command has its own process group, so cancellation also
stops ordinary descendants; elsewhere it terminates the direct child. An inherited
stdout pipe cannot prolong collector shutdown. No two invocations of
one source overlap, and a slow command does not block other source schedules.
The next interval obtains a fresh observation; failed command output cannot be
replayed. Once a successful durable snapshot enters the spool, its normal upload
retries preserve the same record ID. Command stderr is never included in records
or collector status output.

## Latest-value file snapshots

Use `type:"latest"` when an existing process **overwrites or atomically renames
one JSON file holding the current value** instead of appending JSONL. This
source polls, checks a bounded content hash against its last *committed*
checkpoint, and uploads one durable record only when the bytes change.
File updates never require the producer to call Tendriller.

```json
{
  "id": "current-job",
  "type": "latest",
  "path": "/work/run/status.json",
  "format": "json",
  "stream": "training.current",
  "durability": "durable",
  "interval_ms": 5000
}
```

Create `training.current` with `max_records:1` for one retained current
value. A `latest` source also supports `format:"text"` for a plain-text
file, creating a `snapshot` record with `data.value`. JSON files are
parsed using the same record options (`fields`, `flatten`, optional `run`)
as JSONL sources; wrapped `{ts,type,data}` is supported. The default is
JSON. If no `run` is present in either source configuration or input, it is
**omitted**, not emitted as null.

An unchanged, empty, missing, malformed or oversized file is handled
explicitly: unchanged bytes produce no duplicate; an empty file produces
no new record; missing files report `waiting_for_file`; malformed or oversized
snapshots generate one `collector_error` per changed content. Input is
bounded by `max_line_bytes`. The local spool persists each snapshot and its
content digest atomically before upload; server deduplication still uses the
normal record ID and retention rules. Because this is a current-value
snapshot, intermediate overwrites between polls are intentionally not replayed.
Prefer atomic rename over writing in place to avoid transient partial JSON.
If the file is regenerated with exactly the same bytes, no new record is
needed. `max_records:1` gives the browser a stable `streams.latest()` read.

## Remotes without Node.js

**Only the collector machine needs Node.js.** A remote Linux/macOS host can
expose existing logs through OpenSSH without installing Node there:

```json
{
  "id": "remote-log",
  "type": "ssh",
  "stream": "training.logs",
  "durability": "durable",
  "host": "training-host",
  "command": ["tail","-n","0","-F","/var/log/training.log"],
  "format": "log"
}
```

Use a preconfigured SSH key and a verified host key (see the SSH section
below). This is a **live** feed: reconnect gaps cannot recover lines lost
while SSH was unavailable. For reliable replay, copy/rsync the remote
retained JSONL to a *local* file and use a `jsonl` source, or mirror a
remote atomically replaced snapshot and use `latest` on that local path.
Do not blindly pipe untrusted remote shell syntax into a command; explicit
SSH arguments and local credentials should be controlled by the operator.

## SSH sources

The local collector can launch a configured read-only command on another host
using its existing SSH access. For example, install the same helper on a training
machine and add:

```json
{
  "id": "gpu-worker-2",
  "type": "ssh",
  "host": "trainer@gpu-worker-2",
  "command": ["node", "/opt/tendriller/tendril-stream.mjs", "--sample", "5000", "--gpu"],
  "stream": "machine.utilization",
  "durability": "ephemeral"
}
```

`--sample` emits JSONL to stdout and uses no Tendriller credential on the remote
machine. The main collector adds the source identity and publishes it through
its local producer token. A command can instead emit training JSONL, or set
`format:"log"` for text lines. The same `fields`, `flatten`, `max_line_bytes`, and
`max_record_bytes` options apply. SSH is one live session, while a local `command` is one finite
observation per interval. `port` is optional. Use an SSH config alias for
ProxyJump or identity settings.

SIGINT/SIGTERM cancels a blocked stdout drain and discards pending live sample
output, so a remote reader that stops consuming cannot hold the helper open.

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
- **Input limits:** file lines above the configured `max_line_bytes` and malformed
  JSON produce explicit `collector_error` records. SSH reports `line_too_large`
  and discards that line; a bounded command rejects the whole observation if its
  line or output limit is exceeded. The next complete valid line can be read.
  Partial UTF-8 file/SSH lines wait for their newline. Rename,
  truncation, and copytruncate/regrowth are detected using file identity, size,
  and a checkpoint boundary fingerprint derived from the same captured bytes as
  the records. A concurrent replacement cannot supply a new fingerprint for old
  records.
- **Retries:** requests time out after ten seconds. Transient failures retry with
  backoff up to 30 seconds. A rejected credential, missing stream, invalid data,
  or conflicting ID stops collection and preserves queued durable work for
  diagnosis. Server 429 and 413 responses retry because rate/storage limits can
  recover. Queue order is preserved; a blocked durable stream can delay others.

### Retention sizing

If your sample frequency is one record every `S` seconds and you want `H`
hours of history, estimate `ceil(H × 3600 / S)` records. Multiply by a
measured average input record size for the approximate retained byte use.
Example: a 2-hour lookback at 10-second intervals requires at least 720
records, and 400-byte input records total about 288 KiB plus envelopes.
Choose `max_records` slightly above that count for jitter, and
`max_age_seconds` around 7200 (plus margin). The service also enforces
per-stream, page-wide and unclaimed/claimed storage limits; none of these
settings guarantees that an older observation survives aggregate pressure.
The same authoritative recipe lives in the served core
[`STREAMS.md`](https://tendriller.dev/docs/STREAMS.md).

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
ExecStart=/usr/bin/node /opt/tendriller/tendril-stream.mjs /home/you/tendriller-training/collector.json
Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=default.target
```

SIGINT/SIGTERM abort outstanding requests, stop command and SSH children, preserve durable
work, and release the spool lock. Status changes are JSON lines on stderr with
source, state, and timestamp. Network responses, credentials, and remote stderr
are never copied into those notices. Check `spool_full`, `buffering`,
`waiting_for_file`, `gpu_unavailable`, `command_timeout`, `command_failed`,
`command_output_too_large`, `spool_full_command_gap`, and SSH gap states in the service log.

## Source adapter boundary

Source readers live in `cli/lib/stream-sources/`. Each adapter owns its input
resources, parsing, and health notices. The collector coordinates scheduling,
bounded buffering, upload acknowledgements, and retry timing.

| Adapter | Collection | Replay capability | Checkpoint |
| --- | --- | --- | --- |
| Host | Periodic sample | None; each sample observes the current machine | None; CPU interval counters are local sampling state |
| JSONL/text file | Bounded read | Can reread input while the source file is retained | Proposed file identity, byte offset, boundary fingerprint |
| Latest-value file | Bounded current JSON/text snapshot | No intermediate overwrite replay; unchanged snapshot deduplicated | Proposed content digest |
| Local command | Periodic finite command | None; the next invocation is a fresh observation | None |
| SSH | One live command session | None; reconnect can miss remote output | None |

These capabilities describe the **input source**, independently of the
destination stream's `durability`. A durable SSH stream stores records that
arrive; it cannot recover output lost before arrival. An ephemeral destination
never makes its samples enter the disk spool.

The small adapter interface is documented in `stream-sources/index.mjs`:
`read()` returns a polled batch, or `stream()` yields batches for one live session;
both report source health, and `close()` releases active resources. Adapters do
not own credentials, uploads, persistence, or retry loops. A file reader merely
proposes a checkpoint. The collector commits it atomically with the records, and
can retry a smaller prefix when a batch will not fit a small spool. Failed SSH
input is reported as a gap rather than treated as replayable file input.

Tests: `node --test cli/test/stream-collector.test.mjs` exercises lost
acknowledgements/restart, bounded atomic checkpoints, ephemeral nonpersistence,
UTF-8 and rotation, SSH argument safety, lock ownership, invalid acknowledgements,
and process shutdown. `node --test cli/test/stream-sources.test.mjs` covers adapter
capabilities, file resume, host sampling state and GPU availability, bounded SSH input and cancellation,
and live-input backpressure. `node --test cli/test/stream-source-options.test.mjs`
covers large-line projection, bounded subtree flattening and path escaping,
larger snapshot uploads, split UTF-8, command argument boundaries,
finite output/timeout/cancellation, and concurrent source scheduling with durable
recovery. Adapter tests use a fake SSH child and host sampler, plus
small local Node commands; they do not contact a real GPU or SSH host.
