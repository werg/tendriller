#!/usr/bin/env node
/**
 * Validate and upload Tendriller outbound OAuth & org-webhook Worker secrets cleanly via Wrangler:
 *   - `OAUTH_CONFIG_KEY` (32 random bytes, envelope-encrypts BYO client_secret & HMAC webhook secrets in D1)
 *   - `GITHUB_ORG_WEBHOOK_SECRET` (32 random bytes, verifies GitHub org/team departure webhooks)
 *   - `OUTBOUND_OAUTH_CLIENTS_JSON` (JSON map of built-in provider client_id / client_secret entries)
 *
 * Usage:
 *   # Print exact callback URLs for staging or production:
 *   node scripts/setup-oauth.mjs --stage production --print-callbacks
 *
 *   # Generate & upload OAUTH_CONFIG_KEY and GITHUB_ORG_WEBHOOK_SECRET (prints webhook secret once for GitHub App setup):
 *   node scripts/setup-oauth.mjs --stage production --generate-config-key --generate-webhook-secret
 *
 *   # Validate & upload OUTBOUND_OAUTH_CLIENTS_JSON from a local private JSON file (never commit that file!):
 *   node scripts/setup-oauth.mjs --stage production --clients-file ./oauth-clients.prod.json
 *
 *   # Preview without uploading:
 *   node scripts/setup-oauth.mjs --stage staging --clients-file ./oauth-clients.staging.json --dry-run
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const BUILTIN_PROVIDERS = [
  "github", "linear", "notion", "slack", "figma", "airtable", "discord",
  "google", "microsoft", "dropbox", "todoist", "spotify", "strava", "fitbit", "oura",
];
const BUILTIN_SET = new Set(BUILTIN_PROVIDERS);

const { values: args } = parseArgs({
  options: {
    stage: { type: "string", default: "staging" },
    config: { type: "string" },
    "clients-file": { type: "string" },
    "generate-config-key": { type: "boolean", default: false },
    "generate-webhook-secret": { type: "boolean", default: false },
    "webhook-secret": { type: "string" },
    "print-callbacks": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const configPath = args.config
  ? resolve(args.config)
  : resolve(import.meta.dirname, `../server/wrangler.${args.stage}.jsonc`);

if (!args.config && args.stage !== "staging" && args.stage !== "production") {
  console.error("--stage must be staging or production (or pass --config <wrangler.jsonc>)");
  process.exit(1);
}

const wranglerCfg = JSON.parse(readFileSync(configPath, "utf8").replace(/^\s*\/\/.*$/gm, ""));
const publicBase = String(wranglerCfg.vars?.PUBLIC_BASE || "").replace(/\/+$/, "");
if (!publicBase) {
  console.error(`Missing vars.PUBLIC_BASE in ${configPath}`);
  process.exit(1);
}

if (args["print-callbacks"]) {
  console.log(`\nOutbound OAuth Redirect URIs for ${publicBase}:\n`);
  for (const id of BUILTIN_PROVIDERS) {
    console.log(`  ${id.padEnd(11)} ${publicBase}/auth/outbound/callback/${id}`);
  }
  console.log(`\n  BYO custom  ${publicBase}/auth/outbound/callback/custom%3A<slug>`);
  console.log(`  GH Webhook  ${publicBase}/api/webhooks/github-org\n`);
  if (!args["clients-file"] && !args["generate-config-key"] && !args["generate-webhook-secret"] && !args["webhook-secret"]) {
    process.exit(0);
  }
}

const toUpload = new Map();

if (args["generate-config-key"]) {
  toUpload.set("OAUTH_CONFIG_KEY", randomBytes(32).toString("base64url"));
}

let generatedWebhookSecret = null;
if (args["generate-webhook-secret"]) {
  generatedWebhookSecret = randomBytes(32).toString("hex");
  toUpload.set("GITHUB_ORG_WEBHOOK_SECRET", generatedWebhookSecret);
} else if (args["webhook-secret"]) {
  if (args["webhook-secret"].length < 16) {
    console.error("--webhook-secret must be at least 16 characters");
    process.exit(1);
  }
  toUpload.set("GITHUB_ORG_WEBHOOK_SECRET", args["webhook-secret"]);
}

if (args["clients-file"]) {
  const raw = readFileSync(resolve(args["clients-file"]), "utf8");
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    console.error(`Invalid JSON in ${args["clients-file"]}: ${err.message}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("clients-file must be a JSON object mapping provider IDs to { client_id, client_secret }");
    process.exit(1);
  }
  const normalized = {};
  for (const [key, val] of Object.entries(parsed)) {
    const id = key.trim().toLowerCase();
    if (!BUILTIN_SET.has(id)) {
      console.error(`Unknown built-in provider "${key}". Valid IDs: ${BUILTIN_PROVIDERS.join(", ")}`);
      process.exit(1);
    }
    if (!val || typeof val !== "object" || typeof val.client_id !== "string" || !val.client_id.trim()) {
      console.error(`Provider "${id}" must have a non-empty string "client_id"`);
      process.exit(1);
    }
    normalized[id] = {
      client_id: val.client_id.trim(),
      ...(typeof val.client_secret === "string" && val.client_secret.trim() ? { client_secret: val.client_secret.trim() } : {}),
    };
  }
  const count = Object.keys(normalized).length;
  if (!count) {
    console.error("clients-file contained 0 providers.");
    process.exit(1);
  }
  console.log(`Validated ${count} outbound OAuth provider(s): ${Object.keys(normalized).join(", ")}`);
  toUpload.set("OUTBOUND_OAUTH_CLIENTS_JSON", JSON.stringify(normalized));
}

if (!toUpload.size) {
  console.log("Nothing to upload. Pass --print-callbacks, --generate-config-key, --generate-webhook-secret, and/or --clients-file <path>.");
  process.exit(0);
}

for (const [name, value] of toUpload.entries()) {
  if (args["dry-run"]) {
    console.log(`[dry-run] Would upload secret ${name} (${value.length} chars) to ${configPath}`);
    continue;
  }
  console.log(`Uploading secret ${name} via wrangler (${configPath})...`);
  execFileSync("npx", ["wrangler", "secret", "put", name, "--config", configPath], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

if (generatedWebhookSecret) {
  console.log(`\nSave this GITHUB_ORG_WEBHOOK_SECRET in your GitHub App / org webhook settings (URL: ${publicBase}/api/webhooks/github-org):`);
  console.log(`  ${generatedWebhookSecret}\n`);
}
if (toUpload.has("OAUTH_CONFIG_KEY")) {
  console.log("OAUTH_CONFIG_KEY uploaded (envelope-encrypts BYO client secrets & HMAC webhook secrets at rest in D1).");
}
console.log("Done.");
