# Hardware experiment

A complete observation loop: collect readings, mark an intervention, request an
interpretation, and export the result with provenance and retention limits.

From the repository:

```sh
node cli/bin/tendril.mjs scaffold hardware-experiment ./my-experiment
npm run build
node cli/bin/tendril.mjs preview ./my-experiment --fixture ./my-experiment/scenario.json
```

For interactive local use, run `npm run preview -- ./my-experiment`. For a real
conversation, attach a host listener, give the agent [AGENT.md](AGENT.md), and
publish with `tendril --tendril <name> push ./my-experiment`. The agent follows the
[event contract](contract.json), interprets accepted measurements/media, writes
results into shared state, and replies to the corresponding event sequence.

Choose **Connect serial instrument** for a browser-supported serial device. Pick
115200 or 9600 baud to match the device. The connector accepts one number or
`{"value":23.4}` per line and sends no commands. **Use simulated readings** works
without hardware; its trace, events and exports are labelled as simulated.

Readings update a one-second plot locally. Every five seconds a bounded summary
is sent without waking the agent. An upward threshold crossing can request
attention at most once every 30 seconds. Intervention notes and optional photos
give the agent context; a photo event is delivered only after its media exists.
The page distinguishes a queued item, acceptance, and rejection.

The current tab retains 1,200 raw samples for CSV. A report retains 300 summary
buckets, 50 interventions and aggregate statistics for the whole run. Five recent
reports live in shared state. A sixth run is blocked until the owner archives the
experiment; reports are never silently evicted. A 51st intervention is declined
with its draft intact. Export the current raw CSV before starting another run or
archiving, because raw readings are local to this tab. **Export report JSON** includes the interpretation;
**Export raw CSV** reports the retained window and does not imply complete raw
history. Reload restores saved reports; starting another capture requires a tap.

`scenario.json` uses a labelled simulation and scripted agent state/reply. It is
run by the browser shipping gate. Pure model tests check bounded retention,
aggregate accuracy, source labels and the event contract.
