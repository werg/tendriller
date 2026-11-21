# Choose retained state: events or SQL

**Choose by the invariants your application must enforce.** Both choices use
Chronolog's real application session, signed device, command journal, coherent
views, authority and synchronization. Tendriller hosts the page and application
control plane. SQL is an optional execution capability inside that session.

| Your application's first requirement | Start with | Concrete source |
| --- | --- | --- |
| Retain notes, messages, observations or an activity history; derive a small view from those records | Events | [Shared Notes](BUILD_AN_APP.md), included at the starter archive's root |
| Keep related rows consistent; guard a reservation, transfer or checkout against the actual shared state | SQL | [Shared Inventory source](https://github.com/werg/tendriller/tree/master/docs/tutorial/sql), included in the archive's `sql/` directory |
| Send typing, pointer or other disposable presence | Live signals alongside either model | [Application signals](APPLICATION_SIGNALS.md) and the session's `signals` capability |
| Use speech, camera or other sensors | Runtime capabilities alongside either model | [Browser API](BROWSER_API.md); sensor output becomes retained state only through an explicit application command |

Events are the smallest end-to-end first app: they require no SQL engine or
schema installation. Choose SQL when row constraints and guarded transactions
express the product's rules directly. A program may contain both SQL statements
and retained emits. Do not create a second database merely because SQL requires
an additional package, and do not label a layout preview as a connected app.

An initial descriptor binds the application definition, schema and execution
manifest. Choosing SQL for a new app is not an in-place switch for an already
initialized events application. The two starters have separate handles, signers
and stores. Changing the declared domain semantics requires a deliberate
version and migration/release design; publishing new HTML alone does not change
that binding.

## The SQL starter and its guarded transaction

Shared Inventory has two bins, `source` and `destination`, and a table of transfer
receipts. Its `seed` command initializes 10 units and 0 units once. Its
`transfer` command contains **one program** with all of these steps:

1. Check the bins differ and the proposed receipt does not already exist.
2. Assert that both balances still equal the values the caller reviewed.
3. Assert that the source has enough units and the destination has capacity.
4. Decrease the source and increase the destination.
5. Insert an authenticated receipt and emit `inventory.transferred`.

The guards are SQL `chronolog_assert` statements. They run at the operation's
actual position in the selected shared history. They are not a prior read
followed by unguarded writes. Another writer can change a balance between the UI
read and submission; the stale command then rejects. SQL/platform failure
rejects the whole program, rolls back its changes, and produces no effective
emit. The protocol's [deterministic SQL contract](https://github.com/werg/chronolog-db/blob/d3efeb6d75ac24bb9b44899f27d6940475ab55e9/docs/implementation-specs/10-deterministic-sql-transactions.md)
defines those atomicity and rejection rules.

The literal source is short enough to inspect. The central part is:

```js
program(
  sqlStatement("SELECT chronolog_assert((SELECT units=? FROM inventory WHERE id=?), 'source_changed')",
    [expectedSource, from]),
  sqlStatement("SELECT chronolog_assert((SELECT units=? FROM inventory WHERE id=?), 'destination_changed')",
    [expectedDestination, to]),
  sqlStatement("SELECT chronolog_assert((SELECT units>=? FROM inventory WHERE id=?), 'insufficient_stock')",
    [units, from]),
  // The complete supplied command also checks identity, capacity and receipt ID.
  sqlStatement('UPDATE inventory SET units=units-? WHERE id=?', [units, from]),
  sqlStatement('UPDATE inventory SET units=units+? WHERE id=?', [units, to]),
  // Receipt insertion and the retained emit belong to this same program.
)
```

Read the complete `sql/domain.mjs` before adapting it. The shared rows explicitly
belong to `APPLICATION_COLLECTIVE_ID`; their write permission does not depend on
which browser created them. The receipt's author comes from
`chronolog_actor()`, the verified signing device. Supplying an `author` field in
JSON would not establish that identity. This starter grants ordinary application
members the ability to transfer between the shared bins; product-specific role
checks should be additional guards or grants.

The `inventory` query reads both balances, receipts and effective events from
one coherent view. Its receipt/activity output is deliberately bounded for the
demo; it is not an unbounded export. The row guards carry the business
preconditions. The command also records the caller's `basedOn` revision, while
Chronolog owns the durable operation identity and outcome.

## Provision the native SQL capability before creating an app

First download the starter and the host's matching SDK/tools as described in
[Build an app, step 1](BUILD_AN_APP.md#1-get-the-starter-and-matching-public-packages).
Check the selected host's readiness before acquiring or building optional SQL
dependencies. The first-app kit includes an events-only Chronolog archive;
this SQL application uses its own qualified session package instead. From the
extracted starter root, use the independent `sql/` directory and the kit's local
SDK/tools packages:

```sh
cd sql
TENDRILLER_RELEASE=$(node -p "JSON.parse(require('fs').readFileSync('../service.json','utf8')).core_release")
npm install --save-exact "../packages/tendriller-sdk-$TENDRILLER_RELEASE.tgz" \
  "../packages/tendriller-tools-$TENDRILLER_RELEASE.tgz"
```

Build the exact SQL package from a fresh Chronolog checkout, using the source
bound by the downloaded kit’s `composition.json`; do not select a second kernel
revision from a copied guide example. Use Node 24, Git,
Corepack/pnpm, Python 3, a C/C++ build toolchain and `make`/`tar`. Package
installation must be allowed to download the pinned upstream source and Node
headers. **Enable installation scripts for this SQL build.** The events-only
guide's `--ignore-scripts` deliberately avoids the native compilation that SQL
needs.

```sh
CHRONOLOG_SOURCE=$(node -p "require('../composition.json').chronolog.session.source")
git clone https://github.com/werg/chronolog-db.git ../../chronolog-sql-source
git -C ../../chronolog-sql-source checkout --detach "$CHRONOLOG_SOURCE"
cd ../../chronolog-sql-source
corepack pnpm install --frozen-lockfile
node tools/package-peer-session.mjs --sql-native --output artifacts/session-sql
CHRONOLOG_PREFIX=$(git rev-parse --short=8 HEAD)
node tools/test-peer-session-sql.mjs \
  --artifact "$PWD/artifacts/session-sql/chronolog-peer-session-$CHRONOLOG_PREFIX-sql.tgz"
```

Return to your starter's `sql/` directory, and install the produced archive by
its absolute path:

```sh
npm install --save-exact /absolute/path/to/chronolog-sql-source/artifacts/session-sql/chronolog-peer-session-*-sql.tgz
npm run engine
```

`engine` must print `available: true` and an execution-manifest digest before you
create the hosted app. `create` first verifies its requested service origin,
current readiness and host contract, then runs the same capability check before
creating any page. A saved handle resumes only on its original service and
does not trigger another engine load or create request.
Keep the archive SHA-256, its `provenance.json`, the native qualification report,
and this application's `package-lock.json` with your release evidence.

A supplied qualified archive can replace the local build **only when its
source, platform, architecture and native ABI match your environment**. Linux
x64 alone is insufficient: a binary requiring a newer glibc cannot load on an
older distribution. `SQL_ENGINE_UNAVAILABLE`, a missing `/sql-native` export,
`GLIBC_* not found`, or a missing `chronologNativeManifest` is a capability
failure to resolve before initialization. Do not substitute the unpatched
upstream DoltLite prebuild, fabricate a manifest or continue with an events
session under the same SQL descriptor.

The package's [native packager](https://github.com/werg/chronolog-db/blob/d3efeb6d75ac24bb9b44899f27d6940475ab55e9/tools/package-peer-session.mjs)
includes the exact compiled addon and records its build identity. The default
archive has no SQL engine. `--sql-native` supplies `/sql` and `/sql-native`;
`--sql-browser` supplies `/sql` and `/sql-browser`. The flags can be combined,
but browser WASM assets are built and deployed separately.

## Create, initialize and exercise real retained SQL state

Use a fresh development application for the demonstration. Set the actual
service origin and owner email; `create` prints the claim URL:

```sh
TENDRILLER_ORIGIN=https://tendriller.dev
npm run create -- "$TENDRILLER_ORIGIN" owner@example.com "Shared inventory"
```

Initialize and prepare the application immediately, without waiting for owner claim:

```sh
npm run init
npx tendril --session ./session.mjs describe
npx tendril --session ./session.mjs query inventory null
npm run demo
```

`init` is complete: it creates the native device explicitly, saves the initial
history/key once, calls `prepareSqlApplication` to sign the literal schema and
bind its exact engine manifest, configures the host descriptor and grants,
saves/selects the first generation, then activates a coherent SQL view. The
signed schema and exact transition request are saved before first submission.
An uncertain retry reuses them. Ordinary `session.mjs` reopening omits
`create: true`, uses the saved schema/descriptor and device, and attaches the
same host control participant and maintained participation controller as the
events starter.

The demo changes actual retained state. It verifies:

| Action | Expected result |
| --- | --- |
| Seed the two bins | `source: 10`, `destination: 0` |
| Transfer 3 with reviewed balances 10 and 0 | `accepted`; balances 7 and 3, one receipt and one effective transfer event |
| Transfer 8 with reviewed balances 7 and 3 | `rejected`, `assert:insufficient_stock`; balances, receipts and effective events unchanged |
| Close and reopen the native device | The same signer, balances, accepted operation and rejected operation |
| Rerun the demo unchanged | The saved original inputs, revisions and operation IDs are reused |

Do not run `peer` concurrently with `init`, `demo`, `enroll` or a CLI command on
the same native device. That store has one owner. When a command times out,
inspect its saved identity before starting new work:

```sh
npx tendril --session ./session.mjs operation inventory-demo-transfer-v1
npx tendril --session ./session.mjs operation inventory-demo-rejected-v1
npx tendril --session ./session.mjs query inventory null
```

`applied` is an observation with an `outcome`; rejected work is also applied.
Recovery may exclude an earlier operation. Review the current coherent view
and inspect the original operation before deliberately reapplying it with a
linked new identity. Keep SQL guards in that new attempt; a successful prior
read does not reserve stock.

The domain, setup, session and demo are executable source. Passing upstream
engine conformance or importing this domain does not establish that your exact
host/package combination passed this demo. Run it and retain the result as the
native SQL acceptance gate.

## Browser SQL uses the same definition and session

`sql/worker.mjs` is a complete owning Worker composition of the same
`sql/domain.mjs`. It loads the signed schema from `peers.definition()`, verifies
the application's pinned authority and reader grant, and calls
`openSqlApplication`. Its lazy `createEngine` factory loads the exact WASM build
and creates an OPFS SAH pool. The session's command/query/operation/replication
interface is unchanged.

**This SQL directory supplies a native starter and a browser Worker, not a
second finished browser UI.** Shared Notes remains the runnable page/UI
reference. An authored inventory UI must render the `inventory` query and
capture its two reviewed balances when preparing a `transfer` command. Keep
the unresolved operation's ID, input and `basedOn` revision across reloads, and
reuse them on an uncertain retry. Do not wire Shared Notes' `addNote` form to
this definition or claim a browser SQL run from native results.

For a browser build, prepare both optional package entries and the separate
engine assets from the same pinned checkout. The maintained toolchain is
Emscripten **4.0.20** at the following exact SDK commit:

```sh
# Run in the pinned chronolog-sql-source checkout after the native build.
node tools/package-peer-session.mjs --sql-native --sql-browser --output artifacts/session-sql-browser
git clone --depth 1 --branch 4.0.20 https://github.com/emscripten-core/emsdk.git ../chronolog-emsdk
test "$(git -C ../chronolog-emsdk rev-parse HEAD)" = e4fe26ef59168ff44f4c23c466e497bf60b3411e
../chronolog-emsdk/emsdk install 4.0.20
../chronolog-emsdk/emsdk activate 4.0.20
node tools/build-wasm-engine.mjs --emsdk ../chronolog-emsdk --output artifacts/wasm
```

Install the generated `chronolog-peer-session-<source-prefix>-sql-wasm.tgz` from this same selected source into the application in
place of its native-only package. Preserve these four engine files together in
the authored publication's `engine/` directory:

| Asset | Purpose |
| --- | --- |
| `sqlite3.mjs` | Exact engine module |
| `sqlite3.wasm` | Compiled engine bytes |
| `sqlite3-opfs-async-proxy.js` | Engine storage support asset |
| `manifest.json` | Toolchain, native build identity and WASM digest |

The [WASM builder](https://github.com/werg/chronolog-db/blob/d3efeb6d75ac24bb9b44899f27d6940475ab55e9/tools/build-wasm-engine.mjs)
uses the same pinned native sources/hooks. `loadBrowserEngine` verifies the
WASM digest and supported build identity; `openSqlApplication` also checks the
engine's execution-manifest digest against the application descriptor before
opening the database. Native/WASM defaults and any execution-limit overrides
must match. A random SQLite WASM download is not interchangeable.

The Worker expects `configuration.json` next to its bundled output with these
common public fields: `{ applicationId, page_url, descriptor }`. Shared Notes
additionally includes `nativeDeviceId` for its optional inference panel; this SQL
Worker does not require that field.
Use the matching SQL project's saved handle and pinned descriptor to build
these fields. Never copy the handle itself, `.tendriller/`, a private signer or
the bootstrap epoch key into the publication. It uses the same owner lifecycle as
the events starter:

| Page action | Public composition |
| --- | --- |
| Create this browser's identity deliberately | `createBrowserIdentity({ workerUrl, profileId })` returns only the public key under the exclusive profile fence |
| Enroll the verified owner's browser | Stop the native owner; run `npm run enroll -- PUBLIC_KEY` from the SQL directory; then start `npm run peer` |
| Attach the existing enrolled device | `openBrowserOwner({ workerUrl, profileId, applicationId, definitionId, definitionVersion, requiresDedicatedWorker: true, context })` returns a fenced elected-owner facade for synchronous OPFS SQL |
| Install runtime access | Install `createApplicationBackend({ id: session.applicationId, session })` and `session.signals` as in the first-app page |
| Leave one view | `attachment.detach()` closes only that view's requests, streams and captured reads |

Use `tendriller-inventory-${applicationId}` as the matching profile ID. The owner
opens no SQL engine for protocol-only attachment or signals. On final owner
shutdown it closes the session database handles before releasing the external
OPFS pool. A fresh browser receives epoch keys over authenticated encrypted
participation; page configuration never supplies a plaintext key.

The qualified Chromium build exposes the required synchronous OPFS APIs in a
dedicated Worker, not SharedWorker. `requiresDedicatedWorker: true` selects that
route before opening storage. An explicitly forced shared mode fails with
`OWNER_STORAGE_UNSUPPORTED`; it must not silently choose a different database.

The native SQL peer also uses the private supervisor. Ordinary CLI calls attach
to a running `npm run peer`; deliberate one-off setup/publication calls use
`--mode own` while that owner is stopped. A separately enrolled native profile
has its own signer and SQL materialization; it is never created implicitly.

Serve the actual bundled Worker, its chunks, the four engine assets, public
configuration and your UI in one authored graph. Publish only that graph via
`tendril --session ./session.mjs --mode own publish`, with an explicit operation ID.
Keep the native peer running for this starter's coordinator/key-donor role.

Browser SQL requires separate qualification on the target browser, origin,
storage provider and network. An events-only IndexedDB fallback does not prove
that the SQL OPFS VFS works on that device. Run a guarded transfer, a rejected
transfer, a close/reopen and a second-device observation with the real WASM
engine before calling this browser composition working.

## Preview and production: keep one application implementation

Use the same domain, session opener, Worker, commands and runtime backend in
preview and production. Configuration may select an explicitly authorized
development application. A separate development descriptor, device and data
are ordinary environment isolation; replacing the application with fake query
results or another database changes what was tested.

There are two honest preview paths today:

| Preview | What it proves |
| --- | --- |
| `tendril-preview ./page` | Authored layout/assets; no application session is supplied |
| A signed release on a development Tendriller page, with its owner claim and enrolled browser | The real session, host authorization, peer transport, retained commands and runtime binding |

`tendril-preview --bootstrap` accepts an authored `openPreview({configuration})`
that returns a real owned backend and close function. That is a composition
hook; it does not create a host, account, descriptor, grant or peer donor for
the caller. Its server serves authored/runtime assets and does not proxy
`/_tendril/` host APIs or WebSocket upgrades. See the exact
[preview contract](tools/PREVIEW.md).

For this starter, use an explicitly created development page for live review.
Run the same create/init/build/publish/claim/enroll steps against that page's
configuration. Later publish the reviewed graph to the intended application
using its authorized session and pinned configuration. If reviewing the exact
same production application/data is required, open its actual authorized page
origin and selected signed publication; that is live application testing.

A localhost tab has a different account-cookie context and browser device
store. Removing an origin check does not enroll it or provide its keys. A local
host may also run the same public engine with its own explicit development
account/enrollment, but it is a separate application identity. Never describe
that separate session as the production session, transfer production cookies
or keys into a public bootstrap, or add an implicit credential proxy to make a
preview appear connected.
