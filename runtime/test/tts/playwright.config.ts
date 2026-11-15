import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "tts.spec.ts", workers: 2, timeout: 30_000,
  use: { browserName: "chromium", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ["--autoplay-policy=no-user-gesture-required"] } },
});
