# Use the application session from a terminal

`tendril` consumes the application's public bootstrap. It does not install another signer, application backend or retry queue. Ordinary browser work does **not** require a running native participant. Follow [Build an app](../BUILD_AN_APP.md), [bootstrap](../SESSION_BOOTSTRAP.md), and [delivery](../AGENT_DELIVERY.md).

## Start with the exact service origin

```sh
tendril guide --server https://YOUR_SELECTED_SERVICE --pretty
tendril readiness --server https://YOUR_SELECTED_SERVICE --pretty
tendril service --server https://YOUR_SELECTED_SERVICE --pretty
```

Guide navigation is local; service/readiness are anonymous live reads. Before package acquisition or creation, verify same-origin open readiness. Pause/unavailable/unsupported responses stop new setup; do not fall back to production. Use the immutable kit's SDK/tools/**authority**/session composition and exact hashes/source identity. A created page handle is host access, not data-key access or a configured participant.

## Browser-first publication

The starter's `npm run init && npm run deploy` prepares an independent publication key/policy and signs the complete UI **before the first browser key exists**. It needs no native data device, data root, fixed schema or finalizer. Give the owner the ready page URL; their real sign-in/key proof initializes local browser data keys. No claimed reply or second deployment is necessary.

The optional CLI `publish` command uses an explicitly supplied independent publisher/control port. Code-revision concurrency and exact publication retries are unrelated to application data order. Never publish the project root/private state.

## Optional retained native device

If the app actually needs local tools/private APIs/native participation, use the supplied `session.mjs` and Node 24 with its exact public native dependencies. A native device is an **additional** explicit profile, not first-app genesis.

1. `node session.mjs init-device`: creates/resumes only that native identity; copy its public key.
2. On an existing owner browser, expand **Prove an optional native/external device key** and request an account-bound challenge for that key.
3. Save the public challenge locally and run `node session.mjs sign-enrollment CHALLENGE.json`. Paste its canonical public signed proof into the browser and record it. Host creator tokens cannot impersonate this owner-account browser action.
4. Run `node session.mjs provisioning-request`; review this public recipient request in the existing browser. Grant only exact independent crypto rights and wrap keys to that recipient.
5. Save the encrypted package and run `node session.mjs import-provisioning PACKAGE.json`. Agreement secrets and decrypted epoch keys remain in the native private store.
6. `npm run peer` starts the optional retained native supervisor and background RTC/relay participation. Browser Save continues when it stops. SQL row/column/object privileges need separate ordinary authorized transactions.

Keep private handles, publisher identities, native device databases, agreement secrets and original signed operations outside authored `page/`. A missing key/descriptor/store is a restore/provisioning prerequisite, not permission to mint replacements.

## Attach versus ownership

```sh
tendril --session /absolute/app/session.mjs --mode attach self
tendril --session /absolute/app/session.mjs --mode attach doctor
tendril --session /absolute/app/session.mjs --mode attach query notes null
```

`attachSession({signal,profile,context})` uses an authenticated existing private IPC owner. Exiting detaches only this caller. If it is unavailable, report that prerequisite; never silently open another signer. `--mode own` deliberately acquires exclusive ownership for the call and awaits cleanup. `--mode independent --profile NAME` requires that explicitly provisioned profile. One physical store owner and bounded view/root lifetimes are local fencing, not an application ordering coordinator. Endpoint binding identity is owner-derived; caller view labels are not independent product authorization.

Optional process residency requires an actual supervisor/process manager in an environment that supports it. Report the PID/manager, start/stop/resume command and retained store only when established. Page residency or MCP does not guarantee future wake of an existing conversation.

## Durable facts and exact author time

```sh
tendril --session ./session.mjs --mode attach command putNote \
  '{"noteId":"stable-note","text":"reviewed text"}' --operation note-intent-1

tendril --session ./session.mjs --mode attach operation note-intent-1
tendril --session ./session.mjs --mode attach retry note-intent-1
```

A command returns after the exact signed intent is **stored locally**, without waiting for peers, materialization, a current global read, an agent or finalizer. Inspection reports authenticated application/author/proposal identity and independent `stored`, `pending`, `materialized`, `retained`, `finalized`, and `excluded` facts.

Optional `--author-time MS` is an exact nonnegative int64 decimal string, converted to bigint and allocated once. Omit it for the authoring device's retained default. Canonical order is `(signed authorTimestampMs, signing key bytes, stable proposal-ID bytes)`, never receipt/delivery/host order. Retry calls only the original signer's retained journal; it never creates another core, nonce, time or ID.

Opt into a bounded observation explicitly:

```sh
tendril --session ./session.mjs --mode attach command putNote \
  '{"noteId":"stable-note","text":"reviewed text"}' --operation note-intent-2 --wait materialized
```

`--wait materialized` observes a **revisable** coherent local outcome. `--wait retained` requests authenticated peer storage evidence. `--wait finalized` requires configured verified finality and complete dependencies/replay. On `none`, finality is explicitly unsupported; it never manufactures success. Interrupted waits preserve the original stored operation for inspection.

`command-batch` accepts 0..64 objects `{operationId,command,input,authorTimestampMs?}`; author timestamps, if supplied, are decimal strings. It validates all envelopes before dispatch, then stores individual commands in order of local invocation. This is not an atomic SQL program or global ordering mechanism. It stops on uncertainty with original IDs/facts and a next index; no hidden replay queue exists.

## Coherent reads and revision-aware watches

```sh
tendril --session ./session.mjs --mode attach query notes null
tendril --session ./session.mjs --mode attach events --topics '["note.put"]'
tendril --session ./session.mjs --mode attach watch --events
```

Named queries return `{value,revision}` from one captured coherent snapshot. Raw view SQL/event reads retain their captured revision and must be released. Materialized revisions are digests of effective authenticated operation/execution/policy inputs, not global sequence numbers.

`watch --events` emits snapshot-scoped batches and explicit **reset** records when materialization changes; consumers replace/rederive by stable event identities, never treat provisional arrivals as an append-only UI database. A cursor from another projection reports an explicit revision error. Emitted progress is not proof of consumer processing or irreversible finality. Output is NDJSON with backpressure; independent read/output/cleanup failure remains nonzero even if cancellation occurs later. Intentional invocation timeout/interruption reports its last progress separately.

`logs`/`signal` consume disposable authorized live channels, not durable data order. Optional agents/media providers may be offline while ordinary browser data edits remain available.

## Optional author-time finality

```sh
tendril --session ./session.mjs --mode attach finality close --through 1700000000000
tendril --session ./session.mjs --mode attach finality vote --through 1700000000000
```

Only explicitly configured eligible finalizers can act. Closing author time can exclude genuine unseen offline work first included behind the frontier. Providers cannot allocate operation order, promise retention, or make external effects exactly once. Fixed-validator quorums need the actual verified votes/proofs; a configured but unavailable provider does not block local submission. Do not claim browser/native/host finality qualification from configuration or source inspection alone.

Provisional claims/receipts are revisable. Optional external-effect dispatch must use the selected finality policy plus its own durable provider idempotency/reconciliation journal and approved consumer scopes. Schema changes do not expand those approvals.

## Exact publication and private handoff

`publication`, `publication-operation ID`, and `publish DIRECTORY --operation ID` inspect/retry an independent signed code release. Preserve the original graph, signer and ID after uncertain replies; verify actual selected immutable publication/asset hashes. Publication can use an existing approved supervisor's control port, but that is not a prerequisite for browser-first publishing.

`handoff source` exports non-secret authored source only. Native checkpoint transfer is explicitly private and requires its exact identity, keys, store and engine contract; no host token alone decrypts data. Never clear original stores or introduce an old-format reader as troubleshooting. See [troubleshooting](../TROUBLESHOOTING.md) and report exact public-package/IPC/browser tests and limitations.
