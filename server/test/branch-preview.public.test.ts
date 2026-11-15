import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/ids";
import { route } from "../src/router";
import { pageUrl, parsePageRoute } from "../src/urls";
import { create } from "./helpers";

const suffix = "--p-0123456789ab";
const preview: Env = {
  ...env,
  PUBLIC_BASE: "https://preview-0123456789ab.tendriller.dev",
  PAGE_BASE_DOMAIN: "tendriller.dev",
  PAGE_HOST_SUFFIX: suffix,
};
const id = "abcdefghijkl";
const key = "a".repeat(26);

describe("isolated branch page hosts", () => {
  it("round trips preview URLs while keeping each page and branch on its own origin", () => {
    const url = new URL(pageUrl(preview, id, key));
    expect(url.href).toBe(`https://${id}${suffix}.tendriller.dev/s/${key}/`);
    expect(url.hostname.split(".")).toHaveLength(3);
    expect(parsePageRoute(url, preview)).toEqual({ id, key, base: `/s/${key}/`, rest: "" });
    expect(parsePageRoute(new URL("_tendril/ws", url), preview)?.rest).toBe("_tendril/ws");
    expect(parsePageRoute(new URL(url.href.slice(0, -1)), preview)?.rest).toBeNull();

    const secondPage = new URL(pageUrl(preview, "mnopqrstuvwx", key));
    const secondBranch = new URL(pageUrl({ ...preview, PAGE_HOST_SUFFIX: "--p-fedcba987654" }, id, key));
    expect(new Set([url.origin, secondPage.origin, secondBranch.origin, preview.PUBLIC_BASE]).size).toBe(4);
  });

  it("keeps the existing staging and production URL formats", () => {
    const staging = { ...env, PAGE_BASE_DOMAIN: "tendriller.dev" };
    for (const config of [env, staging, { ...staging, PAGE_HOST_SUFFIX: "" }]) {
      const url = new URL(pageUrl(config, id, key));
      expect(url.hostname).toBe(`${id}.${config.PAGE_BASE_DOMAIN}`);
      expect(parsePageRoute(url, config)?.id).toBe(id);
      expect(parsePageRoute(new URL(pageUrl(preview, id, key)), config)).toBeNull();
    }
  });

  it("rejects staging pages, other previews and nested or misleading hostnames", () => {
    for (const host of [
      `${id}.tendriller.dev`,
      `${id}--p-fedcba987654.tendriller.dev`,
      `extra.${id}${suffix}.tendriller.dev`,
      `${id}${suffix}.tendriller.dev.example.com`,
      `${id}${suffix}extra.tendriller.dev`,
      `${id}${suffix}.tendriller.site`,
      `preview-0123456789ab.tendriller.dev`,
    ]) {
      expect(parsePageRoute(new URL(`https://${host}/s/${key}/`), preview), host).toBeNull();
    }
  });

  it("fails closed for malformed preview suffix configuration", () => {
    for (const bad of ["p-0123456789ab", "--p-0123456789a", "--p-0123456789AB", `${suffix}.extra`, `${suffix}:443`, "--p-0123456789ag"]) {
      const config = { ...preview, PAGE_HOST_SUFFIX: bad };
      expect(() => pageUrl(config, id, key)).toThrow("Invalid PAGE_HOST_SUFFIX");
      expect(parsePageRoute(new URL(pageUrl(preview, id, key)), config)).toBeNull();
      expect(parsePageRoute(new URL(`https://${id}.tendriller.dev/s/${key}/`), config)).toBeNull();
    }
  });

  it("separates the service from page hosts and retains same-origin enforcement", async () => {
    const health = await route(new Request(`${preview.PUBLIC_BASE}/health`), preview);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(health.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const url = pageUrl(preview, id, key);
    const unsigned = await route(new Request(url), preview);
    expect(unsigned.status).toBe(302);
    expect(unsigned.headers.get("Location")).toBe(`${preview.PUBLIC_BASE}/auth/page?tendril=${id}&key=${key}`);
    expect(unsigned.headers.get("Strict-Transport-Security")).toContain("includeSubDomains");
    expect(unsigned.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    for (const wrong of [
      `${preview.PUBLIC_BASE}/s/${key}/`,
      url.replace(suffix, ""),
      url.replace(suffix, "--p-fedcba987654"),
    ]) {
      expect((await route(new Request(wrong), preview)).status).toBe(404);
    }
    const sibling = new URL(pageUrl(preview, "mnopqrstuvwx", key)).origin;
    const post = await route(new Request(`${url}_tendril/report`, { method: "POST", headers: { Origin: sibling }, body: "reason=test" }), preview);
    expect(post.status).toBe(403);
    const socket = await route(new Request(`${url}_tendril/ws`, { headers: { Origin: sibling, Upgrade: "websocket" } }), preview);
    expect(socket.status).toBe(403);
  });

  it("identifies a deployed preview commit without changing production health responses", async () => {
    const metadata = { BRANCH_PREVIEW_BRANCH: "feature/live-previews", BRANCH_PREVIEW_SHA: "a".repeat(40) };
    const deployed = await route(new Request(`${preview.PUBLIC_BASE}/health`), { ...preview, ...metadata });
    expect(await deployed.json()).toEqual({ ok: true, preview: { branch: metadata.BRANCH_PREVIEW_BRANCH, commit: metadata.BRANCH_PREVIEW_SHA } });
    const invalidSha = await route(new Request(`${preview.PUBLIC_BASE}/health`), { ...preview, ...metadata, BRANCH_PREVIEW_SHA: "not-a-commit" });
    expect(await invalidSha.json()).toEqual({ ok: true });
    const invalidSuffix = await route(new Request(`${preview.PUBLIC_BASE}/health`), { ...preview, ...metadata, PAGE_HOST_SUFFIX: "bad-suffix" });
    expect(await invalidSuffix.json()).toEqual({ ok: true });
    const production = await route(new Request(`${env.PUBLIC_BASE}/health`), { ...env, ...metadata });
    expect(await production.json()).toEqual({ ok: true });
    expect(production.headers.has("X-Robots-Tag")).toBe(false);
  });

  it("redeems owner claims only on the preview page origin and sets host-only cookies", async () => {
    const email = `preview-${crypto.randomUUID()}@example.com`;
    const handle = await create({ owner: email, claim: false, listener: false });
    const account = crypto.randomUUID();
    const session = crypto.randomUUID();
    const now = Date.now();
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(account, now, email),
      env.ACCOUNTS.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('github', ?, ?, 'preview-owner', ?, ?)")
        .bind(account, account, email, now),
      env.ACCOUNTS.prepare("INSERT INTO identity_emails (provider, subject, email) VALUES ('github', ?, ?)").bind(account, email),
      env.ACCOUNTS.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256Hex(session), account, now, now + 60_000),
    ]);
    const pageKey = new URL(handle.page_url).pathname.split("/")[2];
    const claim = await route(new Request(`${preview.PUBLIC_BASE}/auth/page?tendril=${handle.id}&key=${pageKey}`, {
      headers: { Cookie: `__Host-tendriller=${session}` },
    }), preview);
    expect(claim.status).toBe(303);
    const expectedPage = pageUrl(preview, handle.id, pageKey);
    const exchange = claim.headers.get("Location")!;
    expect(exchange).toMatch(`${expectedPage}_tendril/auth/session?code=`);
    expect((await route(new Request(exchange.replace(suffix, "--p-fedcba987654")), preview)).status).toBe(404);
    const redeemed = await route(new Request(exchange), preview);
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get("Location")).toBe(expectedPage);
    const cookie = redeemed.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^__Host-tendril=/);
    expect(cookie).toContain("Path=/; Secure; HttpOnly; SameSite=Lax");
    expect(cookie).not.toMatch(/Domain=/i);
    expect((await route(new Request(exchange), preview)).status).toBe(403);
  });

  it("reports only pages belonging to this preview", async () => {
    const handle = await create({ claim: false, listener: false });
    const pageKey = new URL(handle.page_url).pathname.split("/")[2];
    const previewPage = pageUrl(preview, handle.id, pageKey);
    const config = { ...preview, TURNSTILE_SECRET_KEY: "test-preview-secret" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      success: true, hostname: new URL(preview.PUBLIC_BASE).hostname, action: "report",
    }));
    const report = (url: string) => route(new Request(`${preview.PUBLIC_BASE}/report`, {
      method: "POST", headers: { Origin: preview.PUBLIC_BASE },
      body: new URLSearchParams({ url, reason: "Preview test report", "cf-turnstile-response": "test-token" }),
    }), config);
    try {
      for (const wrong of [previewPage.replace(suffix, ""), previewPage.replace(suffix, "--p-fedcba987654"), handle.page_url]) {
        expect((await report(wrong)).status).toBe(400);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await report(previewPage)).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
