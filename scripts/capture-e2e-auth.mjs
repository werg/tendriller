// Capture an owner's staging browser session after the real OAuth setup exists.
// Usage: E2E_SERVICE_BASE=https://staging.tendriller.dev node scripts/capture-e2e-auth.mjs
import { chromium } from "@playwright/test";

const base = process.env.E2E_SERVICE_BASE;
if (!base || new URL(base).protocol !== "https:") throw new Error("Set E2E_SERVICE_BASE to the staging HTTPS service origin");
const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/auth`);
  console.log("Sign in with the staging owner account. Waiting for /dashboard…");
  await page.waitForURL(url => url.origin === new URL(base).origin && url.pathname === "/dashboard", { timeout: 300_000 });
  await context.storageState({ path: ".e2e-auth.json" });
  console.log("Saved .e2e-auth.json locally. Keep it private; it contains session cookies.");
} finally { await browser.close(); }
