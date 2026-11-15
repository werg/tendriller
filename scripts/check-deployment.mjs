import { readFileSync } from "node:fs";
import { requireService } from "../contract/client.mjs";
// Smoke check the public endpoints after each deployment.
const base = process.argv[2];
if (!base || !/^https:\/\/[a-z0-9.-]+$/.test(base)) {
  throw new Error("Usage: node scripts/check-deployment.mjs https://service-host");
}

async function get(path) {
  let error;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15_000) });
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
const lock = JSON.parse(readFileSync(new URL("../composition.lock.json",import.meta.url)));
requireService(descriptor,{contract:lock.contract,workflows:lock.workflow.interfaces});
for(const module of descriptor.workflows) if(module.implementation_version!==lock.workflow.sha256) throw new Error(`Unexpected implementation: ${module.id}`);
const runtime = JSON.parse(readFileSync(new URL("../server/src/runtime-release.json",import.meta.url)));
const manifest = await (await get(`/_tendril/runtime/${runtime.id}/manifest.json`)).json();
if(manifest.id!==runtime.id)throw Error("Runtime artifact mismatch");
console.log(`Matched contract ${descriptor.contract}, runtime ${runtime.id} and workflow ${lock.workflow.sha256}`);
