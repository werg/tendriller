# Changelog

Tendriller prereleases are identified by their **source checkpoint and release
composition**, as well as their package version. A `source-<full commit SHA>`
release is immutable. Several source releases can carry `0.3.0-rc.17`; installing
packages with that version string alone does not establish compatibility with a
particular host. Use the selected host's advertised `firstApp.release` manifest
and kit, as described in [Build an app](docs/BUILD_AN_APP.md).

## Unreleased

- Client invitation and setup WebSockets use a client-permitted close code while
  retaining the local failure reason, preventing `InvalidAccessError` on invalid
  frames, transport errors and failed invitation acknowledgements. Fixes #81.
- A missing application (`404` with `error.code: "not_found"`) has a distinct
  `application_not_found` setup status with recreation guidance and bounded
  retries. It is separate from revoked host access. Fixes #82.
- Added the [rc.16 to current rc.17 migration guide](docs/MIGRATION_RC16_RC17.md),
  including host resets, discovery changes, renamed SDK imports and moved starter
  helpers. Fixes #83.
- Added a [local release-host workflow](docs/LOCAL_HOST.md) for testing create,
  init, signed publication, owner claim, pairing and connected app behavior
  before using a production host. Fixes #84.

## 0.3.0-rc.17 source checkpoints after the version tag

These changes landed after the original `v0.3.0-rc.17` tag and are included in
later source-tagged releases that retain the same package version. Existing
rc.16 applications need the [migration procedure](docs/MIGRATION_RC16_RC17.md).

| Area | Breaking change and action |
| --- | --- |
| Host storage | [5691166](https://github.com/werg/tendriller/commit/56911663e1b5e274c45e7800b0bf37ecafbd15e3) provisions fresh schema11 Worker/account storage bindings. Applications in the previous storage are absent on that deployment and must be recreated: run `npm run create` and `npm run init` again in a fresh project, then publish and enroll. Retain the previous private project for any separate data recovery. |
| Peer discovery | [1323030](https://github.com/werg/tendriller/commit/1323030350f0265a48ab89dc06bc5978a4b9430c) replaces advertisement TTL leases with presence tied to authenticated discovery sockets. Old periodic `ttlMs` advertisements fail with `Unknown advertisement field`; upgrade native and browser participants together. |
| SDK ownership imports | [d5cb056](https://github.com/werg/tendriller/commit/d5cb056ebc38431d485d1ca73a24e5574ba583ee) separates session ownership from the optional collaboration schema. Use `@tendriller/core/native-owner`, `/worker-owner` and `/browser-owner` instead of `/collaboration/native`, `/collaboration/worker` and `/collaboration/browser`. |
| Participation | The maintained entry points are `participateNativeApplication` from `@tendriller/core/native-rtc` and `participateApplication` from `@tendriller/core/participation`. They supply one shared direct-first transport policy and encrypted relay fallback. `session.participate` and `createPeerIntroductions` remain lower-level APIs, not the starter's normal setup route. |
| Reactive views | `createLiveView` moved out of the copied starter helper and is now provided by `@chronolog/peer-session/browser` (also the package root). Update the import and consume the matching Chronolog archive. |
| Pairing lifetime | [86475c1](https://github.com/werg/tendriller/commit/86475c19f1fec4347ee765a804fff5c8be5eb348) removes `startPairingWindow` and `startReviewedPairingLoop`. Use the starter's `superviseParticipant` with `watchApplicationSetup` notifications; keep the native participant running independently of optional assistant access. |

## 0.3.0-rc.17 version tag

The original [`v0.3.0-rc.17`](https://github.com/werg/tendriller/releases/tag/v0.3.0-rc.17)
tag points to `b07fd6aa8b93cbfca21a523c12c4aa96b87345dd`. It keeps live acceptance
fixtures outside the attested source checkout. This historical tag is not an
alias for later rc.17 source checkpoints and is not overwritten.

## 0.3.0-rc.16 version tag

The [`v0.3.0-rc.16`](https://github.com/werg/tendriller/releases/tag/v0.3.0-rc.16)
tag points to `4c04c44186b3cc39a1e84ff8473fd8c843f6d8cb`, the live-consent
qualification checkpoint used as the starting point for this migration guide.
