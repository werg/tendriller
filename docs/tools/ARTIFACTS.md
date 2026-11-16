# Release artifacts and dependencies

One contrib tag creates independent tool, static and trusted-workflow artifacts. All carry the same release version. Module interface/schema revisions are separate from that version, so a component-only release does not require a server deployment.

| Artifact | Contents |
| --- | --- |
| `tendriller-tools-<version>.tgz` | Bundled Node CLI, collector, preview, bridges, local resources and recipe assets; no installation-time dependencies |
| Standalone `.mjs` / `.sh` commands | Collector, fixture preview, host bridges and watch/wait/event helpers |
| `tendriller-static-<version>.tgz` | Components, complete dependency graph, examples, documentation and public catalog |
| `tendriller-workflows-<version>.tgz` | Worker-compatible trusted module, narrow interface requirements and integrity manifest |
| `catalog.json` | Machine-readable supported tools/components/recipes, file hashes, content types, core pairing and maintainer |
| `manifest.json` | Source commit, exact download URLs, SHA-256 hashes and sizes for every release asset |

`core.lock.json` pins the SDK/runtime release artifacts used by builds. The archive copies in `vendor/core` and the ordinary npm lockfile are sufficient to build without a core checkout. `distribution/install-core.mjs` accepts only these declared HTTPS release URLs and rejects a mismatched hash before installation.

Release CI verifies tests, builds from the tag commit and publishes immutable assets to GitHub Releases. Production composition in core consumes only the trusted workflow archive. It does not install this repository's CLI or Node dependencies.

Page publications have a third identity. `tendril.json` declares selected dependencies; scaffolding resolves their full closure to local page files and writes `tendril.assets.json`. The core then generates the authoritative publication manifest with immutable runtime and page asset URLs. An open tab retains the graph matching its executing publication while another tab uses the next publication.
