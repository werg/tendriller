# Build and consume the tools artifact

The tools archive contains two commands, `tendril` and `tendril-preview`, and
three public modules: `./session`, `./preview` and `./pack`. Its manifest records
the source commit, contract, runtime identity, archive digest and byte count.
The preview embeds the exact public runtime assets, including their manifest.
No sibling source imports are required by a consuming installation.

Build in a clean exact checkout:

```sh
npm ci
npm run build
npm --prefix tools ci
npm run build:tools
npm run test:tools
```

A consumer extracts the resulting `tendriller-tools-*.tgz` or installs the package
and uses its declared bins/exports. It independently supplies a bootstrap module
that imports an exact public Chronolog session package. That module owns the
actual device, definition and transports; the tools archive contains no second
application engine or delivery store.

The public artifact test extracts a fresh installation, checks its hash and
export graph, runs CLI help and serves an authored asset graph without relying
on the source checkout or a separately installed runtime package. Unit tests
check exact operation identity forwarding, cancellation ownership, coherent
view release, complete signed publication preparation and immutable preview
assets. Those tests are boundary evidence, not a claim that a mocked session
executes application semantics.

Real common-session behavior is qualified by the independently packed consumers
in tendriller-contrib: native events, native RTC, browser Worker/OPFS, guarded SQL
and the actual workerd control participant. Reports name exact source and archive
hashes. A dirty build remains development evidence; local traffic counters do
not establish provider prices, deployed login or representative network behavior.
