import { afterEach, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { authenticateAgent, authenticateAgentToken, authenticateProducer, authorizeSocket, readPageSession } from "../src/access";
import type { Tendril } from "../src/tendril";
import { api, apiJson, create, inDO, ownerHeaders, PageClient, req } from "./helpers";

const pages: PageClient[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.close(); });

it("resolves agent credentials without recording activity; API calls explicitly check in", async () => {
  const h = await create({ listener: false });
  await inDO(h.id, async t => {
    t.db.set("last_checkin", 123);
    t.db.set("wake_pending_since", 456);
    const before = t.db.all("SELECT name,last_used FROM tokens");
    const request = new Request(h.api, { headers: { Authorization: `Bearer ${h.token}` } });
    const principal = await authenticateAgent(t, request);
    expect(principal.kind).toBe("agent");
    expect(await authenticateAgentToken(t, h.token)).toEqual(principal);
    expect(await t.authAgent(request)).toBe(principal.name);
    expect(await t.authToken(h.token)).toBe(principal.name);
    expect(t.db.get("last_checkin", 0)).toBe(123);
    expect(t.db.get("wake_pending_since", 0)).toBe(456);
    expect(t.db.all("SELECT name,last_used FROM tokens")).toEqual(before);
  });
  expect((await api(h, "GET", "state")).status).toBe(200);
  await inDO(h.id, t => {
    expect(t.db.get("last_checkin", 0)).toBeGreaterThan(123);
    expect(t.db.get("wake_pending_since", null)).toBeNull();
  });
});

it("records producer activity only for an accepted append and keeps agent attention separate", async () => {
  const h = await create({ listener: false });
  await apiJson(h, "POST", "streams", { name: "training", durability: "durable" }, 201);
  const credential = await apiJson(h, "POST", "producers", { name: "sampler", streams: ["training"] }, 201);
  await inDO(h.id, async t => {
    t.db.set("last_checkin", 123); t.db.set("wake_pending_since", 456); t.db.set("last_producer_seen", 789);
    const principal = await authenticateProducer(t, new Request(h.api, { headers: { Authorization: `Bearer ${credential.token}` } }));
    expect(principal).toMatchObject({ kind: "producer", name: "sampler", streams: ["training"] });
    expect(t.db.one("SELECT last_seen FROM stream_producers WHERE name='sampler'")).toEqual({ last_seen: null });
    expect(t.db.get("last_producer_seen", 0)).toBe(789);
  });
  expect((await api(h, "POST", "streams/training/records", { records: [] }, {}, credential.token)).status).toBe(400);
  expect(await inDO(h.id, t => t.db.get("last_producer_seen", 0))).toBe(789);
  expect((await api(h, "POST", "streams/training/records", { records: [{ id: "one", type: "metric", data: 1 }] }, {}, credential.token)).status).toBe(200);
  await inDO(h.id, t => {
    expect(t.db.get("last_producer_seen", 0)).toBeGreaterThan(789);
    expect(t.db.get("last_checkin", 0)).toBe(123);
    expect(t.db.get("wake_pending_since", 0)).toBe(456);
  });
});

it.each(["session revoked", "session expired", "link revoked", "owner deleting"])(
  "rejects hello before disclosing state when %s after upgrade", async reason => {
    const h = await create({ listener: false });
    const page = new PageClient(h.page_url); pages.push(page); page.headers = ownerHeaders(h.page_url);
    await page.open();
    await inDO(h.id, t => {
      t.db.set("state", { private: "must not appear in welcome" });
      if (reason === "session revoked") t.db.run("DELETE FROM page_sessions");
      if (reason === "session expired") t.db.run("UPDATE page_sessions SET expires_at=?", t.now());
      if (reason === "link revoked") t.db.run("DELETE FROM links WHERE id='l_main'");
    });
    if (reason === "owner deleting") {
      const owner = await inDO(h.id, t => t.db.get("owner_account", ""));
      await env.ACCOUNTS.prepare("UPDATE accounts SET deleting_at=? WHERE id=?").bind(Date.now(), owner).run();
    }
    page.send({ t: "hello", device_id: page.deviceId, device_secret: page.secret });
    await expect.poll(() => page.closed?.code).toBe(4003);
    expect(page.drain().some(message => message.t === "welcome" || message.t === "state_reset")).toBe(false);
    expect(await inDO(h.id, t => t.device(page.deviceId))).toBeNull();
  },
);

it("applies session expiry consistently to HTTP and ordinary socket writes", async () => {
  const h = await create({ listener: false });
  const page = await PageClient.connect(h.page_url); pages.push(page);
  await inDO(h.id, t => t.db.run("UPDATE page_sessions SET expires_at=?", t.now()));
  const response = await req(h.page_url + "_tendril/streams", { redirect: "manual" });
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toContain("/auth/page?");
  page.send({ t: "state", cid: "expired", ops: [{ op: "set", path: ["forbidden"], value: true }] });
  await expect.poll(() => page.closed?.code).toBe(4003);
  expect(await inDO(h.id, t => t.getState().state)).toEqual({});
  expect(page.drain().some(message => message.cid === "expired")).toBe(false);
});

it.each(["session", "link"])("stops legacy broadcasts after revoking a %s", async target => {
  const h = await create({ listener: false });
  const page = await PageClient.connect(h.page_url); pages.push(page); page.drain();
  await inDO(h.id, t => {
    if (target === "session") t.db.run("DELETE FROM page_sessions");
    else t.db.run("DELETE FROM links WHERE id='l_main'");
    t.applyState([{ op: "set", path: ["private"], value: "after revocation" }], "test");
    t.broadcast({ t: "say", text: "after revocation" });
  });
  await expect.poll(() => page.closed?.code).toBe(4003);
  expect(page.drain().some(message => message.t === "state" || message.t === "say")).toBe(false);
});

// Exercise the real D1 query, then change local state at its asynchronous boundary.
async function duringAccountRead<T>(t: Tendril, mutate: () => void, run: () => Promise<T>): Promise<T> {
  const original = t.env.ACCOUNTS;
  let changed = false;
  t.env.ACCOUNTS = {
    prepare(sql: string) {
      const statement = original.prepare(sql);
      if (!sql.includes("FROM accounts WHERE id")) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { async first() { const result = await bound.first(); changed = true; mutate(); return result; } };
      } };
    },
  } as D1Database;
  try { const result = await run(); expect(changed).toBe(true); return result; }
  finally { t.env.ACCOUNTS = original; }
}

it("revalidates local page sessions after asynchronous account lookup", async () => {
  const h = await create({ listener: false });
  await inDO(h.id, async t => {
    const session = await duringAccountRead(t, () => t.db.run("DELETE FROM page_sessions"),
      () => readPageSession(t, new Request(h.page_url, { headers: ownerHeaders(h.page_url) })));
    expect(session).toBeNull();
  });
});

it("revalidates socket access after I/O without overwriting newer subscription cursors", async () => {
  const h = await create({ listener: false });
  const page = await PageClient.connect(h.page_url); pages.push(page);
  await inDO(h.id, async t => {
    const ws = t.connectedSockets().find(socket => socket.att.deviceId === page.deviceId)!.ws;
    const principal = await duringAccountRead(t,
      () => ws.serializeAttachment({ ...t.att(ws)!, streams: { training: 42 } }),
      () => authorizeSocket(t, ws, { fresh: true }));
    expect(principal?.role).toBe("owner");
    expect(t.att(ws)?.streams).toEqual({ training: 42 });
    expect(await duringAccountRead(t, () => t.db.run("DELETE FROM page_sessions"),
      () => authorizeSocket(t, ws, { fresh: true }))).toBeNull();
  });
});
