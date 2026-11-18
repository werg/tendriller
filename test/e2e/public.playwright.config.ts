import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "public.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/public",
  use: { browserName: "chromium", actionTimeout: 15_000, navigationTimeout: 20_000,
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined }, ignoreHTTPSErrors: false,
    trace: "off", screenshot: "off" },
});
