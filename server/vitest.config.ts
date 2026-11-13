import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: join(here, "wrangler.jsonc") },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
