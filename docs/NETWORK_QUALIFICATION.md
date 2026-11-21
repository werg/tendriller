# Network qualification lab

This lab uses a disposable Linux Docker network namespace. It never changes the
host firewall, publishes a host port, or touches permanent reviewer/idle-soak
processes. `NET_ADMIN` is granted only to that container. Run it on a disposable
CI worker if local Docker policy prohibits that capability.

```sh
node --test test/e2e/network-qualification/lab.test.mjs
docker build -t tendriller-network-lab:playwright-1.65 test/e2e/network-qualification
node test/e2e/network-qualification/run.mjs --output /absolute/new-evidence-directory --node-binary /absolute/node24
```

The packet-control probe exercises real IPv4 **and** IPv6 UDP echo before,
during, and after an OUTPUT firewall block. DNS remains permitted, and real TCP
echo must continue during the block. A real loopback `tc netem` qdisc then applies
60 ms delay and 1% random loss. The probe requires an observed delayed TCP
exchange and removes its own rules. Noble's iproute2 has no netem seed option;
loss selection is stochastic. UDP blocking is deterministic. Unsupported IPv6,
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

Browser offline/online, CDP freeze/resume and background-page cases qualify those
browser mechanisms only. Mobile viewport/network emulation does not qualify a
physical mobile radio handover or operating-system sleep. Hardware/carrier cases
remain explicitly unsupported until separately exercised.

An idle segment starts after connection/recovery work settles. Counter snapshots
must share one epoch and be monotonic. Its exact host-request and relay-payload
deltas must both be zero; no overrun is subtracted. A short observed segment does
not establish long-idle behavior. Model turns are `null` when not observed;
network silence does not prove no internal kernel work, provider work, or future
conversation wake. Timeline records contain UTC receipt times, fixed phase/event
labels and bounded numeric counters only, capped at 256 with a dropped count.
URLs, peer identifiers, tokens and application data are discarded. A stop-request
marker precedes interruption so shutdown activity cannot silently enter a claimed
closed idle segment. Historical 48-hour soak evidence is independent and untouched.
