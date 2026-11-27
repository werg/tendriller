import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyPlanToAccount, getAccountEntitlements, recordAccountUsage } from "../src/billing/entitlements";
import { GB } from "../src/billing/plans";
import { createPremiumGrant, revokePremiumGrant } from "../src/billing/premium-grants";
import { handleRealtimeIce, handleRealtimeSfu } from "../src/realtime";
import { agentPrincipal, create, inDO } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cloudflare Realtime TURN & SFU brokering and entitlements", () => {
  it("mints short-lived TURN credentials within budget and degrades cleanly to STUN when exhausted", async () => {
    const h = await create();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/turn/keys/turn_key_1/credentials/generate-ice-servers")) {
        return new Response(JSON.stringify({
          iceServers: {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"],
            username: "u_dynamic",
            credential: "c_dynamic",
          },
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    // Free account with 2 GB/mo TURN trial gets TURN credentials, but sfuAvailable is false
    const freeRes = await inDO(h.id, async t => {
      const prevEnv = t.env;
      t.env = {
        ...prevEnv,
        CF_TURN_KEY_ID: "turn_key_1",
        CF_TURN_API_TOKEN: "turn_tok_1",
        CF_REALTIME_APP_ID: "app_sfu_1",
        CF_REALTIME_API_TOKEN: "sfu_tok_1",
      };
      try {
        return await handleRealtimeIce(t, new Request("https://tendril.internal/peers/ice", { method: "POST" }), agentPrincipal(t, h));
      } finally {
        t.env = prevEnv;
      }
    });
    expect(freeRes.status).toBe(200);
    const freeBody = await freeRes.json() as any;
    expect(freeBody.turnEnabled).toBe(true);
    expect(freeBody.sfuAvailable).toBe(false);
    expect(freeBody.iceServers.some((s: any) => JSON.stringify(s.urls).includes("turn.cloudflare.com"))).toBe(true);
    expect(freeBody.mediaQuota.limitBytes).toBe(2 * GB);

    // Exhaust the 2 GB Free trial -> degrades cleanly to STUN-only (still 200, never breaks direct P2P!)
    await recordAccountUsage(env, h.account!, { mediaBytes: 2 * GB });
    const exhaustedRes = await inDO(h.id, async t => {
      const prevEnv = t.env;
      t.env = { ...prevEnv, CF_TURN_KEY_ID: "turn_key_1", CF_TURN_API_TOKEN: "turn_tok_1" };
      try {
        return await handleRealtimeIce(t, new Request("https://tendril.internal/peers/ice", { method: "POST" }), agentPrincipal(t, h));
      } finally {
        t.env = prevEnv;
      }
    });
    expect(exhaustedRes.status).toBe(200);
    const exBody = await exhaustedRes.json() as any;
    expect(exBody.turnEnabled).toBe(false);
    expect(exBody.mediaQuota.exhausted).toBe(true);
    expect(exBody.iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
  });

  it("gates SFU sessions to Pro/Team, proxies Cloudflare Realtime tracks, and accounts egress usage", async () => {
    const h = await create();
    const peerId = "aa".repeat(32);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/apps/app_sfu_1/sessions/new")) {
        return new Response(JSON.stringify({ sessionId: "cf_sess_1" }), { status: 201 });
      }
      if (url.endsWith("/apps/app_sfu_1/sessions/cf_sess_1/tracks/new")) {
        return new Response(JSON.stringify({
          sessionDescription: { type: "answer", sdp: "v=0..." },
          tracks: [{ mid: "0", trackName: "main-cam" }],
        }), { status: 200 });
      }
      if (url.endsWith("/apps/app_sfu_1/sessions/cf_sess_1/renegotiate")) {
        return new Response(JSON.stringify({ sessionDescription: { type: "answer", sdp: "v=0..." } }), { status: 200 });
      }
      if (url.endsWith("/apps/app_sfu_1/sessions/cf_sess_1/tracks/close")) {
        return new Response(JSON.stringify({ tracks: [] }), { status: 200 });
      }
      return new Response(`unexpected ${init?.method} ${url}`, { status: 404 });
    });

    const runSfu = (action: string, method: string, body?: unknown, query = "") =>
      inDO(h.id, async t => {
        const prevEnv = t.env;
        t.env = { ...prevEnv, CF_REALTIME_APP_ID: "app_sfu_1", CF_REALTIME_API_TOKEN: "sfu_tok_1" };
        try {
          const url = new URL(`https://tendril.internal/peers/sfu/${action}${query}`);
          return await handleRealtimeSfu(t, new Request(url.toString(), {
            method,
            headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          }), url, action, agentPrincipal(t, h));
        } finally {
          t.env = prevEnv;
        }
      });

    // Free plan -> 402 quota_exceeded (quota: 'sfu')
    await expect(runSfu("sessions", "POST", { callId: "standup", peerId })).rejects.toMatchObject({
      status: 402,
      code: "quota_exceeded",
      extra: expect.objectContaining({ quota: "sfu", plan: "free" }),
    });

    // Upgrade to Pro -> creates session, publishes track, lists room, meters usage
    await applyPlanToAccount(env, h.account!, "pro");
    const created = await runSfu("sessions", "POST", { callId: "standup", peerId });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ sessionId: "cf_sess_1", maxPeers: 12, maxHeight: 720 });

    const trackRes = await runSfu("tracks", "POST", {
      sessionId: "cf_sess_1",
      sessionDescription: { type: "offer", sdp: "v=0..." },
      tracks: [{ location: "local", mid: "0", trackName: "main-cam", kind: "video" }],
    });
    expect(trackRes.status).toBe(200);

    const roomRes = await runSfu("room", "GET", undefined, "?callId=standup");
    expect(roomRes.status).toBe(200);
    const room = await roomRes.json() as any;
    expect(room.peers).toHaveLength(1);
    expect(room.peers[0].tracks[0].trackName).toBe("main-cam");

    // Spoofed/unknown SFU sessionId on usage endpoint -> 403 forbidden
    await expect(runSfu("usage", "POST", { sessionId: "cf_sess_unknown", bytesReceivedDelta: 1024 })).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });

    // Report 50 MB received -> persisted into usage_periods.media_bytes
    const usageRes = await runSfu("usage", "POST", { sessionId: "cf_sess_1", bytesReceivedDelta: 50 * 1024 * 1024 });
    expect(usageRes.status).toBe(200);
    expect(await usageRes.json()).toMatchObject({ ok: true, continueSfu: true });

    const ent = await getAccountEntitlements(env, h.account!);
    expect(ent.usage.mediaBytes).toBe(50 * 1024 * 1024);

    // Exhaust Pro 100 GB without PAYG -> usage endpoint signals continueSfu: false
    await recordAccountUsage(env, h.account!, { mediaBytes: 100 * GB });
    const overRes = await runSfu("usage", "POST", { sessionId: "cf_sess_1", bytesReceivedDelta: 1024 });
    expect(await overRes.json()).toMatchObject({ ok: true, continueSfu: false });

    // Close session cleans up room
    const closeRes = await runSfu("close", "PUT", { sessionId: "cf_sess_1", tracks: [{ mid: "0" }], endSession: true });
    expect(closeRes.status).toBe(200);
  });

  it("waives SFU report and close intervals spanning grant revocation without exempting later paid traffic", async () => {
    const h = await create();
    await applyPlanToAccount(env, h.account!, "pro");
    const id = crypto.randomUUID();
    const now = await inDO(h.id, t => t.now());
    await createPremiumGrant(env, "operator:testing", { id, accountId: h.account!, plan: "team", reason: "Video testing", expiresAt: now + 60_000 }, now);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ sessionId: "cf_test_session" }), { status: 201 }));
    const advance = (ms: number) => inDO(h.id, t => { t.skew += ms; return t.now(); });
    const run = (action: string, body: unknown) => inDO(h.id, async t => {
      const previous = t.env;
      t.env = { ...previous, CF_REALTIME_APP_ID: "test-app", CF_REALTIME_API_TOKEN: "test-token" };
      try {
        const url = new URL(`https://tendril.internal/peers/sfu/${action}`);
        return await handleRealtimeSfu(t, new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), url, action, agentPrincipal(t, h));
      } finally { t.env = previous; }
    });
    expect((await run("sessions", { peerId: "ab".repeat(32), callId: "test-call" })).status).toBe(201);
    await revokePremiumGrant(env, "operator:testing", id, "Testing complete", await advance(1000));
    await advance(1000);
    const overlap = await run("usage", { sessionId: "cf_test_session", bytesReceivedDelta: 1000 });
    expect(await overlap.json()).toMatchObject({ continueSfu: true }); // Underlying paid Pro remains valid.
    await advance(1000);
    await run("usage", { sessionId: "cf_test_session", bytesReceivedDelta: 2000 });
    let ent = await getAccountEntitlements(env, h.account!);
    expect(ent.usage.mediaBytes).toBe(3000);
    expect(ent.usage.complimentaryMediaBytes).toBe(1000);

    const secondId = crypto.randomUUID(), secondAt = await advance(1000);
    await createPremiumGrant(env, "operator:testing", { id: secondId, accountId: h.account!, plan: "team", reason: "Final video test", expiresAt: secondAt + 60_000 }, secondAt);
    await revokePremiumGrant(env, "operator:testing", secondId, "Complete", await advance(1000));
    await advance(1000);
    expect((await run("close", { sessionId: "cf_test_session", bytesReceivedDelta: 500, endSession: true })).status).toBe(200);
    await expect.poll(async () => (await getAccountEntitlements(env, h.account!)).usage.mediaBytes).toBe(3500);
    ent = await getAccountEntitlements(env, h.account!);
    expect(ent.usage.complimentaryMediaBytes).toBe(1500);
  });

  it("keeps late SFU test bytes complimentary at expiry and tells a Free account to stop SFU", async () => {
    const h = await create();
    const now = await inDO(h.id, t => t.now());
    await createPremiumGrant(env, "operator:testing", { id: crypto.randomUUID(), accountId: h.account!, plan: "pro", reason: "Short video test", expiresAt: now + 1000 }, now);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ sessionId: "cf_expiry_test" }), { status: 201 }));
    const run = (action: string, body: unknown) => inDO(h.id, async t => {
      const previous = t.env;
      t.env = { ...previous, CF_REALTIME_APP_ID: "test-app", CF_REALTIME_API_TOKEN: "test-token" };
      try {
        const url = new URL(`https://tendril.internal/peers/sfu/${action}`);
        return await handleRealtimeSfu(t, new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), url, action, agentPrincipal(t, h));
      } finally { t.env = previous; }
    });
    expect((await run("sessions", { peerId: "cd".repeat(32), callId: "expiry-test" })).status).toBe(201);
    await inDO(h.id, t => { t.skew += 2000; });
    const report = await run("usage", { sessionId: "cf_expiry_test", bytesReceivedDelta: 1024 });
    expect(await report.json()).toMatchObject({ continueSfu: false });
    expect((await getAccountEntitlements(env, h.account!)).usage).toMatchObject({ mediaBytes: 1024, complimentaryMediaBytes: 1024 });
  });

  it("preserves complimentary SFU coverage across same-millisecond revocation and resists backward clock steps", async () => {
    const h = await create();
    await applyPlanToAccount(env, h.account!, "pro");
    const id = crypto.randomUUID();
    const now = await inDO(h.id, t => t.now());
    await createPremiumGrant(env, "operator:testing", { id, accountId: h.account!, plan: "team", reason: "Same-ms SFU test", expiresAt: now + 60_000 }, now);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ sessionId: "cf_same_ms_test" }), { status: 201 }));
    const run = (action: string, body: unknown) => inDO(h.id, async t => {
      const previous = t.env;
      t.env = { ...previous, CF_REALTIME_APP_ID: "test-app", CF_REALTIME_API_TOKEN: "test-token" };
      try {
        const url = new URL(`https://tendril.internal/peers/sfu/${action}`);
        return await handleRealtimeSfu(t, new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), url, action, agentPrincipal(t, h));
      } finally { t.env = previous; }
    });
    // Pin t.now() to `now` so session admission and revocation occur in the exact same millisecond.
    await inDO(h.id, t => { t.now = () => now; });
    try {
      expect((await run("sessions", { peerId: "ef".repeat(32), callId: "same-ms-call" })).status).toBe(201);
      await revokePremiumGrant(env, "operator:testing", id, "Immediate revoke", now);
      await inDO(h.id, t => { t.now = () => now + 1000; });
      const firstReport = await run("usage", { sessionId: "cf_same_ms_test", bytesReceivedDelta: 2048 });
      expect(firstReport.status).toBe(200);
      // Subsequent interval starts after revocation, and even if the clock steps backward slightly it is still recorded as billable.
      await inDO(h.id, t => { t.now = () => now + 995; });
      const secondReport = await run("usage", { sessionId: "cf_same_ms_test", bytesReceivedDelta: 4096 });
      expect(secondReport.status).toBe(200);
      expect((await getAccountEntitlements(env, h.account!, now + 1000)).usage).toMatchObject({
        mediaBytes: 6144,
        complimentaryMediaBytes: 2048,
      });
    } finally {
      await inDO(h.id, t => { Reflect.deleteProperty(t, "now"); });
    }
  });
});
