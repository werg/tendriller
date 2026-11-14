import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "public.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { browserName: "chromium", storageState: ".e2e-auth.json", ignoreHTTPSErrors: false },
});
