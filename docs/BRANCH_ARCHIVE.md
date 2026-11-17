# Preserved branch heads — 18 November 2026

Each link below points to the exact commit that was at the tip of an unmerged remote branch during the cross-repository audit. An annotated `archive/2026-11-18/<branch>` tag in the same repository preserves that commit if the branch is later deleted. These are **preserved candidates and experiments**, not release approvals. The current default branches remain authoritative for shipped code.

The large `feat/portable-record-log`, `feat/chronolog-application-log`, and `feat/portable-peer-core` branches describe one possible next composition. They diverged before later default-branch changes; qualify their packages together and review their conflicts before integrating any part. See [release composition](RELEASE_COMPOSITION.md).

## Core

| Branch | Preserved tip | Ahead / behind default |
| --- | --- | ---: |
| `feat/portable-record-log` | [eadb607f3d](https://github.com/werg/tendriller/commit/eadb607f3d2720ae2780285bf7847c9f0207e27e) — Bound release upload buffers independently of controls | 8 / 41 |
| `preview/contract-2-rc1-20261115` | [0acb0ea9fb](https://github.com/werg/tendriller/commit/0acb0ea9fb791edad0ac65313669907e12e391a1) — preview: retry release candidate with quota-safe deployment controller | 1 / 445 |
| `qualification/peer-data-plane-20261117` | [9b4ae992c6](https://github.com/werg/tendriller/commit/9b4ae992c692c7cd5e7dfe0b8ee34e44d6533650) — Require explicit application ownership throughout page creation | 3 / 38 |
| `refactor/cookbook-storage` | [e9e7fce2b4](https://github.com/werg/tendriller/commit/e9e7fce2b4e95c012ae2000548e45de079d933c3) — test(storage): check pagination, tombstones and full publication file identity | 2 / 306 |
| `refactor/headless-storage` | [a3a7bdc174](https://github.com/werg/tendriller/commit/a3a7bdc174daeb82cd965be0927fca6715f3e954) — test: use Contract 3 blobs in current-target bundle checks | 10 / 304 |
| `review/application-architecture-11903a9` | [0b690952e6](https://github.com/werg/tendriller/commit/0b690952e6eefc42b11a58563cf696ddd9489f05) — Pin qualified Chronolog evidence-batch membership runtime | 2 / 66 |
| `review/timestamp-architecture-20261117` | [d4435162c1](https://github.com/werg/tendriller/commit/d4435162c1b00f33e7632803223375d47113adfb) — Bind hosted authority to exact device intent and package the explicit applied/live contracts | 3 / 51 |
| `work/pr34-browser-timers` | [62f0989bbf](https://github.com/werg/tendriller/commit/62f0989bbffe48a7e98ed3949852b0a1a7671b17) — Finish restored capture acceptance cleanup while offline | 6 / 183 |
| `work/pr34-conditional-state` | [e1c40af688](https://github.com/werg/tendriller/commit/e1c40af6887cad21f7eb105fa9efa70429e7f16e) — Document durable browser outcome settlement and queued cleanup | 10 / 183 |
| `work/pr34-durable-timers` | [36fee66520](https://github.com/werg/tendriller/commit/36fee66520b6b825f93be6a3566abfbc9dff4c61) — Persist terminal timer decisions across retries | 3 / 183 |

## Cookbooks

| Branch | Preserved tip | Ahead / behind default |
| --- | --- | ---: |
| `feat/chronolog-application-log` | [da52ac2260](https://github.com/werg/tendriller-contrib/commit/da52ac226005754e0120da8d7f8ccb7bae2e957d) — Configure publication policy before reading release trust | 42 / 75 |
| `qualification/peer-data-plane-20261117` | [c43a088efd](https://github.com/werg/tendriller-contrib/commit/c43a088efd89bc18226b88acd0ddb17acbfd4f1e) — Qualify coherent recovery views and actual served publication assets | 2 / 66 |
| `refactor/trusted-cookbook-references` | [251781b5f9](https://github.com/werg/tendriller-contrib/commit/251781b5f9eff80d343588969e580c796a5349ac) — feat: verify private-response and exact-proposal reference policies through public artifacts | 2 / 269 |
| `review/application-architecture-11903a9` | [066c449a56](https://github.com/werg/tendriller-contrib/commit/066c449a568b81994e5447ce229e8c9cf6a0b761) — Pin qualified batch-replay architecture and explain coherent catch-up | 2 / 113 |
| `review/timestamp-architecture-20261117` | [a769f54e7e](https://github.com/werg/tendriller-contrib/commit/a769f54e7ef79dcc33b499b19f6e9968cf2c64a1) — Qualify optional generation consumers while preserving live collaboration as the default | 2 / 95 |

## Chronolog

| Branch | Preserved tip | Ahead / behind default |
| --- | --- | ---: |
| `feat/portable-peer-core` | [0b4d50836f](https://github.com/werg/chronolog-db/commit/0b4d50836f4fbb2bd9119951c70f5847e274ebdb) — Record clean native reader resource qualification | 51 / 78 |
| `qualification/peer-data-plane-20261117` | [47c4b0252c](https://github.com/werg/chronolog-db/commit/47c4b0252c8a8107271517a6c8856b270ed5e622) — Advance final SQL from its verified immutable prefix | 3 / 72 |
| `review/application-architecture-11903a9` | [57c7f1fbe6](https://github.com/werg/chronolog-db/commit/57c7f1fbe6f9bc1b6ab7e000027fee9b7f784b57) — Pin qualified companion packages and architecture recipes | 6 / 114 |
| `review/architecture-exploration-20261117` | [1eeb4549cc](https://github.com/werg/chronolog-db/commit/1eeb4549cc6cb267ed376c5faf9079e247cb3716) — WIP: preserve unadopted finality exploration and independent live transport | 1 / 140 |
| `review/live-refactor-checkpoint-20261117` | [27689413e4](https://github.com/werg/chronolog-db/commit/27689413e454f143de9aed12fa5cb712302d3ce5) — Checkpoint live authority, provisional execution and DX before concurrent branch integration | 2 / 119 |
| `review/timestamp-architecture-20261117` | [a5cb0624e9](https://github.com/werg/chronolog-db/commit/a5cb0624e98df516683dd3623413a9dc6df101a3) — Integrate durable peer recovery, content and agent tools without applied finality | 7 / 86 |

