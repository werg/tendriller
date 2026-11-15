import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: ["preview.spec.ts", "recipes.spec.ts", "notebook.spec.ts"], timeout: 45_000, workers: 1,
  use: { browserName: "chromium", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined } },
});
