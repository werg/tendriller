// Install deployment secrets from environment variables without writing them to disk.
// Usage: node scripts/set-secrets.mjs production
import { execFileSync } from "node:child_process";

const stage = process.argv[2];
if (stage !== "staging" && stage !== "production") throw new Error("Pass staging or production");
const required = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "BUDGET_WEBHOOK_SECRET"];
const optional = ["ADMIN_IDENTITIES", "BUDGET_PAUSE_POLICY_ID", "BUDGET_READ_ONLY_POLICY_ID",
  "WEB_RISK_API_KEY", "ABUSE_FORWARD_ADDRESS", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];
const missing = required.filter(name => !process.env[name]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
for (const name of [...required, ...optional]) {
  const value = process.env[name];
  if (!value) continue;
  execFileSync("npx", ["wrangler", "secret", "put", name, "--config", `server/wrangler.${stage}.jsonc`],
    { input: value + "\n", stdio: ["pipe", "inherit", "inherit"] });
  console.log(`Installed ${name} for ${stage}`);
}
