# Core tool artifacts

Operational software is built and versioned in core. Contrib releases only
cookbook content and its checks; the core build has no contrib dependency.

## Build and install

```sh
npm ci
npm run build
npm --prefix tools ci
node scripts/build-tools.mjs
mkdir -p /path/to/private-tools
# Choose the actual version produced by the build.
tar -xzf dist/tendriller-tools-<version>.tgz -C /path/to/private-tools
node /path/to/private-tools/bin/tendril.mjs --help
```

`dist/tools-manifest.json` records the source commit, core contract, exact runtime
identity, archive byte length and SHA-256. Verify the archive's hash before
extracting. The archive is deterministic for the same built runtime, source,
dependencies and toolchain; its tar metadata has normalized order and timestamps.

The package is `@tendriller/tools`. Commands live in `bin/`; optional public
libraries are exported as `./preview`, `./collector`, `./events`, and `./pack`.
Commands bundle their runtime dependencies. Browser automation additionally
needs an explicitly installed Playwright and browser. The preview command shares
one packaged preview library; ordinary publishing does not load fixture assets.
Third-party notices accompany the archive. This change grants no project license.

## Three separate identities

| Identity | Meaning |
| --- | --- |
| Cookbook provenance | Source and reasoning an author used; adapted code is page-owned |
| Deliberate dependency | Explicitly selected package/version and its ordinary integrity record |
| Publication | Actual authored file bytes plus the exact production runtime |

Packing reads authored files without changing them or completing missing imports.
A copied snippet can change freely. Publication hashes protect the final bytes,
not equality to an upstream example. Preview serves those same authored files.

The optional tools use built public SDK/runtime exports. Their sources and Node
dependencies must stay outside the Worker and minimal browser module graphs.
