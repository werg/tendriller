import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { route } from "../src/router";
import { authFormAction, hashPassword, pageSessionCookieHeader, readPageSessionCookie, renderAuthControls, verifyPassword } from "../src/accounts/local-auth";
import { pageUrl } from "../src/urls";

const postForm = (url: string, body: Record<string, string>, target: Env, headers?: Record<string, string>) =>
  route(new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: new URL(url).origin,
      ...headers,
    },
    body: new URLSearchParams(body).toString(),
  }), target);

describe("local dev and self-hosted password sign-in", () => {
  it("allows no-password local dev sign-in on localhost and fails closed on non-loopback origins", async () => {
    const localOrigin = "http://localhost:8787";
    const localEnv: Env = { ...env, PUBLIC_BASE: localOrigin, LOCAL_DEV_AUTH: "1", GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };

    const authPage = await route(new Request(`${localOrigin}/auth`), localEnv);
    expect(authPage.status).toBe(200);
    const html = await authPage.text();
    expect(html).toContain('action="/auth/local"');
    expect(html).toContain("Continue locally");
    expect(html).not.toContain("/auth/github");
    expect(html).not.toContain("/auth/google");

    // Bad origin is rejected.
    const badOrigin = await postForm(`${localOrigin}/auth/local`, { email: "dev@localhost" }, localEnv, { Origin: "https://evil.example" });
    expect(badOrigin.status).toBe(403);

    // Valid local dev sign-in issues a local cookie and authenticates /auth/me + /dashboard.
    const login = await postForm(`${localOrigin}/auth/local`, { email: "dev@localhost", return_to: "/dashboard" }, localEnv);
    expect(login.status).toBe(302);
    expect(login.headers.get("Location")).toBe("/dashboard");
    const setCookie = login.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("tendriller_local=");
    expect(setCookie).not.toContain("Secure");
    const cookie = setCookie.split(";")[0]!;

    const me = await route(new Request(`${localOrigin}/auth/me`, { headers: { Cookie: cookie } }), localEnv);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "dev@localhost" });

    const dash = await route(new Request(`${localOrigin}/dashboard`, { headers: { Cookie: cookie } }), localEnv);
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain("dev@localhost");

    // Logout revokes the session and clears the cookie.
    const logout = await route(new Request(`${localOrigin}/auth/logout`, {
      method: "POST", headers: { Origin: localOrigin, Cookie: cookie },
    }), localEnv);
    expect(logout.status).toBe(302);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await route(new Request(`${localOrigin}/auth/me`, { headers: { Cookie: cookie } }), localEnv)).status).toBe(401);

    // Strict fail-closed: LOCAL_DEV_AUTH=1 on a public origin is completely ignored.
    const prodOrigin = "https://tendriller.dev";
    const prodWithFlag: Env = { ...env, PUBLIC_BASE: prodOrigin, LOCAL_DEV_AUTH: "1" };
    const prodAuth = await route(new Request(`${prodOrigin}/auth`), prodWithFlag);
    expect(await prodAuth.text()).not.toContain("/auth/local");
    const prodAttempt = await postForm(`${prodOrigin}/auth/local`, { email: "attacker@example.com" }, prodWithFlag);
    expect(prodAttempt.status).toBe(404);
  });

  it("supports PBKDF2 password sign-in for self-hosted deployments", async () => {
    const hash = await hashPassword("correct-horse-battery-staple", 20_000);
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
    expect(await verifyPassword("wrong-passphrase", hash)).toBe(false);

    const origin = "https://selfhost.example";
    const pwEnv: Env = {
      ...env,
      PUBLIC_BASE: origin,
      LOCAL_PASSWORD_HASH: hash,
      LOCAL_OWNER_EMAIL: "owner@selfhost.example",
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    };

    const page = await route(new Request(`${origin}/auth`), pwEnv);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('action="/auth/password"');
    expect(html).toContain("owner@selfhost.example");

    const wrong = await postForm(`${origin}/auth/password`, { password: "wrong-passphrase" }, pwEnv);
    expect(wrong.status).toBe(401);

    const wrongHtml = await postForm(`${origin}/auth/password`, { password: "wrong-passphrase" }, pwEnv, { Accept: "text/html" });
    expect(wrongHtml.status).toBe(303);
    expect(wrongHtml.headers.get("Location")).toContain("error=invalid_password");

    const ok = await postForm(`${origin}/auth/password`, { password: "correct-horse-battery-staple", return_to: "/dashboard" }, pwEnv);
    expect(ok.status).toBe(302);
    const setCookie = ok.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("__Host-tendriller=");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0]!;

    const me = await route(new Request(`${origin}/auth/me`, { headers: { Cookie: cookie } }), pwEnv);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "owner@selfhost.example" });

    // Missing owner email fails closed.
    const broken = await postForm(`${origin}/auth/password`, { password: "correct-horse-battery-staple" }, { ...pwEnv, LOCAL_OWNER_EMAIL: undefined });
    expect(broken.status).toBe(404);
  });

  it("shows only configured OAuth providers", async () => {
    const origin = "https://tendriller.dev";
    const ghOnly: Env = { ...env, PUBLIC_BASE: origin, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "sec", GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };
    const html = await (await route(new Request(`${origin}/auth`), ghOnly)).text();
    expect(html).toContain("/auth/github");
    expect(html).not.toContain("/auth/google");
  });

  it("supports plain-HTTP loopback page URLs and cookies without weakening HTTPS pages", async () => {
    const localEnv: Env = { ...env, PUBLIC_BASE: "http://localhost:8787", PAGE_BASE_DOMAIN: "pages.localhost" };
    const prodEnv: Env = { ...env, PUBLIC_BASE: "https://tendriller.dev", PAGE_BASE_DOMAIN: "pages.tendriller.dev" };

    expect(pageUrl(localEnv, "aaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe("http://aaaaaaaaaaaa.pages.localhost:8787/s/bbbbbbbbbbbbbbbbbbbbbbbbbb/");
    expect(pageUrl(prodEnv, "aaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe("https://aaaaaaaaaaaa.pages.tendriller.dev/s/bbbbbbbbbbbbbbbbbbbbbbbbbb/");

    const localCookie = pageSessionCookieHeader("tok123", localEnv);
    expect(localCookie).toContain("tendril_local=tok123");
    expect(localCookie).not.toContain("Secure");
    expect(readPageSessionCookie(new Request("http://aaaaaaaaaaaa.pages.localhost:8787/", { headers: { Cookie: "tendril_local=tok123" } }), localEnv)).toBe("tok123");

    const prodCookie = pageSessionCookieHeader("tok123", prodEnv);
    expect(prodCookie).toContain("__Host-tendril=tok123");
    expect(prodCookie).toContain("Secure");
    // Plain-HTTP fallback cookie is never accepted on HTTPS origins.
    expect(readPageSessionCookie(new Request("https://aaaaaaaaaaaa.pages.tendriller.dev/", { headers: { Cookie: "tendril_local=tok123" } }), prodEnv)).toBeNull();
    expect(readPageSessionCookie(new Request("https://aaaaaaaaaaaa.pages.tendriller.dev/", { headers: { Cookie: "__Host-tendril=tok123" } }), prodEnv)).toBe("tok123");

    // Plain-HTTP loopback page responses omit HSTS so browsers do not upgrade *.pages.localhost to HTTPS.
    const localPageResp = await route(new Request("http://aaaaaaaaaaaa.pages.localhost:8787/"), localEnv);
    expect(localPageResp.headers.get("Strict-Transport-Security")).toBeNull();
    const prodPageResp = await route(new Request("https://aaaaaaaaaaaa.pages.tendriller.dev/"), prodEnv);
    expect(prodPageResp.headers.get("Strict-Transport-Security")).toContain("max-age=");

    // Auth page CSP form-action allows redirects to the configured page subdomain, and never prefills masked emails.
    expect(authFormAction(localEnv)).toBe("'self' http://*.pages.localhost:8787");
    expect(authFormAction(prodEnv)).toBe("'self' https://*.pages.tendriller.dev");
    const controls = renderAuthControls({ ...localEnv, LOCAL_DEV_AUTH: "1" }, "/auth/page", { expectedEmail: "d***@local.dev" });
    expect(controls).toContain('value="dev@local.dev"');
    expect(controls).not.toContain('value="d***@local.dev"');
  });
});
