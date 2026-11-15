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
