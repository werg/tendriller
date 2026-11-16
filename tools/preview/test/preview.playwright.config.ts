import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: ["preview.spec.ts", "preview-streams.spec.ts", "recipes.spec.ts", "notebook.spec.ts", "workshop.spec.ts", "session-archive.spec.ts"], timeout: 45_000, workers: 1,
  outputDir: "../../../test-results/preview",
  use: { browserName: "chromium", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
    trace: "retain-on-failure", screenshot: "only-on-failure" },
});
