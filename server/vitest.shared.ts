import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
export async function workerTestConfig(main: string, include: string[]) {
  const migrations = await readD1Migrations(join(here, "migrations"));
  return defineConfig({
    root: here,
    plugins: [cloudflareTest({ main: join(here, main), wrangler: { configPath: join(here, "wrangler.public-test.jsonc") } })],
    test: { include, setupFiles: ["test/setup.ts"], testTimeout: 30_000, provide: { d1Migrations: migrations } },
  });
}
