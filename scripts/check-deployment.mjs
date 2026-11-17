import { readFileSync } from "node:fs";
import { requireService } from "../contract/client.mjs";
// Smoke check the public endpoints after each deployment.
const base = process.argv[2];
if (!base || !/^https:\/\/[a-z0-9.-]+$/.test(base)) {
  throw new Error("Usage: node scripts/check-deployment.mjs https://service-host");
}

async function get(path, headers) {
  let error;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(new URL(path, base), { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response;
    } catch (cause) {
      error = cause;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw error;
}

const health = await (await get("/health")).json();
if (health?.ok !== true) throw new Error("Health response did not report ok: true");
const status = await (await get("/status")).text();
if (!/Operational|New page creation paused|Read-only or unavailable/.test(status))
  throw new Error("Service status did not read the account database");
// A static health response and D1 read can pass after the account-wide Durable
// Object storage quota is exhausted. Touch one nonexistent, fixed Tendril so
// its SQLite-backed namespace must complete a real read before deployment is
// reported healthy. The missing tendril is the expected result.
const objectResponse = await fetch(new URL("/api/t/aaaaaaaaaaaa", base), { signal: AbortSignal.timeout(15_000) });
const objectResult = await objectResponse.json().catch(() => null);
if (objectResponse.status !== 404 || objectResult?.error?.message !== "No such tendril") {
  throw new Error(`Durable Object storage readiness failed: HTTP ${objectResponse.status}`);
}
const guide = await (await get("/agent.md")).text();
if (!guide.includes("Tendriller")) throw new Error("Agent guide is missing or incomplete");
console.log(`Deployment smoke check passed: ${base}`);

const descriptor = await (await get("/api/service")).json();
// Browser Integrity Check can reject ordinary automated clients before this
// Worker runs. Keep Python's default urllib user agent in the live smoke test.
const automated = await get("/api/service", { "User-Agent": "Python-urllib/3.12" });
if (!(automated.headers.get("content-type") || "").includes("application/json")) {
  throw new Error("Automated clients are blocked before reaching the API");
}
const automatedGuide = await (await get("/agent.md", { "User-Agent": "Python-urllib/3.12" })).text();
if (!automatedGuide.includes("Tendriller")) throw new Error("Automated clients cannot read the agent guide");
requireService(descriptor);
if (!descriptor.limits?.participant) throw new Error('The service must advertise its filtered participant contract');
const runtime = JSON.parse(readFileSync(new URL("../server/src/runtime-release.json",import.meta.url)));
const manifest = await (await get(`/_tendril/runtime/${runtime.id}/manifest.json`)).json();
if(manifest.id!==runtime.id)throw Error("Runtime artifact mismatch");
console.log(`Matched contract ${descriptor.contract}, runtime ${runtime.id} with the filtered participant transport`);
