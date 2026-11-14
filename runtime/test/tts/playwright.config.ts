import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "tts.spec.ts", workers: 2, timeout: 30_000,
  use: { browserName: "chromium", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } },
});
