// Playwright tests for snippets/*.js. Run from the repo root:
//   npx playwright test --config snippets/test/playwright.config.ts
// Tests that need jsDelivr / Google model downloads skip themselves when the network is blocked.
import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.SNIPPETS_TEST_PORT || 4791);

export default defineConfig({
  testDir: dir,
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  outputDir: dir + "test-results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    permissions: ["camera", "microphone", "geolocation"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    command: `node "${dir}server.mjs"`,
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/blank.html`,
    reuseExistingServer: true,
  },
});
