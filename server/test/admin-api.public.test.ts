import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { authenticateAdmin, ADMIN_SCOPES, type AdminScope } from "../src/admin/auth";
import { route } from "../src/router";
import { sha256Hex } from "../src/ids";
import { getAccountEntitlements } from "../src/billing/entitlements";
import { BASE } from "./helpers";

const prefix = "/api/admin/v1";
const uuid = () => crypto.randomUUID();

async function operator(scopes: readonly AdminScope[] = ADMIN_SCOPES) {
  const token = "td_admin_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const record = { id: `test-${uuid()}`, sha256: await sha256Hex(token), scopes, issuedAt: now - 1000, expiresAt: now + 86_400_000 };
  const customEnv: Env = { ...env, AUTH_RATE: undefined, FAILED_AUTH_RATE: undefined, ADMIN_API_CREDENTIALS_JSON: JSON.stringify([record]) };
  return { token, record, customEnv };
}

function call(customEnv: Env, token?: string, path = "", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return route(new Request(`${BASE}${prefix}${path}`, { ...init, headers }), customEnv);
}

async function account() {
  const id = uuid();
  await env.ACCOUNTS.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)")
    .bind(id, Date.now(), "private-operator-test@example.test").run();
  return id;
}

describe("isolated operator API", () => {
  it("is disabled without explicit credentials and rejects malformed or ambiguous configuration", async () => {
    const { token, record, customEnv } = await operator();
    for (const config of [undefined, "[]"]) {
      const res = await call({ ...customEnv, ADMIN_API_CREDENTIALS_JSON: config }, token);
      expect(res.status).toBe(404);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    for (const config of ["{", "null", JSON.stringify([record, record]), JSON.stringify([{ ...record, scopes: ["*"] }]),
      JSON.stringify([{ ...record, sha256: "short" }]), JSON.stringify([{ ...record, unexpected: true }]),
      JSON.stringify([{ ...record, expiresAt: record.issuedAt + 91 * 86_400_000 }])]) {
      expect((await call({ ...customEnv, ADMIN_API_CREDENTIALS_JSON: config }, token)).status).toBe(503);
    }
  });

  it("checks expiry, revocation, issue time and independent credentials, without cookie fallback", async () => {
    const { token, record, customEnv } = await operator();
    const owner = await account();
    const session = `service-${uuid()}`;
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare("INSERT INTO identities (provider, subject, account_id, login, created_at) VALUES ('github', '12345', ?, 'admin-test', ?)")
        .bind(owner, Date.now()),
      env.ACCOUNTS.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256Hex(session), owner, Date.now(), Date.now() + 86_400_000),
    ]);
    const cookieEnv = { ...customEnv, ADMIN_IDENTITIES: "github:12345", BROADCAST_ADMIN_TOKEN: "broadcast-secret" };
    for (const other of [undefined, "ta_" + "a".repeat(32), "broadcast-secret", "ordinary-oauth-token", token.slice(0, -1) + (token.endsWith("0") ? "1" : "0")]) {
      const res = await call(cookieEnv, other, "", { headers: { Cookie: `__Host-tendriller=${session}` } });
      expect(res.status).toBe(401);
    }
    for (const changed of [{ ...record, revoked: true }, { ...record, issuedAt: Date.now() - 2000, expiresAt: Date.now() - 1000 },
      { ...record, issuedAt: Date.now() + 1000, expiresAt: Date.now() + 2000 }]) {
      expect((await call({ ...customEnv, ADMIN_API_CREDENTIALS_JSON: JSON.stringify([changed]) }, token)).status).toBe(401);
    }
    const req = new Request(`${BASE}${prefix}`, { headers: { Authorization: `Bearer ${token}` } });
    await expect(authenticateAdmin(req, customEnv, record.expiresAt)).rejects.toMatchObject({ status: 401 });
    expect((await call(customEnv, token)).status).toBe(200);
  });

  it("rejects page origins, foreign origins and preflights without adding public CORS", async () => {
    const { token, customEnv } = await operator();
    const foreignHeaders: Array<Record<string, string>> = [{ Origin: "https://private.tendriller.site" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of foreignHeaders) {
      const response = await call(customEnv, token, "/analytics", { headers });
      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const preflight = await call(customEnv, undefined, "/premium-grants", {
      method: "OPTIONS", headers: { Origin: BASE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization" },
    });
    expect(preflight.status).toBe(401);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const page = await route(new Request(`https://aaaaaaaaaaaa.tendriller.site${prefix}/analytics`, {
      headers: { Authorization: `Bearer ${token}` },
    }), customEnv);
    expect(page.status).toBe(404);
    expect(page.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const otherHost = await route(new Request(`https://elsewhere.test${prefix}/analytics`, {
      headers: { Authorization: `Bearer ${token}` },
    }), customEnv);
    expect(otherHost.status).toBe(404);
  });

  it("enforces scopes before parsing request bodies and does not let analytics expose accounts or audit", async () => {
    const { token, customEnv } = await operator(["analytics:read"]);
    expect((await call(customEnv, token, "/analytics")).status).toBe(200);
    for (const [path, method] of [["/premium-grants", "POST"], ["/premium-grants?accountId=private", "GET"], ["/audit", "GET"],
      [`/premium-grants/${uuid()}/revoke`, "POST"]]) {
      expect((await call(customEnv, token, path, { method })).status).toBe(403);
    }
    for (const path of ["/analytics?pageId=secret", "/analytics?accountId=secret", "/analytics?from=2026-11-01&from=2026-11-02", "/analytics?sql=SELECT"]) {
      expect((await call(customEnv, token, path)).status).toBe(400);
    }
    const output = await (await call(customEnv, token, "/analytics")).text();
    expect(output).not.toContain("private-operator-test@example.test");
    expect(output).not.toContain(token);
  });

  it("grants, lists and revokes using retry-safe commands with a separate, scoped audit feed", async () => {
    const { token, record, customEnv } = await operator();
    const owner = await account();
    const input = { id: uuid(), accountId: owner, plan: "pro", expiresAt: Date.now() + 86_400_000, reason: "beta cohort" };
    const write = (value: unknown) => call(customEnv, token, "/premium-grants", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    });
    expect((await write(input)).status).toBe(201);
    expect((await write(input)).status).toBe(200);
    expect((await write({ ...input, plan: "team" })).status).toBe(409);
    expect((await getAccountEntitlements(customEnv, owner)).plan).toBe("pro");
    const listed = await call(customEnv, token, `/premium-grants?accountId=${owner}`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ grants: [expect.objectContaining({ id: input.id })] });
    const revoke = () => call(customEnv, token, `/premium-grants/${input.id}/revoke`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "testing complete" }),
    });
    expect((await revoke()).status).toBe(200);
    expect((await revoke()).status).toBe(200);
    expect((await write(input)).status).toBe(200);
    expect((await getAccountEntitlements(customEnv, owner)).plan).toBe("free");

    await env.ACCOUNTS.prepare("INSERT INTO audit_log (id,actor,action,subject,reason,created_at) VALUES (?, 'other-admin', 'page:hold', 'private-page', 'private-page-content', ?)")
      .bind(uuid(), Date.now()).run();
    const audit = await call(customEnv, token, "/audit?limit=1");
    const first = await audit.json() as { entries: Array<{ actor: string; action: string }>; nextCursor: string | null };
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].actor).toBe(`operator:${record.id}`);
    expect(first.nextCursor).not.toBeNull();
    const next = await call(customEnv, token, `/audit?limit=1&before=${encodeURIComponent(first.nextCursor!)}`);
    expect(next.status).toBe(200);
    const text = await next.text();
    expect(text).not.toContain("private-page");
    const count = await env.ACCOUNTS.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor=? AND action IN ('premium:grant','premium:revoke')")
      .bind(`operator:${record.id}`).first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("bounds inputs and fails closed when rate limits reject a caller", async () => {
    const { token, customEnv } = await operator();
    expect((await call(customEnv, token, "/premium-grants", { method: "POST", body: "{}" })).status).toBe(415);
    expect((await call(customEnv, token, "/premium-grants", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(4097),
    })).status).toBe(413);
    for (const path of ["/premium-grants", "/premium-grants?accountId=one&limit=101", "/audit?limit=0", "/audit?before=bad"])
      expect((await call(customEnv, token, path)).status).toBe(400);
    const reject = { limit: async () => ({ success: false }) } as RateLimit;
    expect((await call({ ...customEnv, AUTH_RATE: reject }, token)).status).toBe(429);
    expect((await call({ ...customEnv, FAILED_AUTH_RATE: reject }, "invalid")).status).toBe(429);
  });
});
