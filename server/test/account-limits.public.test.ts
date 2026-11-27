import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { create, req } from "./helpers";

describe("Configurable per-account limits in service_state", () => {
  it("supports unlimited NULL caps on localhost while preserving default production limits", async () => {
    const handle = await create();
    try {
      await env.ACCOUNTS.prepare("UPDATE service_state SET account_page_cap = NULL, account_resident_cap = NULL, account_storage_cap = NULL WHERE id = 1").run();
      for (let i = 0; i < 21; i++) {
        await env.ACCOUNTS.prepare("INSERT INTO tendrils (id, owner_account, created_at, lifetime) VALUES (?, ?, ?, 'resident')")
          .bind(`u${String(i).padStart(2, "0")}000000000`, handle.account!, Date.now()).run();
      }
      const dashHtml = await (await req("/dashboard", {
        anonymous: true,
        headers: { Cookie: handle.session! },
      })).text();
      expect(dashHtml).not.toContain("You have reached 20 resident pages");
      expect(dashHtml).not.toContain("/ 20</small>");
    } finally {
      await env.ACCOUNTS.prepare("UPDATE service_state SET account_page_cap = 20, account_resident_cap = 20, account_storage_cap = 1073741824 WHERE id = 1").run();
    }
  });
});
