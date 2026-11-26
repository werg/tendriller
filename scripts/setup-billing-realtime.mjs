#!/usr/bin/env node
/**
 * Provision Cloudflare Realtime (SFU app + TURN key), Polar.sh Merchant of Record
 * (usage meters, Pro/Team monthly & annual products, Standard Webhooks endpoint),
 * Worker secrets, and D1 migration 0005_billing_and_tiers.sql via official APIs.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... POLAR_ACCESS_TOKEN=... \
 *     node scripts/setup-billing-realtime.mjs --stage staging --polar-server sandbox
 *
 * Flags:
 *   --stage staging|production         Target Wrangler environment (default: staging)
 *   --polar-server sandbox|production  Polar API environment (default: sandbox for staging, production for production)
 *   --skip-cloudflare                  Skip Cloudflare Realtime SFU/TURN creation
 *   --skip-polar                       Skip Polar.sh catalog/meter/webhook creation
 *   --skip-secrets                     Print secret values instead of uploading via wrangler
 *   --skip-migrate                     Skip `wrangler d1 migrations apply ACCOUNTS --remote`
 */
import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

dns.setDefaultResultOrder("ipv4first");

const { values: args } = parseArgs({
  options: {
    stage: { type: "string", default: "staging" },
    "polar-server": { type: "string" },
    "skip-cloudflare": { type: "boolean", default: false },
    "skip-polar": { type: "boolean", default: false },
    "skip-secrets": { type: "boolean", default: false },
    "skip-migrate": { type: "boolean", default: false },
  },
});

const stage = args.stage;
if (stage !== "staging" && stage !== "production") {
  console.error("--stage must be staging or production");
  process.exit(1);
}
const polarServer = args["polar-server"] ?? (stage === "production" ? "production" : "sandbox");
const configPath = resolve(import.meta.dirname, `../server/wrangler.${stage}.jsonc`);
const wranglerCfg = JSON.parse(readFileSync(configPath, "utf8").replace(/^\s*\/\/.*$/gm, ""));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || wranglerCfg.vars?.CLOUDFLARE_ACCOUNT_ID;
const publicBase = wranglerCfg.vars?.PUBLIC_BASE;
if (!accountId || !publicBase) {
  console.error(`Missing CLOUDFLARE_ACCOUNT_ID or PUBLIC_BASE in ${configPath}`);
  process.exit(1);
}

const cfToken = process.env.CLOUDFLARE_API_TOKEN || "";
const polarToken = process.env.POLAR_ACCESS_TOKEN || "";
const polarBase = polarServer === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";

async function apiJson(url, { method = "GET", token, body }) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${url} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return data;
}

const secrets = new Map();

// 1. Cloudflare Realtime SFU App + TURN Key
if (!args["skip-cloudflare"]) {
  if (!cfToken) {
    console.log("Skipping Cloudflare Realtime API provisioning (CLOUDFLARE_API_TOKEN not set).");
  } else {
    console.log(`Creating Cloudflare Realtime SFU app & TURN key on account ${accountId} (${stage})...`);
    const sfu = await apiJson(`https://api.cloudflare.com/client/v4/accounts/${accountId}/calls/apps`, {
      method: "POST",
      token: cfToken,
      body: { name: `tendriller-${stage}-sfu` },
    });
    const turn = await apiJson(`https://api.cloudflare.com/client/v4/accounts/${accountId}/calls/turn_keys`, {
      method: "POST",
      token: cfToken,
      body: { name: `tendriller-${stage}-turn` },
    });
    const sfuSecret = sfu.result?.secret;
    const turnSecret = turn.result?.secret ?? turn.result?.apiToken ?? turn.result?.key;
    if (!sfu.result?.uid || !sfuSecret) throw new Error("Cloudflare SFU app creation did not return uid/secret.");
    if (!turn.result?.uid || !turnSecret) throw new Error("Cloudflare TURN key creation did not return uid/secret.");
    secrets.set("CF_REALTIME_APP_ID", sfu.result.uid);
    secrets.set("CF_REALTIME_API_TOKEN", sfuSecret);
    secrets.set("CF_TURN_KEY_ID", turn.result.uid);
    secrets.set("CF_TURN_API_TOKEN", turnSecret);
    console.log(`  SFU App ID: ${sfu.result.uid}`);
    console.log(`  TURN Key ID: ${turn.result.uid}`);
  }
}

// 2. Polar.sh Meters, Products, and Webhook Endpoint
if (!args["skip-polar"]) {
  if (!polarToken) {
    console.log("Skipping Polar.sh API provisioning (POLAR_ACCESS_TOKEN not set).");
  } else {
    console.log(`Provisioning Polar.sh (${polarServer}) meters, products, and webhook for ${publicBase}...`);

    const existingMeters = await apiJson(`${polarBase}/v1/meters/?limit=100`, { token: polarToken });
    const ensureMeter = async (name, eventName, property) => {
      const hit = (existingMeters.items ?? []).find(m => m.name === name);
      if (hit) {
        console.log(`  Reusing meter ${name}: ${hit.id}`);
        return hit;
      }
      const created = await apiJson(`${polarBase}/v1/meters/`, {
        method: "POST",
        token: polarToken,
        body: {
          name,
          filter: { conjunction: "and", clauses: [{ property: "name", operator: "eq", value: eventName }] },
          aggregation: { func: "sum", property },
        },
      });
      console.log(`  Created meter ${name}: ${created.id}`);
      return created;
    };

    const mediaMeter = await ensureMeter("Tendriller Media Egress (GB)", "media_egress_gb", "gigabytes");
    const mcpMeter = await ensureMeter("Tendriller Hosted MCP Overage Calls", "mcp_overage_calls", "calls");

    const existingProducts = await apiJson(`${polarBase}/v1/products/?limit=100`, { token: polarToken });
    const ensureProduct = async ({ name, description, interval, amountCents, mediaCentsPerGb, mcpCentsPer10k }) => {
      const hit = (existingProducts.items ?? []).find(p => p.name === name && !p.is_archived);
      if (hit) {
        console.log(`  Reusing product ${name}: ${hit.id}`);
        return hit;
      }
      const created = await apiJson(`${polarBase}/v1/products/`, {
        method: "POST",
        token: polarToken,
        body: {
          name,
          description,
          recurring_interval: interval,
          prices: [
            { amount_type: "fixed", price_amount: amountCents, price_currency: "usd" },
            { amount_type: "metered_unit", meter_id: mediaMeter.id, unit_amount: String(mediaCentsPerGb), price_currency: "usd" },
            { amount_type: "metered_unit", meter_id: mcpMeter.id, unit_amount: String(mcpCentsPer10k / 10_000), price_currency: "usd" },
          ],
        },
      });
      console.log(`  Created product ${name}: ${created.id}`);
      return created;
    };

    const proMonth = await ensureProduct({
      name: "Tendriller Pro (Monthly)",
      description: "100 pages, 25 residents, 2 GB assets, 100 GB SFU/TURN, 15k hosted MCP calls/mo, host-brokered personal OAuth.",
      interval: "month",
      amountCents: 1200,
      mediaCentsPerGb: 10,
      mcpCentsPer10k: 200,
    });
    const proYear = await ensureProduct({
      name: "Tendriller Pro (Annual)",
      description: "Tendriller Pro billed annually ($100/yr).",
      interval: "year",
      amountCents: 10000,
      mediaCentsPerGb: 10,
      mcpCentsPer10k: 200,
    });
    const teamMonth = await ensureProduct({
      name: "Tendriller Team (Monthly)",
      description: "500 pages, 100 residents, 20 GB assets, 500 GB SFU/TURN, 100k hosted MCP calls/mo, Team OAuth tie-ins, custom domain.",
      interval: "month",
      amountCents: 3900,
      mediaCentsPerGb: 8,
      mcpCentsPer10k: 150,
    });
    const teamYear = await ensureProduct({
      name: "Tendriller Team (Annual)",
      description: "Tendriller Team billed annually ($320/yr).",
      interval: "year",
      amountCents: 32000,
      mediaCentsPerGb: 8,
      mcpCentsPer10k: 150,
    });

    const webhookUrl = `${publicBase}/api/webhooks/polar`;
    const existingHooks = await apiJson(`${polarBase}/v1/webhooks/endpoints?limit=100`, { token: polarToken });
    let hook = (existingHooks.items ?? []).find(h => h.url === webhookUrl);
    if (!hook) {
      hook = await apiJson(`${polarBase}/v1/webhooks/endpoints`, {
        method: "POST",
        token: polarToken,
        body: {
          url: webhookUrl,
          format: "raw",
          events: [
            "subscription.created",
            "subscription.updated",
            "subscription.active",
            "subscription.canceled",
            "subscription.uncanceled",
            "subscription.revoked",
            "customer.state_changed",
          ],
        },
      });
      console.log(`  Created Polar webhook ${webhookUrl}: ${hook.id}`);
    } else {
      console.log(`  Reusing Polar webhook ${webhookUrl}: ${hook.id}`);
    }

    secrets.set("POLAR_ACCESS_TOKEN", polarToken);
    secrets.set("POLAR_SERVER", polarServer);
    if (hook.secret) secrets.set("POLAR_WEBHOOK_SECRET", hook.secret);
    secrets.set("POLAR_PRODUCTS_JSON", JSON.stringify({
      pro_month: proMonth.id,
      pro_year: proYear.id,
      team_month: teamMonth.id,
      team_year: teamYear.id,
    }));
    secrets.set("POLAR_METERS_JSON", JSON.stringify({
      media_egress_gb: "media_egress_gb",
      mcp_overage_calls: "mcp_overage_calls",
    }));
  }
}

const { CLOUDFLARE_API_TOKEN: _omitCf, ...baseEnv } = process.env;
const wranglerEnv = {
  ...baseEnv,
  NODE_OPTIONS: [baseEnv.NODE_OPTIONS, "--dns-result-order=ipv4first"].filter(Boolean).join(" "),
};

// 3. Upload Worker secrets atomically via `wrangler secret bulk` (JSON over stdin, no secret file on disk)
if (secrets.size > 0) {
  if (args["skip-secrets"]) {
    console.log("\nSecrets prepared (--skip-secrets set; not uploaded):");
    for (const key of secrets.keys()) console.log(`  - ${key}`);
  } else {
    console.log(`\nUploading ${secrets.size} Worker secrets atomically to ${wranglerCfg.name}...`);
    const payload = JSON.stringify(Object.fromEntries(secrets.entries()));
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        execFileSync("npx", ["wrangler", "secret", "bulk", "--config", configPath], {
          input: payload,
          env: wranglerEnv,
          stdio: ["pipe", "inherit", "inherit"],
        });
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        console.warn(`  wrangler secret bulk attempt ${attempt} failed; retrying...`);
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }
}

// 4. Apply D1 migration 0005_billing_and_tiers.sql
if (!args["skip-migrate"] && cfToken) {
  console.log(`\nApplying D1 migrations to ${wranglerCfg.d1_databases[0].database_name}...`);
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "ACCOUNTS", "--remote", "--config", configPath], {
    env: wranglerEnv,
    stdio: "inherit",
  });
}

console.log("\nDone.");
