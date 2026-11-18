# Browser and integration qualification

Choose a test boundary that exercises the claim being made. Core browser composition, actual Worker hosting, native/browser RTC and physical-device behavior are separate observations.

## Gates

| Gate | Exercises |
| --- | --- |
| `npm run test:contract` | Public SDK schemas, role filters and response correlation |
| `npm run test:runtime-unit` | Quiet runtime, explicit bindings, sensor cancellation, voice lifecycle and code-cache failure handling |
| `npm run test:server` | Actual workerd account authorization, control transitions, signed publication, CAS and restart |
| `npm run test:consumer` | Strict public declarations and execution using only packed artifacts |
| `npm run test:tools` | Session CLI, exact-file preview and extracted self-contained archive |
| `npm run test:browser` | Browser code retention, sensor controls, local host claim/origin/signed-release flow, speech and preview |

The runtime browser fixture serves immutable assets only. It does not emulate an application database or protocol executor. Application binding tests exercise installation; actual command/query/recovery semantics are tested with Chronolog sessions and independent contrib qualification.

## Local host and public fixture

The local e2e service uses synthetic OAuth identities and real Worker routes. Verify owner claim, origin isolation, signed code publication, historical code URLs and refusal of ordinary hosted data requests. Runtime utility checks must not rely on a host application socket or generated browser device credential.

The packed `@tendriller/engine/testing` fixture exposes real authenticated HTTP, code asset reads, invitation/SDP sockets and durable restart. Contrib combines it with packed Chronolog application sessions and actual RTC. Its host-traffic counters distinguish setup/control exchange from ordinary application progress.

## Optional speech and pinned-model verification

The optional voice adapter uses explicit consent, transcript and output callbacks. Browser tests may substitute deterministic speech engines to check lifecycle and interruption. Such tests do not establish recognition quality.

`npm run test:e2e:speech-real` verifies the selected Cactus/Whistle code and model against silence and a known recorded speech fixture. Keep the pinned bytes and transcript expectations explicit. Physical microphone quality, local recognizer availability, autoplay policy and mobile background behavior require representative device testing.

## Record evidence

Report the exact source and paired archive hashes, which suites ran and which were unavailable. A mock relay is not proof of direct RTC; a static preview is not proof of database semantics; a local workerd run is not proof of deployed OAuth, Internet reachability or operating cost. Avoid broadening checks after the concrete remaining risk is resolved.

## Record storage and browser eligibility

The exact, packaged Chronolog session owns the browser journal and its Web
Lock. No Tendriller page/runtime bundle should instantiate a parallel data
store, signer or migration path. Chronolog's independent Chromium Worker
suite exercises both OPFS and IndexedDB `BytesStore` conformance, immutable
backend pin, legacy OPFS protection, lock contention and reload/resume.
Tendriller's own `npm run check:release` verifies the host/runtime boundary,
but **does not substitute** for Chronolog's packaged browser test or an
exact-commit cross-repository composition.

The browser SQL acceptance specimen can explicitly request Chronolog's
scratch-only `probeBrowserCapabilities()` through a dedicated Worker. The
report distinguishes `events.supported`, `events.backend`, native
Ed25519/X25519, Web Locks, OPFS `createWritable` and sync handles, and SQL
`apiEligible` from SQL `qualified` (false until separately tested).
An installed older Chronolog artifact may not offer this diagnostic; report
it as unverified rather than claiming success.

| Environment | Evidence and release claim |
| --- | --- |
| Desktop Chromium | Actual OPFS/IDB records and Worker lifecycle can be qualified in automated browser CI |
| Chrome for Android | Requires real-device record write, Worker restart and reopening |
| Safari 17 on a real iPad | Events-only requires native crypto, Web Locks, IndexedDB fallback, write/reopen/resume and peer exchange on the physical device; desktop WebKit does not qualify it |
| Browser SQL/WASM | Separate actual DoltLite WASM + OPFS SAH-pool VFS qualification required for each target browser |

Never equate IndexedDB's `durability: 'strict'` hint with universal power-loss
durability. Browser quota failure, background suspension and site-data eviction
remain explicit operational risks. Do not ship a pinned OPFS device with an
implicit IDB reset/fallback; re-enrollment or migration is a separate, reviewed
user operation.
