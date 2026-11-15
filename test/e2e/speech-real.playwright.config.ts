import { defineConfig } from "@playwright/test";

// The model test serves its own immutable assets. No OAuth, Worker, R2 or mic.
export default defineConfig({
  testDir: ".", testMatch: "real-speech.spec.ts", workers: 1, timeout: 180_000,
  reporter: [["list"]], outputDir: "../../test-results/speech-real",
  use: { browserName: "chromium", headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
    trace: "retain-on-failure", screenshot: "only-on-failure" },
});
