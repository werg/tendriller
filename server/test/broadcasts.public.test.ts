import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { agentReq, BASE, create, createAgent, inDO, req } from "./helpers";
import { HUB_PROTOCOL } from "../src/agents";
import { sha256Hex } from "../src/ids";
import { verifyBroadcastSignature, type BroadcastPublicJwk, type SignedBroadcast } from "../../contract/broadcasts.mjs";

async function adminCookie(provider = "github", subject = "broadcast-admin-1"): Promise<string> {
  const accountId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = Date.now();
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(accountId, now, `${subject}@example.test`),
    env.ACCOUNTS.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(provider, subject, accountId, subject, `${subject}@example.test`, now),
    env.ACCOUNTS.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), accountId, now, now + 86_400_000),
  ]);
  (env as unknown as Record<string, string>).ADMIN_IDENTITIES = `${provider}:${subject}`;
  return `__Host-tendriller=${token}`;
}

describe("System-wide Ed25519-signed broadcasts and version inventory", () => {
  it("signs broadcasts with Ed25519, publishes public keys, serves ETag-cached /api/broadcasts, and revokes cleanly", async () => {
    const cookie = await adminCookie("github", "bc-admin-a");

    // Publish an agent + dashboard + page_owners broadcast via /api/admin/broadcasts.
    const createdRes = await req("/api/admin/broadcasts", {
      method: "POST",
      anonymous: true,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "upgrade",
        severity: "urgent",
        audiences: ["agents", "page_owners", "dashboard", "mcp"],
        title: "Upgrade @chronolog/peer-session to 0.5.0",
        summary: "Includes a relay protocol fix; republish your pages after upgrading.",
        body: "Run npm install with the new first-app kit and republish.",
        docs_url: "https://tendriller.dev/docs/RELEASE_COMPOSITION.md",
        match: { packages: { "@chronolog/peer-session": "<0.5.0" } },
        action: { kind: "upgrade_dependencies", packages: { "@chronolog/peer-session": ">=0.5.0" }, requires_republish: true },
      }),
    });
    expect(createdRes.status).toBe(201);
    const created = await createdRes.json() as SignedBroadcast;
    expect(created.payload.id).toMatch(/^bc_[a-z2-7]{26}$/);
    expect(created.signature.alg).toBe("Ed25519");

    // Verify public signing keys at /.well-known/tendriller-broadcast-keys.json and /.well-known/tendriller.json.
    const keysRes = await req("/.well-known/tendriller-broadcast-keys.json", { anonymous: true });
    expect(keysRes.status).toBe(200);
    const keysDoc = await keysRes.json() as { issuer: string; keys: BroadcastPublicJwk[] };
    expect(keysDoc.issuer).toBe(BASE);
    expect(keysDoc.keys.length).toBeGreaterThanOrEqual(1);
    expect((keysDoc.keys[0] as unknown as Record<string, unknown>).d).toBeUndefined();

    const verified = await verifyBroadcastSignature(created, keysDoc.keys, { issuer: BASE });
    expect(verified.valid).toBe(true);

    const wellKnown = await (await req("/.well-known/tendriller.json", { anonymous: true })).json() as {
      interfaces: { broadcasts: string; broadcast_keys: string };
      broadcast_keys: BroadcastPublicJwk[];
    };
    expect(wellKnown.interfaces.broadcasts).toBe(`${BASE}/api/broadcasts`);
    expect(wellKnown.interfaces.broadcast_keys).toBe(`${BASE}/.well-known/tendriller-broadcast-keys.json`);
    expect(wellKnown.broadcast_keys.length).toBeGreaterThanOrEqual(1);

    // Readiness includes broadcasts summary.
    const readiness = await (await req("/api/readiness", { anonymous: true })).json() as {
      broadcasts?: { latestSeq: number; activeCount: number; criticalCount: number };
    };
    expect(readiness.broadcasts?.activeCount).toBeGreaterThanOrEqual(1);
    expect(readiness.broadcasts?.criticalCount).toBeGreaterThanOrEqual(1);

    // /api/broadcasts supports audience filtering, since cursor, and ETag 304.
    const feedRes = await req("/api/broadcasts?audience=agents", { anonymous: true });
    expect(feedRes.status).toBe(200);
    const etag = feedRes.headers.get("ETag");
    expect(etag).toBeTruthy();
    const feed = await feedRes.json() as { issuer: string; latest_seq: number; broadcasts: SignedBroadcast[] };
    expect(feed.broadcasts.some(b => b.payload.id === created.payload.id)).toBe(true);

    const notMod = await req("/api/broadcasts?audience=agents", { anonymous: true, headers: { "If-None-Match": etag! } });
    expect(notMod.status).toBe(304);

    const afterSeq = await (await req(`/api/broadcasts?audience=agents&since=${feed.latest_seq}`, { anonymous: true })).json() as { broadcasts: SignedBroadcast[] };
    expect(afterSeq.broadcasts).toEqual([]);

    // Status page surfaces dashboard/page_all notices.
    const statusHtml = await (await req("/status", { anonymous: true })).text();
    expect(statusHtml).toContain("Upgrade @chronolog/peer-session to 0.5.0");

    // Revoke removes it from active feed.
    const revRes = await req(`/api/admin/broadcasts/${created.payload.id}`, {
      method: "DELETE",
      anonymous: true,
      headers: { Cookie: cookie },
    });
    expect(revRes.status).toBe(200);
    const afterRevoke = await (await req("/api/broadcasts?audience=agents", { anonymous: true })).json() as { broadcasts: SignedBroadcast[] };
    expect(afterRevoke.broadcasts.some(b => b.payload.id === created.payload.id)).toBe(false);
  });

  it("delivers signed broadcasts and records versions over AgentHub hello and /api/agent/versions, and reports fleet versions in /admin", async () => {
    const cookie = await adminCookie("github", "bc-admin-b");
    const created = await (await req("/api/admin/broadcasts", {
      method: "POST",
      anonymous: true,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "security",
        severity: "critical",
        audiences: ["agents"],
        title: "Security advisory for agents",
        summary: "Update connector dependencies immediately.",
      }),
    })).json() as SignedBroadcast;

    const agent = await createAgent("fleet-owner@example.test", "fleetbot");

    // Report versions via HTTP PUT /api/agent/versions.
    const putRes = await agentReq(agent.token, "PUT", "/api/agent/versions", {
      core: "0.3.0-rc.17",
      chronolog: "0.4.2",
      tools: "0.3.0-rc.17",
      node: "24.1.0",
    });
    expect(putRes.status).toBe(200);

    const selfData = await (await agentReq(agent.token, "GET", "/api/agent")).json() as {
      versions?: { core?: string; chronolog?: string };
      broadcasts?: { activeCount: number };
    };
    expect(selfData.versions?.chronolog).toBe("0.4.2");
    expect(selfData.broadcasts?.activeCount).toBeGreaterThanOrEqual(1);

    // Connect to AgentHub WebSocket and send hello with updated versions + cursor 0.
    const wsRes = await req("/api/agent/hub", {
      anonymous: true,
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `${HUB_PROTOCOL}, ${agent.token}` },
    });
    expect(wsRes.status).toBe(101);
    const socket = wsRes.webSocket!;
    socket.accept();
    const received = new Promise<Record<string, unknown>>(resolve => {
      socket.addEventListener("message", event => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.t === "broadcasts") resolve(frame);
      });
    });
    socket.send(JSON.stringify({
      t: "hello",
      versions: { core: "0.3.0-rc.17", chronolog: "0.4.3", tools: "0.3.0-rc.17" },
      last_broadcast_seq: 0,
    }));
    const frame = await received;
    const broadcasts = frame.broadcasts as SignedBroadcast[];
    const keys = frame.keys as BroadcastPublicJwk[];
    expect(broadcasts.some(b => b.payload.id === created.payload.id)).toBe(true);
    expect((await verifyBroadcastSignature(broadcasts.find(b => b.payload.id === created.payload.id)!, keys, { issuer: BASE })).valid).toBe(true);
    socket.close(1000, "done");

    // /api/admin/broadcasts reports fleet versions including the updated chronolog 0.4.3.
    const adminData = await (await req("/api/admin/broadcasts", {
      anonymous: true,
      headers: { Cookie: cookie },
    })).json() as { fleet: { agents: { reporting: number; byChronolog: Array<{ version: string; count: number }> } } };
    expect(adminData.fleet.agents.reporting).toBeGreaterThanOrEqual(1);
    expect(adminData.fleet.agents.byChronolog.some(row => row.version === "0.4.3")).toBe(true);

    // /admin HTML page renders Fleet versions and System broadcasts.
    const adminHtml = await (await req("/admin", { anonymous: true, headers: { Cookie: cookie } })).text();
    expect(adminHtml).toContain("System broadcasts (Ed25519 signed)");
    expect(adminHtml).toContain("Fleet versions");
    expect(adminHtml).toContain("0.4.3");

    await req(`/api/admin/broadcasts/${created.payload.id}`, { method: "DELETE", anonymous: true, headers: { Cookie: cookie } });
  });

  it("scopes _tendril/broadcasts by page role (owner vs display) and renders system announcements on /dashboard", async () => {
    const cookie = await adminCookie("github", "bc-admin-c");
    const ownerOnly = await (await req("/api/admin/broadcasts", {
      method: "POST",
      anonymous: true,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "upgrade",
        severity: "recommended",
        audiences: ["page_owners", "dashboard"],
        title: "Owner-only republish reminder",
        summary: "Reconnect an agent to refresh this page.",
      }),
    })).json() as SignedBroadcast;
    const everyone = await (await req("/api/admin/broadcasts", {
      method: "POST",
      anonymous: true,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "maintenance",
        severity: "info",
        audiences: ["page_all"],
        title: "Planned read-only maintenance",
        summary: "Local edits remain saved offline.",
      }),
    })).json() as SignedBroadcast;

    const handle = await create();
    // Owner sees both page_owners and page_all broadcasts.
    const ownerRes = await req(`${handle.page_url}_tendril/broadcasts`);
    expect(ownerRes.status).toBe(200);
    const ownerFeed = await ownerRes.json() as {
      issuer: string;
      keys: BroadcastPublicJwk[];
      page: { role: string; agent_count: number };
      broadcasts: SignedBroadcast[];
    };
    expect(ownerFeed.page.role).toBe("owner");
    expect(ownerFeed.broadcasts.some(b => b.payload.id === ownerOnly.payload.id)).toBe(true);
    expect(ownerFeed.broadcasts.some(b => b.payload.id === everyone.payload.id)).toBe(true);

    // Display link sees ONLY page_all (not owner-only upgrade notices).
    const displayLink = await inDO(handle.id, async t => {
      const link = await t.createLink("display", "Kiosk", null);
      return t.renderLink(link);
    });
    const displayRes = await req(`${displayLink.url}_tendril/broadcasts`, { anonymous: true });
    expect(displayRes.status).toBe(200);
    const displayFeed = await displayRes.json() as { page: { role: string }; broadcasts: SignedBroadcast[] };
    expect(displayFeed.page.role).toBe("display");
    expect(displayFeed.broadcasts.some(b => b.payload.id === ownerOnly.payload.id)).toBe(false);
    expect(displayFeed.broadcasts.some(b => b.payload.id === everyone.payload.id)).toBe(true);

    // Dashboard shows system announcements to the page owner.
    const dashHtml = await (await req("/dashboard", {
      anonymous: true,
      headers: { Cookie: handle.session! },
    })).text();
    expect(dashHtml).toContain("System announcements");
    expect(dashHtml).toContain("Owner-only republish reminder");

    await req(`/api/admin/broadcasts/${ownerOnly.payload.id}`, { method: "DELETE", anonymous: true, headers: { Cookie: cookie } });
    await req(`/api/admin/broadcasts/${everyone.payload.id}`, { method: "DELETE", anonymous: true, headers: { Cookie: cookie } });
  });
});
