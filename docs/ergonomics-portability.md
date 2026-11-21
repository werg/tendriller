# Tendriller & Chronolog-DB: Complete Agent Ergonomics, Simplification & Cross-Platform Portability Specification

> Design specification. This document includes target work and is not a support
> matrix or evidence that every workstream is complete. Use
> [Build an app](BUILD_AN_APP.md), [deployment guidance](DEPLOYMENT_GUIDE.md),
> and the exact published release manifest for current supported paths. A profile
> name or capability probe does not qualify a SQL engine, browser persistence,
> future agent wake, or participant availability after its process exits.


**Repositories:** `werg/tendriller`, `werg/chronolog-db`, `werg/tendriller-contrib`  
**Specification Date:** 21 November 2026  
**Architecture Alignment:** Built as one piece around **`chronolog-db` (`@chronolog/peer-session`) as the central pipe**, keeping Tendriller's Worker host application-neutral (zero `node:*` imports) and basic `@tendriller/runtime` / `@tendriller/tools` decoupled from `@chronolog/*`.

### Review Corrections & Architectural Refinements (Applied Before Implementation)

1. **Central-pipe placement (`chronolog-db` owns core primitives):** Canonical lifecycle mapping (`describeOperationLifecycle`), batched idempotent command submission (`submitBatch`), unified app client facade (`createAppClient`), AES-256-GCM atomic encrypted device checkpoints with anti-split-brain retirement tombstones (`exportDeviceCheckpoint` / `restoreDeviceCheckpoint`), explicit disposable native storage (`openDisposableNativeDevice`), Node WASM SQL adapter (`@chronolog/peer-session/sql-wasm`), and relay-only `--no-native-rtc` packaging live directly in `chronolog-db` rather than being duplicated in `tendriller`.
2. **Existing Port-443 Remote HTTPS MCP Server (W5 correction):** Tendriller's Cloudflare Worker **already ships** an OAuth 2.1 + PKCE + CIMD port-443 Remote HTTPS MCP server at `POST /mcp` (`server/src/assistant-gateway.ts` + `server/src/assistant.ts`). W5 therefore extends `/mcp` with batched idempotent command submission (`call_application_commands_batch`), adds the RESTful **Outbound HTTPS Command/Status Polling Gateway** (`/api/assistant/v1/apps/:appId/*`) on the exact same `assistantRequest` Durable Object path, adds independent transport probing & proxy awareness, and adds the **Local Stdio MCP Server** (`tendril mcp-stdio`) in `@tendriller/tools`.
3. **Operation ID safety (W1 refinement):** Automatic trusted local access (`0600` Unix socket, Windows named pipe, or per-project loopback TCP bearer token) preserves caller-supplied `operationId` **verbatim** (`preserveOperationId: true`), eliminating divergence between in-process and shared local calls. Explicit third-party/restricted delegated bindings retain namespace scoping so independent agents on one shared profile cannot collide or hijack each other's operations.
4. **Honest local vs. external qualification scope (W12 / CI):** All 12 Workstreams (W1–W12) are implemented in code, tests, CI workflows, and qualification harnesses across all three repositories. Quantitative telemetry is recorded from actual local runs; external commercial cloud-agent surfaces (Meta Muse, Grok Bot, OpenAI Dots, Claude Duet, Instinct) and non-Linux OS builds remain explicitly `"unknown"` / `"pending_live_access"` until executed on those live surfaces—never fabricated.

---

## 1. Executive Summary, Guiding Principle & Non-Negotiable Mandates

Tendriller and Chronolog-DB must deliver simple ordinary operation, universal sandbox portability, and a minimal installation footprint across local developer machines (native Windows, macOS, Linux), web browsers, and all five major late-2026 cloud-agent environments (Meta Muse, Grok Bot + Cursor Cloud Agent, OpenAI Dots + Work/Codex Cloud + local desktop bridge, Claude Duet, and Instinct).

### Core Design Principle

> **Run computation wherever the agent can run it; keep device identity and application state in storage with verified persistence; introduce another reachable participant only when continued remote execution requires one.**

Automate all routine locking, attachment, recovery, and coordination so ordinary users and agents never confront internal replication jargon, and never need Docker, `systemd`, native C/C++ compilers, Emscripten, `nvm`, GNU shell utilities, or external database daemons to build, run, or resume an application.

### Static Baseline vs. Live Verification Rule

Repository state references inherit static inspection at:
- `werg/tendriller` @ `d5cb056ebc38431d485d1ca73a24e5574ba583ee`
- `werg/chronolog-db` @ `9eee773ab557da91ff4b54dd66727d761cc7246d`
- `werg/tendriller-contrib` @ `851a11bf0c764a47b73e7ab4007768de9bdb4c1a`

Throughout this plan, **Current Baseline**, **Mandatory Deliverable**, and **Live Qualification Target** are marked distinctly. Every static assumption is converted into an executable contract and automated test—nothing remains an unverified claim at release.

### Non-Negotiable Engineering Mandates

1. **Zero heavy prerequisites for ordinary use:** Docker, `systemd`, external database daemons, C/C++ compilers, Emscripten, GNU shell utilities (`tar`/`bash`/`chmod`), and runtime version managers (`nvm`, `fnm`, `pyenv`) must **never** be required to create, run, or use an application.
2. **All five execution routes are first-class deliverables:** Remote HTTP/MCP connector, bounded in-process local participant, shared local participant (with cross-platform IPC), full browser participant (including browser-led coordination), and external/serverless hosting adapters are all built, documented, and tested together.
3. **Both portable WASM SQL and prebuilt Node-API native SQL ship together:** Neither is deferred. Both are built, hardened, benchmarked, verified for bit-for-bit query parity, and published as verifiable release artifacts.
4. **Honest lifecycle and status semantics:** Never conflate `recorded`/`submitted` with `applied`, never silently downgrade SQL to events, never silently mint a fresh device identity on lock/socket failure, and never imply that a closed process or suspended browser tab is an always-on service.
5. **No unmeasured claims:** Qualitative assertions (e.g., "almost no autonomous agent will succeed") are replaced with automated, dated telemetry across all 14 Acceptance Gates.

---

## 2. Ordinary Workflow & Concept Simplification Specification

### 2.1 The Five-Step Ordinary Workflow

Every CLI command, SDK call, and MCP tool must expose this uniform, minimal mental model:

1. **Open / Prepare:** Point at a project directory (or remote app URL/MCP endpoint). Tendriller runs a fast capability probe, prepares verified runtime artifacts without overwriting existing state, and selects the best available execution route.
2. **Command:** Submit a single or batched operation with a stable logical `operationId`. Tendriller automatically attaches to a running local instance or starts one atomically, resolves startup races, and persists retry context before submission when operating in replaceable sandboxes.
3. **Inspect / Query:** Read current state or inspect an `operationId`. Responses unambiguously report `recorded`, `submitted`, `applied`, `rejected`, or `unknown` (disconnected/timed out).
4. **Save / Checkpoint:** Flush durable state locally or emit an atomic encrypted continuation checkpoint before reporting completion.
5. **Resume / Continue:** Reopen the exact same application and device identity after a process exit, turn boundary, package-loss recovery, or sandbox replacement—without manual file copying or duplicate device identities.

### 2.2 Mandatory Disposition of Confusing Concepts

A storage lock, a local IPC credential, and a replicated command-ordering rule solve different problems. They must not be bundled into one overloaded user-facing concept called "authority."

| Current Concept | Plain-Language Meaning in Current Code | Mandatory Target State | Concrete Failure Mode Prevented & Engineering Implementation |
| :--- | :--- | :--- | :--- |
| **Storage owner** | The single process permitted to write one local device's files. | **Removed from public UX (Internalized)** | Prevents concurrent-writer file corruption. Enforced internally via atomic lockfile + IPC endpoint ownership. Users and agents never select an ownership mode. |
| **Attach** | Sending requests to an already-open local instance. | **Fully Automatic** | Prevents duplicate processes fighting over one state directory. Handled transparently by automatic connect-or-start with bounded retry and startup-race resolution. |
| **Native supervisor** | A local request endpoint around an open app with locking and optional caller restrictions (runs in-process today). | **Refactored & Renamed ("Shared Local Access")** | Enables multiple local callers (e.g., two terminals or multiple Bots on one VM) to share one open app. Docs explicitly state it is *not* an OS service manager and does *not* auto-respawn crashed processes. |
| **Local client binding / capability** | Identifying and optionally restricting a caller using the local IPC endpoint. | **Automatic Trusted Default + Optional Advanced Policy** | Prevents unauthorized local access without beginner friction. Default to automatic trusted-local-caller over OS-scoped IPC (`0600` Unix socket / Windows named pipe) or per-project random 256-bit bearer token on loopback TCP. Fine-grained delegation stays opt-in under advanced docs. |
| **Coordinator / authority** | Which eligible device orders replicated commands and who can change that arrangement. | **Automated Ordinary Setup + Practical Multi-Device Controls** | Prevents split-brain ordering and unauthorized membership changes. Automated for single-device and standard multi-device setups; any remaining UI/CLI choice is framed strictly by practical consequence (*which device can apply commands, and what happens when it goes offline*). |

---

## 3. Target Cloud-Agent Environments & Capability Taxonomy

Tendriller does **not** hardcode runtime strategies by vendor brand or assume a single Node version (such as Node 22) across platforms. Instead, it selects execution routes using five measurable, overlapping capabilities:

1. **Persistent provider-managed cloud computer** (durable project directory, replaceable processes and packages).
2. **Bounded task execution** (finite turn/task lifetime; requires explicit checkpointing).
3. **Browser execution** (may run in a separate VM with independent storage and no loopback access to shell `localhost`).
4. **Connector / HTTP access** (remote HTTPS/MCP calls to an existing participant without local installation).
5. **Delegated coding / desktop bridge / external hosting surface.**

### 3.1 Platform Evidence, Operational Constraints & Mandatory Support Matrix (as of 21 November 2026)

| Target Product & Surfaces | Documented / Observed Affordances | Key Constraints, Approval Friction & Unverified Gaps | Mandatory Supported Routes |
| :--- | :--- | :--- | :--- |
| **Meta Muse** *(Cloud Linux VM / Debian container + optional Mac app)* | Dedicated Linux VM with Debian runtime container, shell/code-building tools, background work, downloadable VM files, continuous VM backup. Outbound network passes through Sentinel (may substitute credentials at network boundary); API/MCP connectors supported. | Container root $\neq$ host root. Default permission mode ("Ask for some actions") pauses for human approval on writes—**must support batched, idempotent commands**. Browser agent cannot evaluate arbitrary page JS or open DevTools—**must expose in-page readable diagnostics**. *Live probe required:* Node version, arbitrary daemon uptime, WebSocket/WebRTC through Sentinel, app-consistent DB backup. | Bounded local participant; Sentinel-compatible proxy/HTTPS gateway + relay; in-page browser diagnostics; remote MCP/API connector. |
| **Grok Bot** *(Shared Cloud Computer + optional Cursor Cloud Agent)* | Persistent browser, CLI, and `/workspace` filesystem shared by all Bots on one account (~8 vCPU / 16 GB RAM / 128 GB disk observed externally). Supports local command-based MCP and remote HTTPS MCP (connector backend policy can differ from VM egress). Optional Cursor Cloud Agent delegation with setup scripts and forwarded preview ports. | Installed packages (`node_modules`, Python venvs) are **wiped on computer replacement/recovery** and running processes are interrupted—**must support fast, nondestructive dependency reinstall over preserved `/workspace` state**. Same-account Bots share one VM—**must handle concurrent multi-bot local attach safely with per-project isolation**. Cursor snapshots expire after 30 inactive days and drop running processes. Enterprise `sudo` setup scripts (30-min timeout) must never be required. *Live probe required:* baseline Node versions, public inbound serving. | Shared running participant in `/workspace` with automatic multi-bot attach + fast reinstall recovery; local stdio & remote HTTPS MCP; independent Cursor Cloud Agent profile. |
| **OpenAI Dots** *(Cloud Computer + Work/Codex Cloud + opt-in Local Desktop Bridge)* | Dedicated computer and browser per dot; retains state between uses; spawns Work or Codex Cloud tasks (2–4 vCPU, 8–16 GB RAM, 8–32 GB disk; VM state recoverable up to 7 days by default). Opt-in ChatGPT desktop bridge enables local machine tasks and local browser fallback. | Background proactive research is **strictly read-only**. Shell egress may be restricted to managed destinations even when web search or connectors work—**must probe egress from the exact execution VM**. Codex Cloud disables computer use and separates the dot's browser from the task VM. Do not rely on legacy Codex 12-hour cache docs. *Live probe required:* exact runtimes, process lifetime, app-file retention on Work/Codex. | Capability-probed bounded local participant; explicit read-only query mode; HTTPS-only gateway & remote connector when shell egress is restricted; automated checkpoint export; local desktop bridge compatibility. |
| **Claude Duet** *(Cloud Computers + Separate Browser VM + Account Connectors)* | Background work continues after closing the app; inherits account connectors/plugins (remote MCP requires publicly reachable HTTPS port 443); outputs saved in Make tab. | Browser runs in a **dedicated VM separate from work computers**—never assume browser can reach shell `localhost`. Proactive checks run periodically, not continuously; pauses for human approval before external writes/signing. *Live probe required:* Duet shell/runtime inventory, package-install contract, arbitrary filesystem durability, daemon lifetime. | Port-443 remote HTTPS MCP connector + HTTPS polling gateway; bounded local participant + checkpoint export when shell surface is present; separate-URL browser access. |
| **Instinct** *(Delegated Task Sandbox + Separate Cloud Browser)* | Firsthand external inspection (Sept 2026) observed an E2B Ubuntu 22.04.5 task sandbox (~2 vCPU, ~1.9 GB RAM), separate persisted memory, and a separately leased cloud browser. Integrations report using outbound web calls. | Observations are not vendor guarantees. External maintainer reports background commands do **not** survive turn boundaries. Strict **~1.9 GB RAM ceiling** requires lean download/runtime/WASM memory budgets (< 256 MB RSS events / < 512 MB RSS SQL). Custom MCP is not established in vendor docs. *Live probe required:* main agent hosting, Node/npm versions, arbitrary file persistence, browser reachability. | Ultra-compact bounded CLI + outbound HTTPS gateway route; strict memory cap; atomic checkpoint export before turn exit; zero background daemon assumption. |

---

## 4. Execution Routes & Lifecycle Cost Comparison

All five routes implement the exact same application command semantics and result schema (Workstream W1).

| Execution Route | What It Enables | Installation Footprint | Persistence & Post-Exit Availability Contract |
| :--- | :--- | :--- | :--- |
| **1. Remote HTTP / MCP Connector** | Discover an existing app, submit single/batched commands, inspect operations, and query state with zero local install. | **0 MB** local install. | State and availability live on the remote participant. A connector alone does not host a new application. |
| **2. Bounded Local Participant (In-Process)** | Open retained state, run finite work, flush/checkpoint, and exit cleanly using a compatible JS runtime (no sockets/pipes/daemons). | Minimal JS bundle (`events-relay-only` or `sql-portable-relay-only`). | State persists in project storage or exported checkpoint. **After exit, this process cannot receive or apply remote commands.** |
| **3. Shared Running Participant (Local IPC)** | Multiple local callers (terminals, local MCP, multi-bot VM) automatically share one open application instance. | Same as Bounded Local + zero-dependency platform IPC adapter. | Process lifetime depends on the host VM; not an OS daemon. Automatically handles concurrent callers and refcounted disconnects. |
| **4. Browser Participant & Browser Coordinator** | Run the app (including WASM SQL and optional write coordination) directly in a qualified browser tab/worker. | Static web bundle + WASM SQL assets (loaded on demand). | State persists in OPFS/IndexedDB (verified via `navigator.storage.persist()`). **A closed or suspended browser tab is not an always-on service**; supports encrypted checkpoint export/handoff. |
| **5. External / Serverless Host** | Continuous remote command acceptance when the originating agent sandbox exits. | Ordinary Node process, container, OS service, or `ServerlessHostAdapter`. | Continues applying commands after agent sandbox exit according to the chosen host's uptime and storage contract. |

---

## 5. Concurrent Implementation Workstreams (W1 – W12)

All twelve workstreams are mandatory and execute concurrently against shared versioned contracts.

### Workstream W1: Unified Application Interface & Operation ID Contract (`tendriller`, `chronolog-db`)

* **Current Baseline:** `tendriller/session/native.mjs` transforms operation IDs using app/client binding, whereas `tendriller/tools/cli/lib/session.mjs` passes them through verbatim. Command recording/submission is separate from coordinator application (`chronolog-db/packages/peer-session/src/application-data.ts`).
* **Mandatory Deliverables:**
  1. **Unified Application API:** Define one canonical TypeScript/ESM interface (`openApp`, `submitCommand`, `submitBatch`, `inspectOperation`, `query`, `flush`, `checkpoint`, `publish`, `enroll`, `close`) implemented uniformly across all five execution routes.
  2. **Unified Operation ID Contract (Hard Prerequisite):** Eliminate the operation ID divergence between `session/native.mjs` and `tools/cli/lib/session.mjs`. Every operation carries a canonical, caller-stable `{ appId, deviceId, operationId }` tuple (caller-supplied idempotency key or generated UUIDv7) preserved verbatim across bounded in-process, shared IPC, HTTP/MCP gateway, browser, and checkpoint recovery.
  3. **Canonical Command Lifecycle States:** Standardize structured response envelopes (`--json`, SDK, MCP) distinguishing:
     - `recorded`: durably written to local device log/outbox, not yet confirmed by coordinator.
     - `submitted`: transmitted to coordinator/relay, awaiting ordering confirmation.
     - `applied`: ordered and committed to replicated state (includes sequence/commit reference).
     - `rejected`: definitively rejected with machine-readable error code and reason.
     - `unknown`: connection lost or timeout exceeded before confirmation; safe to reconcile via `inspectOperation(operationId)`.
  4. **Pre-Submission Outbox Persistence:** Before transmitting any mutating command in bounded or replaceable-sandbox modes, atomically persist `{ operationId, deviceId, appId, payloadHash, createdAt }` to the durable state/checkpoint directory so a lost response followed by sandbox destruction can still be reconciled without duplicate side effects.
  5. **Non-Disruptive Maintenance & Batching:** Route `publish`, `enroll`, `checkpoint`, and `inspect` through the running instance's API so callers never stop an active app for routine maintenance. Support batched, idempotent command submission (`submitBatch`) to minimize write-approval friction on platforms like Meta Muse and Claude Duet.

### Workstream W2: Automatic Connect-or-Start & Cross-Platform IPC Adapter (`tendriller`)

* **Current Baseline:** `tendriller/session/native.mjs` explicitly rejects Windows and relies on Unix domain sockets and POSIX filesystem ownership checks.
* **Mandatory Deliverables:**
  1. **In-Process Bounded Mode (Zero IPC):** Direct in-process execution path (`--mode bounded` or auto-selected when background processes do not survive turns) that acquires an exclusive atomic lockfile, executes work, flushes, and exits with zero sockets or pipes.
  2. **Cross-Platform Shared Local Access IPC Adapter:** Remove the Windows rejection and POSIX `uid`/`gid` checks. Implement three interchangeable transports behind one adapter interface:
     - **Linux / macOS:** Unix domain socket in the state directory (or short hashed path under `$XDG_RUNTIME_DIR` / `os.tmpdir()` if path length exceeds 100 bytes) with `0600` permissions.
     - **Windows:** Native Node.js Windows named pipe (`\\.\pipe\tendriller-<sha256(canonicalProjectPath)>`) using standard `net.createServer` / `net.connect`.
     - **Restricted Container Fallback (Loopback TCP):** Bind to `127.0.0.1:0` (ephemeral port), atomically write `{ port, token, pid, appId, deviceId }` to a `0600`-protected endpoint descriptor file, and enforce constant-time comparison of a 256-bit random per-project bearer token on every request (preventing local CSRF, DNS rebinding, and cross-project interference).
  3. **Atomic Connect-or-Start State Machine:**
     - Resolve canonical project path, `appId`, and retained `deviceId`.
     - Probe endpoint descriptor; if a live matching instance passes an identity handshake (`appId` + `deviceId` match), attach automatically.
     - If no live instance exists, acquire an exclusive atomic lockfile (`O_CREAT | O_EXCL` with PID, start timestamp, host ID, and endpoint info).
     - If lock creation fails with `EEXIST` (concurrent caller won the startup race), back off with bounded jitter (50 ms $\rightarrow$ 500 ms, max 5 s) and attach to the winning instance.
     - **Stale Endpoint Recovery:** Reclaim a lock only when (a) IPC connect fails with `ENOENT`/`ECONNREFUSED`, (b) PID liveness confirms the holder is dead (or lease heartbeat expired), and (c) atomic swap succeeds (bounded to 2 retries).
     - **Ambiguous State Safety:** If the lock is held by a live but unresponsive process, return structured error `INSTANCE_UNRESPONSIVE` with PID/endpoint details. **Never** silently mint a new `deviceId`, wipe state, or spawn a second writer.
  4. **Reference-Counted Caller Disconnect:** Disconnecting one caller decrements active caller count without killing an instance still serving other callers.
  5. **Pure-JS Archive & Filesystem Utilities:** Remove all dependencies on GNU `tar`, `unzip`, `chmod`, `chown`, or `bash` in favor of pure Node/JS atomic file and archive operations.

### Workstream W3: Portable SQL Engine — Node WASM Adapter AND Prebuilt Node-API Native Binaries (`chronolog-db`, `tendriller`)

* **Current Baseline:** `chronolog-db` already embeds SQLite for the native record store (`packages/records/src/native.ts`), has a WASM build script (`tools/build-wasm-engine.mjs`) and Node conformance test (`packages/materializer-doltlite/src/wasm-conformance.test.ts`), and builds native SQL for Linux and macOS Intel in `.github/workflows/release.yml`. Native SQL rejects `:memory:` (`packages/materializer-doltlite/src/driver.ts`).
* **Mandatory Deliverables:**
  1. **Production Node WASM SQL Engine Adapter (`chronolog-db`):**
     - Build a production Node loader for Chronolog's prebuilt WASM SQL engine.
     - **Synchronous VFS Bridge for Node:** Explicitly bridge the architectural split between the async journal `BytesStore` (`packages/records/src/bytes-store.ts`) and the SQL engine's synchronous filesystem interface (`packages/materializer-doltlite/src/types.ts`). Implement a crash-safe, `fsyncSync`-backed synchronous Node filesystem VFS for WASM SQL with atomic journal/WAL semantics matching native SQLite durability.
     - **Memory Ceiling Discipline:** Configure WASM initial/maximum linear memory and page cache bounds so peak RSS stays under **512 MB** for SQL workloads (and under **256 MB** for events workloads) on constrained ~1.9 GB RAM hosts like Instinct.
     - Pass full `wasm-conformance.test.ts` in CI across Linux, macOS, and Windows—verifying bit-for-bit query parity, persistent close-and-reopen durability, and simulated mid-write crash recovery against native execution.
  2. **Prebuilt Node-API Native SQL Binaries (`chronolog-db`):**
     - Extend `.github/workflows/release.yml` to build, hash, and durably publish prebuilt Node-API (N-API) native SQL binaries for:
       - `linux-x64-gnu` (glibc baseline documented, e.g., Ubuntu 22.04+) & `linux-arm64-gnu`
       - `linux-x64-musl` (Alpine/container compatibility)
       - `darwin-arm64` (Apple Silicon) & `darwin-x64` (Intel)
       - `win32-x64` (Native Windows)
     - Use Node-API ABI stability so one binary per OS/arch works across Node 22.15+, Node 24+, and future LTS releases without multiplying builds per Node major version.
  3. **Engine Selection & State-Model Integrity:**
     - Events-only apps install zero SQL assets.
     - SQL apps load prebuilt WASM SQL as the universal zero-compile default (or select the matching verified prebuilt Node-API native binary where available and configured).
     - Failure to provision SQL **never** silently downgrades an app to events—returns structured `SQL_ENGINE_UNAVAILABLE` with diagnostics and viable routes.
  4. **Explicit Disposable Storage Modes (Replacing Universal `:memory:`):**
     - **Disposable Events (`--storage disposable`):** Uses in-memory `BytesStore`.
     - **Disposable SQL (`--storage disposable`):** Allocates a managed temporary directory under `os.tmpdir()/tendriller-disposable-<uuid>` with clean-exit (`exit`/`SIGINT`/`SIGTERM`) recursive removal and explicit session metadata `ephemeral: true, resumable: false`.

### Workstream W4: Complete Browser Participant & Browser-Led Coordination (`chronolog-db`, `tendriller`)

* **Current Baseline:** Native and browser entry points share the peer runtime (`packages/peer-session/src/session.ts`), and `coordinator: false` / `recovery: false` in `docs/tutorial/pairing-native.mjs` is a starter policy rather than a runtime ban. Browser packaging does not yet expose the complete SQL browser entry point.
* **Mandatory Deliverables:**
  1. **Complete Browser SQL Bundle:** Update `chronolog-db/tools/package-peer-session.mjs` (using its SQL capability switches) to emit a self-contained browser SQL bundle exposing the verified SQL browser/worker entry point alongside the four WASM assets.
  2. **Browser Coordinator Mode & Multi-Tab Safety:**
     - Implement a first-class **Browser-Led Coordinator Mode** with complete setup, pairing, command ordering, and continuity flows.
     - Use the **Web Locks API** (`navigator.locks`) to guarantee single-writer coordination and automatic multi-tab leader election across tabs of the same origin.
     - Persist device identity, journal, and WASM SQL state in **OPFS** (Origin Private File System via sync access handles inside a Dedicated Worker) with automatic **IndexedDB** fallback for events-only apps or browsers without OPFS sync handles.
     - Request `navigator.storage.persist()` on initialization and surface the actual granted/denied persistence status honestly.
  3. **Suspension, Eviction & Handoff Resilience:**
     - Flush pending writes and update local checkpoint state on `visibilitychange` (hidden), `pagehide`, and `freeze` lifecycle events.
     - Provide one-click and programmatic encrypted private checkpoint export/import from the browser so users and agents can migrate or recover a browser coordinator before tab eviction or cloud-browser lease expiry.
     - Surface honestly in UI and API status that a closed or suspended browser tab cannot accept remote commands until reopened or handed off to another eligible coordinator.
  4. **DevTools-Free In-Page Diagnostics Surface:**
     - Embed a lightweight, toggleable diagnostics panel and machine-readable DOM JSON block (`<script type="application/json" id="tendriller-diagnostics">`) in every starter web app reporting live pass/fail status for: Web Workers, WebAssembly, OPFS vs. IndexedDB persistence grant, Web Locks leader status, WebCrypto, relay WebSocket/HTTPS reachability, coordinator status, and last applied operation ID. This allows browser agents without JS injection or DevTools (such as Meta Muse) to diagnose browser health directly from page content.

### Workstream W5: Outbound-First Networking, HTTPS Polling Gateway & Local/Remote MCP (`tendriller`, `chronolog-db`)

* **Current Baseline:** Tendriller's Cloudflare Worker already serves an OAuth 2.1 + PKCE + CIMD Remote HTTPS MCP server at `/mcp` (`server/src/assistant-gateway.ts` + `server/src/assistant.ts`). Missing pieces are batched command submission, an HTTPS-only REST command/status polling gateway for non-MCP HTTPS sandboxes, independent transport probing with proxy awareness, and a Local Stdio MCP server backed by automatic connect-or-start.
* **Mandatory Deliverables:**
  1. **Zero Inbound Sandbox Ports & Proxy Awareness:** All agent-side transports operate exclusively via outbound connections, honoring `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and system/custom CA certificates (never disabling TLS verification). Document package registry, release-asset CDN, app origin, and relay destinations as separately allowlistable hosts.
  2. **Separated Transport Probing:** Probe (a) HTTPS 443, (b) WebSocket `wss://` over 443, and (c) WebRTC data channels independently—never infer WebSocket or WebRTC support from a passing HTTPS request.
  3. **Outbound HTTPS Command/Status Polling Gateway:**
     - Implement a lightweight, authenticated HTTPS gateway adapter (`POST /v1/apps/:appId/commands`, `POST /v1/apps/:appId/commands/batch`, `GET /v1/apps/:appId/operations/:opId`, `GET /v1/apps/:appId/query`, `GET /v1/apps/:appId/events?since=...`) for HTTPS-only environments where WebSockets and WebRTC are blocked (e.g., Meta Muse Sentinel, restricted Codex Cloud egress, Instinct outbound HTTPS).
     - Preserve exact canonical `operationId` idempotency and status semantics (`recorded`/`submitted`/`applied`/`rejected`/`unknown`).
  4. **Local Stdio MCP & Remote Port-443 HTTPS MCP Servers:**
     - Ship a spec-compliant **Local Stdio MCP Server** (for Grok Bot local MCP, Cursor, local coding agents) backed directly by automatic connect-or-start.
     - Ship a spec-compliant **Remote HTTPS MCP Server** (Streamable HTTP / SSE over HTTPS port 443 with OAuth/bearer auth compatible with Claude Duet remote MCP, Grok Bot remote MCP, and Meta Muse connectors) exposing the five-step workflow (`app_discover`, `command_submit`, `command_submit_batch`, `operation_inspect`, `state_query`, `checkpoint_export`).
     - Keep platform-held connector credentials strictly separate from internal application device keys.

### Workstream W6: Verified Single-Command Bootstrapper & Capability Probe (`tendriller`, `tendriller-contrib`)

* **Current Baseline:** `tendriller/scripts/check-published-release.mjs` and `tendriller-contrib/distribution/download-core-release.mjs` implement release verification separately.
* **Mandatory Deliverables:**
  1. **Shared Verification Core:** Extract and share the release download/verification engine and conformance fixtures across `tendriller` and `tendriller-contrib` (controlled redirect allowlists, byte/timeout caps, SHA-256 hash agreement, atomic pure-Node archive extraction).
  2. **Dual Distribution Entry Points:**
     - Pinned npm/npx invocation: `npx --yes @werg/tendriller@<exact-version> ...`
     - Standalone, zero-dependency, single-file ESM bootstrapper (`tendriller-bootstrap.mjs`) downloadable directly over HTTPS with published SHA-256 checksum for sandboxes without npm registry access.
  3. **Compact Non-Intrusive Capability Probe (`tendriller probe --json`):**
     - Runs automatically before expensive downloads and standalone for qualification. Inspects only ordinary user-facing interfaces (never private vendor internals) and outputs structured JSON recording:
       - Context: `product`, `executionSurface`, `plan`, `observedAt` (ISO-8601), `os`, `arch`, `libc`.
       - Runtime: Node/Bun/Deno version, `node:sqlite` availability, WASM support, `dlopen`/native addon support, available RAM and disk.
       - Storage: writable project path, atomic rename/lock support, disposable temp dir, and observed save/reopen result (separating same-session persistence from post-replacement survival).
       - Networking: independent reachability for npm, release assets, app origin, HTTPS gateway, and `wss://` relay, plus proxy env detection.
       - Lifecycle & Surfaces: IPC adapter availability, background process check, browser/connector availability.
       - `recommendedRoutes`: ranked list of viable routes with exact reasons for any unavailable route; untested items remain explicitly `"unknown"`.
  4. **Strict Bootstrapper Guarantees:**
     - **Nondestructive Restart:** Re-running after interruption or Grok-style `node_modules` wipes preserves existing project config and device identity.
     - **Clean Streams & Exit Codes:** Structured JSON on `stdout`, progress/warnings on `stderr`, semantic exit codes (`0` ready, `2` capability missing with viable alternative, `3` integrity/verification failure, `4` lock/instance conflict).
     - **Four Explicit Readiness States:** `project_prepared`, `app_initialized`, `participant_reachable`, `command_applied`.
     - **Strict Pinning:** Explicit `--origin` and `--release` pinning, exact UI build tool version pinning, and zero silent fallbacks (never swap origins, jump releases, trigger source builds, or downgrade SQL to events).

### Workstream W7: Versioned Cross-Repository Composition Contracts & Minimal SQL Starter UI (`chronolog-db`, `tendriller`)

* **Current Baseline:** `tendriller/scripts/release-composition.mjs` enforces a single SQL-free graph with mandatory native RTC support. `docs/STATE_MODELS.md` provides partial SQL runtime pieces rather than a finished starter UI.
* **Mandatory Deliverables:**
  1. **Versioned Composition Manifest (`v2`) & Relay-Only Profiles:** Update `chronolog-db/tools/package-peer-session.mjs`, `tendriller/scripts/release-composition.mjs`, producer CI, discovery, verifiers, and consumers atomically as a versioned `v2` contract supporting four explicit profiles:
     - `events-relay-only` (zero SQL, zero native WebRTC — smallest possible footprint)
     - `events-full` (events + WebRTC)
     - `sql-portable-relay-only` (prebuilt WASM SQL + optional native SQL, zero native WebRTC)
     - `sql-full` (prebuilt WASM + native SQL + WebRTC)
  2. **Minimal Working End-to-End SQL Starter UI:** Build and ship a complete, runnable SQL starter web page (schema initialization, command submission, SQL query view, operation status inspector, checkpoint export button, and embedded diagnostics panel) so `tendriller create --model sql` works end-to-end with zero manual UI wiring.

### Workstream W8: Multi-Runtime Qualification — Node 22.15+, Node 24+, Bun & Deno (`tendriller`, `chronolog-db`)

* **Current Baseline:** Tutorial packages declare Node 24 (`docs/tutorial/package.json`, `docs/tutorial/sql/package.json`), while `scripts/test-collaboration.mjs` uses a Node 22.15 test-shim workaround.
* **Mandatory Deliverables:**
  1. **Zero `nvm` Requirement:** Never install `nvm` or any runtime version manager automatically.
  2. **Full Node 22.15+ & Node 24+ Artifact Qualification:** Exercise the exact packed `events` and `sql` starters (init, persistence, reopen, concurrent IPC attach, commands, publication, relay/HTTPS transport) on Node 22.15, Node 22 LTS latest, and Node 24 LTS latest across Linux, macOS, and Windows. Fix incompatibilities (removing ad-hoc test-shim workarounds) and update `engines.node` to `>=22.15.0` strictly on passing artifact evidence.
  3. **Bun & Deno Compatibility Pass:** Run the exact packed `events` and WASM-SQL starters under current Bun and Deno releases, fixing pure-ESM/Web-standard portability bugs where feasible and recording exact pass/fail capability flags in the published compatibility matrix.

### Workstream W9: Automated Handoff, Checkpointing & Anti-Split-Brain Recovery (`tendriller`)

* **Current Baseline:** `docs/BUILD_AN_APP.md` documents manual private checkpoints and warns that temporary setup credentials expire after 24 hours.
* **Mandatory Deliverables:** Automate all three distinct continuity flows so agents never manually copy SQLite sidecar files or stash private keys in undocumented memory folders:

| Command / Flow | Purpose | Artifact Contents & Safety Guarantees |
| :--- | :--- | :--- |
| `tendriller handoff source <out>` | Continue building an **uninitialized** project in another sandbox. | Non-secret source files, pinned `v2` release composition, config, build inputs, and exact next command. Verified to contain zero private keys or device state. |
| `tendriller checkpoint export <out>` / `tendriller checkpoint restore <in>` | Move or recover an **initialized** device across sandbox replacement or turn boundaries. | Encrypted, atomic snapshot of device identity, consistent record store + SQLite state (quiesced and flushed via SQLite backup/checkpoint API—never raw sidecar copy), and pending outbox `operationId`s. Automatically verifies reopen integrity on restore and marks the exported source instance retired/tombstoned to prevent two active copies of the same device. Never relies on 24-hour setup credentials. |
| `tendriller device enroll` | Add a **new device** to an existing app. | Uses existing enrollment/continuity flow while an authorized participant is reachable; explains coordinator eligibility and offline consequences in plain language. |

### Workstream W10: Complete Deployment Decision Guide & Serverless Host Adapter (`tendriller`, `tendriller-contrib`)

* **Mandatory Deliverables:** Replace the single "minimal always-on recipe" with a concise decision guide and tested, runnable templates for every hosting tier—explicitly documenting what each installs, where state lives, inbound port requirements, restart behavior, and clean exit/migration:
  1. **Agent's existing cloud computer** (when runtime + storage + lifetime qualify).
  2. **Bounded local execution + automated checkpoint** (zero background process).
  3. **Browser participant / coordinator or Remote MCP connector.**
  4. **Standalone ordinary Node process** (lightweight external default; zero Docker, zero `systemd`).
  5. **Container (OCI/Docker) recipe** (minimal non-root image, volume-backed state, clean `SIGTERM` flush).
  6. **OS Service recipes** (`systemd`, `launchd`, Windows Service).
  7. **Request-Driven / Serverless Host Adapter (`ServerlessHostAdapter`):** Explicitly build the storage, state-locking, and stateless HTTPS request-handling adapter required for request-driven serverless/Worker runtimes (backing `BytesStore` + checkpointed SQL snapshots with durable object / external transactional storage), rather than claiming the filesystem/socket native process runs unmodified on a Worker.

### Workstream W11: Contributor Fast Lane & Independent Distribution CI (`chronolog-db`, `tendriller-contrib`)

* **Current Baseline:** SQL tests inside `packages/peer-session/src/sql.test.ts` and `packages/peer-generation/src/sql.test.ts` transitively import native SQL materialization. `tendriller-contrib/.github/workflows/peer-generation.yml` qualifies source builds.
* **Mandatory Deliverables:**
  1. **`chronolog-db/AGENTS.md`:** Author a concise, machine-friendly root guide specifying exact install, fast-test, full-test, and package commands, package boundaries, and verification rules.
  2. **Import-Closure Fast Test Tier (`npm run test:fast`):** Define the fast tier strictly by **actual import closure**—excluding all tests that transitively import native SQL materialization (explicitly including `peer-session/src/sql.test.ts` and `peer-generation/src/sql.test.ts`, not just `materializer-doltlite`). Document an `--ignore-scripts` install path for JS-only contributor work, and measure fast-test duration, minimal install size, and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` independently.
  3. **`tendriller-contrib` Released-Artifact Qualification CI:** Extend `.github/workflows/peer-generation.yml` (and add a cross-OS matrix) to install and test **actual published release artifacts** on Linux (`x64`/`arm64`), macOS (`arm64`/`x64`), and native Windows (`x64`) with `npm ci --ignore-scripts`, **no** C/C++ compiler, **no** Python build toolchain, **no** Emscripten, and **no** Docker. Retain source-build qualification as a separate CI job.

### Workstream W12: Live Five-Platform Cloud-Agent Qualification Suite (`tendriller-contrib`)

* **Mandatory Deliverables:**
  1. Run `tendriller probe --json` and all applicable Acceptance Gates across all five target cloud-agent products (Meta Muse, Grok Bot + Cursor Cloud Agent, OpenAI Dots + Work/Codex Cloud + desktop bridge, Claude Duet, Instinct) using disposable test applications (never resetting a user's cloud computer).
  2. Publish a versioned, dated `QUALIFICATION_MATRIX.md` and `qualification-matrix.json` in `tendriller-contrib` recording exact `product`, `surface`, `plan`, `observedAt`, full capability probe JSON, quantitative telemetry, and explicit pass/fail separation of:
     - `use_existing_app_via_connector`
     - `create_and_run_events_app`
     - `create_and_run_sql_app`
     - `checkpoint_and_resume_across_replacement`

---

## 6. Concurrent Execution & Technical Dependency Graph

All twelve workstreams execute concurrently along four parallel tracks. There are no deferred phases; the initiative completes only when all four tracks converge and pass all 14 Acceptance Gates.

```text
Track 1 (Core API, Lifecycle & Portability):
  W1 (Unified API + Op IDs + Outbox) ──► W2 (Connect-or-Start + Win/Unix/Loopback IPC)
                                                  │
Track 2 (Portable SQL & Packaging):               ├──► W6 (Shared Verifier + Bootstrapper + Probe)
  W3 (Node WASM VFS + Node-API Binaries) ─────────┤            │
  W7 (v2 Composition + Relay-Only + SQL UI) ──────┤            ├──► W9 (Automated Handoff & Checkpoints)
  W8 (Node 22.15+/24+ + Bun/Deno Qualification) ──┘            │    W10 (Hosting Recipes + Serverless Adapter)
                                                               │
Track 3 (Browser & Outbound Remote Access):                    │
  W4 (Browser Coordinator + Web Locks + In-Page Diagnostics) ──┤
  W5 (Proxy Transport + HTTPS Polling Gateway + Remote MCP) ───┤
                                                               ▼
Track 4 (CI & Live Qualification):                    All 14 Acceptance Gates
  W11 (AGENTS.md + Import-Closure Fast Tier +      ──► + Dated 5-Platform Telemetry
       Contrib --ignore-scripts Artifact CI)             Matrix (W12)
```

---

## 7. Unified Definition of Done: 14 Mandatory Acceptance Gates & Telemetry

Every gate below must pass automatically in CI or in a recorded qualification run before this initiative is marked complete. All failure/destruction scenarios run strictly against disposable test applications.

### 7.1 The 14 Mandatory Acceptance Gates

1. **Minimal Zero-Toolchain Start:** Create, initialize, and apply a command to an `events` app using the verified bootstrapper without cloning `chronolog-db`, compiling native code, installing Docker, installing `nvm`, or configuring `systemd`.
2. **Concurrent Local Callers:** Launch two local callers simultaneously against one unstarted project; verify both converge on a single shared instance via automatic connect-or-start with zero manual ownership prompts and zero data corruption.
3. **Interrupted Response & Destroyed Sandbox:** Persist `operationId` and retry context before submission, submit a command, destroy the originating sandbox before receiving the response, restore the private checkpoint in a fresh sandbox, and reconcile the exact `operationId` with zero duplicate side effects and unchanged device identity.
4. **Clean Process Resume:** Stop the local participant cleanly and reopen the exact same application and device identity from durable storage/checkpoint.
5. **Dependency-Loss Environment Replacement (Grok Bot Scenario):** Wipe all installed packages (`node_modules` and caches) while preserving project files (`/workspace` equivalent), run the nondestructive restore/reopen command, and resume the app with intact identity and history.
6. **Post-Exit Availability Honesty:** Stop the creating agent's execution and query/command the app from an independent client; verify actual behavior matches the exact availability contract of the selected route (unavailable for standalone bounded local; available when backed by an external participant or active browser coordinator).
7. **Browser VM Separation & DevTools-Free Diagnostics:** Open the actual reachable app URL from an isolated browser environment (no loopback access to shell `localhost`), read browser health directly from `<script type="application/json" id="tendriller-diagnostics">` without DevTools or JS injection, and apply a command.
8. **Browser-Led Coordination & Recovery:** Initialize an app with a browser device as coordinator, execute commands across two tabs (verifying Web Locks leader election), flush/export an encrypted checkpoint on simulated tab freeze/close, and restore continuity in a fresh browser or native participant.
9. **Portable SQL Parity (WASM + Native):** Install released SQL assets with `--ignore-scripts`, zero C/C++ compilers, and zero Emscripten; run representative DDL/DML commands via the minimal SQL starter UI; close and reopen persistent state; verify bit-for-bit query parity between Node WASM SQL and Node-API native SQL.
10. **Native Windows End-to-End:** Complete bootstrap, concurrent attach (via Windows named pipes), command execution, SQL persistence/reopen, and checkpoint export/restore on native Windows (`win32-x64`) without WSL or POSIX checks.
11. **HTTPS-Only & Remote MCP Fallback:** Block WebSockets and WebRTC at the network layer; execute discover, batched command, inspect, and query flows cleanly through the outbound HTTPS polling gateway and port-443 Remote MCP server.
12. **Node 22.15+ & Node 24+ Matrix:** Pass the full packed `events` and `sql` starter qualification suites on both Node 22.15+ and Node 24+ across Linux, macOS, and Windows (plus recorded Bun/Deno compatibility results).
13. **Restricted Network / Capability Degradation:** When npm, Node, WebSockets, browser storage, or connectors are individually disabled, return exit code `2` with a clear JSON capability report and a viable next route—never silently downgrading SQL to events or swapping origins.
14. **Contributor Fast Lane & Independent Release CI:** Run `chronolog-db`'s import-closure `npm run test:fast` in `< 15` seconds with zero native builds, and pass `tendriller-contrib`'s released-artifact CI matrix with `--ignore-scripts` and no compiler/Emscripten/Docker.

### 7.2 Mandatory Quantitative Telemetry Scorecard

Every release candidate and qualified target surface must publish a dated scorecard recording:

| Metric | Measurement Definition | Target / Ceiling |
| :--- | :--- | :--- |
| **Cold download size (MB)** | Measured separately for `events-relay-only`, `sql-portable-relay-only` (WASM vs. native), browser bundle, and standalone bootstrapper. | Recorded per profile; zero compiler/browser bloat in core profiles. |
| **Cold install-to-ready time (s)** | Elapsed time from empty directory to `project_prepared` and `app_initialized`. | Recorded per OS and cloud target. |
| **Time to first applied shared command (s)** | End-to-end elapsed time to first `applied` command across two participants. | Recorded per route. |
| **Peak RSS memory (MB)** | Measured separately for `events`, Node WASM SQL, and Node-API native SQL under representative starter workloads. | `< 256 MB` RSS (events); `< 512 MB` RSS (SQL) to fit ~1.9 GB RAM sandboxes. |
| **Human approval / intervention steps** | Count of human prompts required to create, run, and query an app on write-approval platforms (Meta Muse, Claude Duet). | Minimized via batched idempotent operations. |
| **Checkpoint recovery & reconciliation rate (%)** | Pass rate across simulated crash, lost-response, and sandbox-replacement runs. | `100%` (zero duplicate effects, zero identity loss). |