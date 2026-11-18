import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "public.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/public",
  use: { browserName: "chromium", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined }, ignoreHTTPSErrors: false,
    trace: "off", screenshot: "off" },
});
