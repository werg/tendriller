import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["local.spec.ts", "speech.spec.ts", "real-speech.spec.ts", "tts-integration.spec.ts"],
  timeout: 45_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    baseURL: "https://service.localhost:8790",
    ignoreHTTPSErrors: true,
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--host-resolver-rules=MAP *.localhost 127.0.0.1"] },
    permissions: ["camera", "microphone", "geolocation"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    cwd: "../..",
    url: "https://service.localhost:8790/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
