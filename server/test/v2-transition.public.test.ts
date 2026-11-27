import { describe, expect, it } from "vitest";
import { req } from "./helpers";

describe("Retired / missing page transition screen (#147)", () => {
  it("renders an actionable HTML transition screen on /auth/page 404 while preserving JSON 404 for API clients", async () => {
    const missingId = "aaaaaaaaaaaa";
    const key = "b".repeat(26);

    const htmlRes = await req(`/auth/page?tendril=${missingId}&key=${key}`, {
      anonymous: true,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(htmlRes.status).toBe(404);
    expect(htmlRes.headers.get("Content-Type")).toContain("text/html");
    const html = await htmlRes.text();
    expect(html).toContain("This page is no longer hosted here");
    expect(html).toContain(missingId);
    expect(html).toContain("Your local data is untouched");
    expect(html).toContain("/dashboard");
    expect(html).toContain("/docs/V2_MIGRATION.md");

    const jsonRes = await req(`/auth/page?tendril=${missingId}&key=${key}`, {
      anonymous: true,
      headers: { Accept: "application/json" },
    });
    expect(jsonRes.status).toBe(404);
    const body = await jsonRes.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_found");
  });
});
