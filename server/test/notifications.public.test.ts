import { describe, expect, it } from "vitest";
import { api, apiJson, create, inDO, PageClient } from "./helpers";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("Web Push readiness", () => {
  it("tracks only registered owner devices and keeps subscriptions after page closure", async () => {
    const h = await create();
    const owner = await PageClient.connect(h.page_url);
    const before = await apiJson(h, "GET", "notify");
    expect(before).toMatchObject({ count: 0, subscribed_devices: [], quota: { limit: 20, used: 0, remaining: 20 } });
    const initially = await owner.request({ t: "push_status", endpoint: "https://push.example.com/abc" });
    expect(initially).toMatchObject({ t: "ack", subscribed: false });

    // A browser subscription is persisted in the DO, not in an active page connection.
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const subscription = {
      endpoint: "https://push.example.com/send/example",
      expirationTime: null,
      keys: { p256dh: base64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)),
        auth: base64url(crypto.getRandomValues(new Uint8Array(16))) },
    };
    await inDO(h.id, (t) => {
      t.db.run("INSERT INTO push_subs(device,sub,created_at) VALUES(?,?,?)", owner.deviceId, JSON.stringify(subscription), t.now());
    });
    expect(await owner.request({ t: "push_status", endpoint: subscription.endpoint })).toMatchObject({ subscribed: true });
    expect(await owner.request({ t: "push_status", endpoint: "https://push.example.com/other" })).toMatchObject({ subscribed: false });

    owner.close();
    const offline = await apiJson(h, "GET", "notify");
    expect(offline).toMatchObject({ count: 1, subscribed_devices: [{ id: owner.deviceId, name: "Test device" }] });
    // Server never exposes the browser's endpoint or secret keys.
    expect(JSON.stringify(offline)).not.toContain("push.example.com");
    expect(JSON.stringify(offline)).not.toContain(subscription.keys.auth);

    const rejoined = await PageClient.connect(h.page_url, { deviceId: owner.deviceId, secret: owner.secret });
    expect(await rejoined.request({ t: "push_unsubscribe" })).toMatchObject({ subscribed: false });
    expect((await apiJson(h, "GET", "notify")).count).toBe(0);
    rejoined.close();
  });

  it("removes stored push endpoints when the owner releases the page", async () => {
    const h = await create();
    const owner = await PageClient.connect(h.page_url);
    await inDO(h.id, t => t.db.run("INSERT INTO push_subs(device,sub,created_at) VALUES(?,?,?)",
      owner.deviceId, JSON.stringify({ endpoint: "https://push.example.com/send/stale" }), t.now()));
    expect(await inDO(h.id, t => t.db.one("SELECT device FROM push_subs LIMIT 1"))).toBeTruthy();
    const released = await api(h, "POST", "release");
    expect(released.status).toBe(200);
    expect(await inDO(h.id, t => t.db.one("SELECT device FROM push_subs LIMIT 1"))).toBeNull();
    owner.close();
  });

  it("enforces server configuration and rejects anonymous agent status access", async () => {
    const h = await create();
    const owner = await PageClient.connect(h.page_url);
    const status = await apiJson(h, "GET", "notify");
    expect(typeof status.available).toBe("boolean");
    const invalid = await owner.request({ t: "push_subscribe", subscription: {
      endpoint: "https://127.0.0.1/push", keys: { p256dh: "AA", auth: "AA" },
    } });
    expect(invalid).toMatchObject({ t: "ack", error: status.available ? "bad_subscription" : "push_unavailable" });
    const request = await api(h, "GET", "notify", undefined, {}, "invalid-token");
    expect(request.status).not.toBe(200);
    owner.close();
  });
});
