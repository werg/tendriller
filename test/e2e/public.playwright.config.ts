import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "public.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/public",
  use: { browserName: "chromium", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined }, storageState: ".e2e-auth.json", ignoreHTTPSErrors: false,
    trace: "retain-on-failure", screenshot: "only-on-failure" },
});
