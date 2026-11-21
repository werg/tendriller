# Network qualification lab

This lab uses a disposable Linux Docker network namespace. It never changes the
host firewall, publishes a host port, or touches permanent reviewer/idle-soak
processes. `NET_ADMIN` is granted only to that container. Run it on a disposable
CI worker if local Docker policy prohibits that capability.

```sh
node --test test/e2e/network-qualification/*.test.mjs
docker build -t tendriller-network-lab:playwright-1.65 test/e2e/network-qualification
node test/e2e/network-qualification/run.mjs --output /absolute/new-evidence-directory --node-binary /absolute/node24
node test/e2e/network-qualification/run.mjs --browser-controls --output /absolute/new-browser-evidence-directory --node-binary /absolute/node24
```

The packet-control probe exercises real IPv4 **and** IPv6 UDP echo before,
during, and after an OUTPUT firewall block. DNS remains permitted, and real TCP
echo must continue during the block. Real `tc netem` qdiscs on `lo` and `eth0` apply
60 ms delay and 1% random loss. The probe requires an observed delayed TCP
exchange and removes its own rules. Noble's iproute2 has no netem seed option;
loss selection is stochastic. This covers local host and outgoing reflexive paths
in the default single-bridge Docker namespace; custom multi-interface layouts are
not qualified. UDP blocking is deterministic. Unsupported IPv6,
firewall, qdisc or Docker privileges fail the probe rather than produce a pass.
The container is bounded to two CPUs and 7 GiB; execution is bounded to 90 seconds.
The image is based on a digest-pinned Playwright image. The selected Node binary
is mounted read-only; its actual version is recorded.

`control-probe.json` is **packet-controls-only** evidence. It does not qualify
application recovery or imply that an application used the relay. A successful
UDP block is not evidence of symmetric/carrier NAT, public NAT traversal or TURN.
The two application participants must both run inside the lab namespace for its
firewall to govern their RTC paths. A relay test must retain the real RTC
constructors; the existing first-app synthetic RTC exception is a separate test.

Application integration consumes a restored immutable first-app kit and verifies
its source, composition, runtime and archive hashes using the maintained
first-app verifier. It must not rebuild release bytes. The recovery scenario
starts with blocked UDP and authenticated relay traffic, restores UDP, triggers a
real browser online/network-change/visible-pageshow event and waits for
authenticated direct traffic. The application controller, rather than the test,
owns `reconsiderConnections()` and its per-peer cooldown. Qualification must
retain commands, camera/signal work, saved operation identity and reload checks.
The old79 graph predates this recovery API; it cannot qualify that transition.

With a clean restored graph containing the recovery API, run the complete suite
once against the same retained test application:

```sh
node test/e2e/network-qualification/run.mjs --artifact-root /absolute/qualified-root --profile suite --output /absolute/new-application-evidence-directory --node-binary /absolute/node24
```

Available individual profiles are `relay-upgrade`, `offline`, `impaired`,
`freeze`, `background`, and `idle`. The complete ordinary first-app qualification
runs first with all existing assertions, then the selected faults run before
native shutdown. The round trip starts on authenticated direct transport, blocks
real UDP, exposes the loss with a disposable real signal request, requires a
relay carrying real application work, restores UDP and observes a browser
NetworkInformation change before requiring authenticated direct traffic. No test
calls `reconsiderConnections()` or fabricates an RTC failure. Native transport
waits subscribe to `onStatus`/`connectionRevision`; they do not poll an idle host.
The offline case additionally partitions application TCP port 8790, waits for an
actual authenticated-link loss, restores packets and requires a direct session.
DevTools control remains accessible so restoration does not depend on a healthy
application connection. The control probe verifies this TCP partition separately.

Every supported profile requires native and browser commands, remote applied
reads, exact retained operation IDs, real signal request/reply and encrypted PNG
sensor evidence, then reload and further application work. The PNG and native
inference result are deterministic fixtures, not physical camera/model-provider
qualification. Direct work and reopen must add zero host relay payload. A profile
that cannot actually background/freeze the browser fails qualification.
The lab uses an owned headed Chromium under Xvfb. It attaches to its ephemeral
default context with `connectOverCDP({noDefaults:true})`, because ordinary
Playwright focus emulation can suppress visibility and freeze transitions. Actual
freeze/resume event handlers and paused timer counts are checked by the browser
control probe. The lab creates no persistent browser profile.

`.github/workflows/network-controls.yml` runs unit and real control probes on
changes. `.github/workflows/network-qualification.yml` is the application CI job:
`service.yml` calls it after `artifacts` and requires its success before publication.
It receives the exact product `source` and artifact job's `manifest_sha256`.
Alternatively dispatch it with the artifact run ID, exact source and manifest hash.
It restores that run's `public-packages`,
binds the manifest source, and runs `--profile suite`; it never builds product
bytes. Harness checkout source and restored product source are distinct. The
graph must include the recovery API before this required gate can succeed.
Both workflows are unprivileged and receive no deployment credentials.

Application execution is bounded to 25 minutes plus the requested idle interval
for each selected profile (six intervals for `suite`).
`--idle-ms` selects an exact requested observation duration (default 15000,
minimum 1000, maximum 48 hours) for each profile. Reports retain actual elapsed
time and all overruns. Do not run a long suite on the existing 48-hour observer;
use a new output directory and the independent lab container.

For an independent 48-hour local lab, first require a successful short `suite`
against the exact frozen graph, then use `--profile idle --idle-ms 172800000` in a
separate one-shot unit. Use `Restart=no`, no boot enablement and a unique output
directory: the runner refuses an existing output directory, so a manual restart
cannot silently recreate the application. Freeze separate harness/dependency and
release copies before starting; preserve their hashes and unit configuration.
This lab does not resume an interrupted idle segment or reuse the live soak.
`run.json` records the observer PID, container name, requested profile/duration,
Node/entry hashes, resource bounds and verified product source, runtime,
composition, manifest and package hashes. `network-progress.json` records the
actual idle start/planned end, baseline counters and elapsed observer liveness
every minute. These progress writes are local file operations, with no app,
transport or host-counter polling. Counters are measured only at the closed
segment endpoints; an interrupted segment stays incomplete. Final evidence
retains nonzero endpoints, exact deltas and elapsed overruns even on failure.

Browser offline/online, CDP freeze/resume and background-page cases qualify those
browser mechanisms only. Mobile viewport/network emulation does not qualify a
physical mobile radio handover or operating-system sleep. Hardware/carrier cases
remain explicitly unsupported until separately exercised.

The background profile performs real work before restoring the foreground: a
five-second signal request/reply and a native command followed by a fifteen-second
public applied read. The event-only starter exposes this through the installed
backend's `readView({view:'applied'}).readEvents()`; its declared notes query is
the same event projection. Each view is released. The read must contain the exact
new operation ID and text while the document remains hidden, without navigation.
The authenticated direct revision must remain unchanged and relay payload must
grow by zero; eventual success through fallback cannot qualify. Host metadata
requests are measured separately. The normal DOM check follows foreground
restoration, so paused hidden painting is not treated as replication failure.

An idle segment starts after application connection/recovery work settles and the
independent native setup watch has reconnected, received its current initial notice,
and completed the resulting pairing reconciliation. The test observes the real
supervisor callbacks before sampling the baseline; direct data readiness alone
does not establish control-channel recovery. This adds no polling or settling sleep. Counter snapshots
must share one epoch and be monotonic. Its exact host-request and relay-payload
deltas must both be zero; no overrun is subtracted. A short observed segment does
not establish long-idle behavior. Model turns are `null` when not observed;
network silence does not prove no internal kernel work, provider work, or future
conversation wake. Timeline records contain UTC receipt times, fixed phase/event
labels and bounded numeric counters only, capped at 256 with a dropped count.
URLs, peer identifiers, tokens and application data are discarded. A stop-request
marker precedes interruption so shutdown activity cannot silently enter a claimed
closed idle segment. Historical 48-hour soak evidence is independent and untouched.
