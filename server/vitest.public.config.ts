import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = await readD1Migrations(join(here, "migrations"));
export default defineConfig({
  root: here,
  plugins: [cloudflareTest({ wrangler: { configPath: join(here, "wrangler.public-test.jsonc") } })],
  test: { include: ["test/public.test.ts", "test/admission.test.ts", "test/presence.public.test.ts"], testTimeout: 30_000, provide: { d1Migrations: migrations } },
});
