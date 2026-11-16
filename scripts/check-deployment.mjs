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
if (descriptor.workflows.length) throw new Error('The default service must have an empty trusted workflow registry');
const runtime = JSON.parse(readFileSync(new URL("../server/src/runtime-release.json",import.meta.url)));
const manifest = await (await get(`/_tendril/runtime/${runtime.id}/manifest.json`)).json();
if(manifest.id!==runtime.id)throw Error("Runtime artifact mismatch");
console.log(`Matched contract ${descriptor.contract}, runtime ${runtime.id} with no application workflow installed`);
