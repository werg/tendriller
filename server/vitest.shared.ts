import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
export async function workerTestConfig(main: string, include: string[]) {
  const migrations = await readD1Migrations(join(here, "migrations"));
  return defineConfig({
    root: here,
    plugins: [cloudflareTest({ main: join(here, main), wrangler: { configPath: join(here, "wrangler.public-test.jsonc") } })],
    // Each file starts workerd and real protocol peers. Keep finite transport
    // deadlines meaningful when browser qualification shares a developer host.
    test: { include, maxWorkers: Math.min(4, availableParallelism()), setupFiles: ["test/setup.ts"], testTimeout: 30_000, provide: { d1Migrations: migrations } },
  });
}
