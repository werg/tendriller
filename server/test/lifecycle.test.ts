import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { advance, api, apiJson, create, inDO, PageClient, req, runAlarm, sleep } from "./helpers";

describe("tokens and shared tendrils", () => {
  it("issues named tokens, attributes changes, lists and revokes", async () => {
    const h = await create();
    const t2 = await apiJson(h, "POST", "tokens", { name: "alice-agent" }, 201);
    expect(t2).toMatchObject({ name: "alice-agent", token: expect.stringMatching(/^tk_/) });
    const dup = await api(h, "POST", "tokens", { name: "alice-agent" });
    expect(dup.status).toBe(409);
    await dup.text();
    const page = await PageClient.connect(h.page_url);
    const r = await api(h, "PATCH", "state", { list: { x: 1 } }, {}, t2.token);
    await r.text();
    expect(await page.next("state")).toMatchObject({ by: "agent:alice-agent" });
    const note = await api(h, "POST", "activity", { text: "added an item" }, {}, t2.token);
    expect(note.status).toBe(201);
    await note.text();
    await api(h, "PUT", "files/index.html", "<p>x</p>", {}, t2.token).then((r) => r.text());
    const act = await apiJson(h, "GET", "activity");
    expect(act.entries.find((e: any) => e.kind === "note")).toMatchObject({ summary: "added an item", by: "alice-agent", source: "agent" });
    expect(act.entries.find((e: any) => e.kind === "version")).toMatchObject({ by: "alice-agent", source: "server" });
    const versions = await apiJson(h, "GET", "versions");
    expect(versions.versions[0].by).toBe("alice-agent");

    const list = await apiJson(h, "GET", "tokens");
    expect(list.tokens.map((t: any) => t.name)).toEqual(["main", "alice-agent"]);
    expect(list.tokens[1].last_used).toEqual(expect.any(Number));
    expect(JSON.stringify(list)).not.toContain("tk_");
    expect((await api(h, "DELETE", "tokens/alice-agent")).status).toBe(204);
    const revoked = await api(h, "GET", "", undefined, {}, t2.token);
    expect(revoked.status).toBe(401);
    await revoked.text();
    page.close();
  });

  it("stores tokens only as hashes", async () => {
    const h = await create();
    const rows = await inDO(h.id, (t) => t.db.all("SELECT * FROM tokens"));
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(h.token);
  });
});

describe("adopt", () => {
  it("an owner page creates a code; adopting revokes old tokens and returns a fresh handle", async () => {
    const h = await create({ name: "Kitchen", lifetime: "resident" });
    const extra = await apiJson(h, "POST", "tokens", { name: "other" }, 201);
    const page = await PageClient.connect(h.page_url);
    const msg = await page.request({ t: "adopt_code" });
    expect(msg).toMatchObject({ t: "adopt_code", code: expect.stringMatching(new RegExp(`^${h.id}-\\d{6}$`)), expires_at: expect.any(Number) });

    const bad = await req("/api/adopt", { method: "POST", body: JSON.stringify({ code: `${h.id}-000000` === msg.code ? `${h.id}-000001` : `${h.id}-000000` }) });
    expect(bad.status).toBe(404);
    await bad.text();
    const malformed = await req("/api/adopt", { method: "POST", body: JSON.stringify({ code: "nope" }) });
    expect(malformed.status).toBe(400);
    await malformed.text();

    const res = await req("/api/adopt", { method: "POST", body: JSON.stringify({ code: msg.code }) });
    expect(res.status).toBe(200);
    const nh = await res.json<any>();
    expect(nh).toMatchObject({ id: h.id, name: "Kitchen", page_url: h.page_url, lifetime: "resident", token: expect.stringMatching(/^tk_/) });
    expect(nh.token).not.toBe(h.token);
    for (const old of [h.token, extra.token]) {
      const r = await api(h, "GET", "", undefined, {}, old);
      expect(r.status).toBe(401);
      await r.text();
    }
    expect((await apiJson({ ...h, token: nh.token }, "GET", "")).id).toBe(h.id);
    // single use
    const again = await req("/api/adopt", { method: "POST", body: JSON.stringify({ code: msg.code }) });
    expect(again.status).toBe(404);
    await again.text();
    page.close();
  });

  it("codes expire after 10 minutes and burn after repeated wrong guesses", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    const { code } = await page.request({ t: "adopt_code" });
    await advance(h.id, 11 * 60_000);
    const late = await req("/api/adopt", { method: "POST", body: JSON.stringify({ code }) });
    expect(late.status).toBe(404);
    await late.text();

    const { code: code2 } = await page.request({ t: "adopt_code" });
    const wrong = code2.endsWith("0") ? code2.slice(0, -1) + "1" : code2.slice(0, -1) + "0";
    for (let i = 0; i < 10; i++) await (await req("/api/adopt", { method: "POST", body: JSON.stringify({ code: wrong }) })).text();
    const burnt = await req("/api/adopt", { method: "POST", body: JSON.stringify({ code: code2 }) });
    expect(burnt.status).toBe(404);
    await burnt.text();
    page.close();
  });

  it("only owners can request a code", async () => {
    const h = await create();
    const link = await apiJson(h, "POST", "links", { role: "guest" }, 201);
    const guest = await PageClient.connect(link.url);
    expect(await guest.request({ t: "adopt_code" })).toMatchObject({ t: "error", code: "forbidden" });
    guest.close();
  });
});

describe("blobs and activity", () => {
  it("page uploads a blob; agent reads it; activity references it; owner deletion removes the bytes", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    const up = await req(h.page_url + "_tendril/blob", {
      method: "POST",
      body: new Uint8Array([0xff, 0xd8, 0xff]),
      headers: { "Content-Type": "image/jpeg", "X-Tendril-Name": "drawer.jpg", "X-Tendril-Device": page.deviceId },
    });
    const blob = await up.json<any>();
    expect(blob).toEqual({ id: expect.stringMatching(/^b_[a-z2-7]{20}$/), url: `_tendril/blob/${blob.id}` });
    const viaPage = await req(h.page_url + blob.url);
    expect(viaPage.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await viaPage.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    const viaApi = await api(h, "GET", `blobs/${blob.id}`);
    expect((await viaApi.arrayBuffer()).byteLength).toBe(3);
    const list = await apiJson(h, "GET", "blobs");
    expect(list.blobs[0]).toMatchObject({ id: blob.id, type: "image/jpeg", size: 3, name: "drawer.jpg", device: page.deviceId });

    const act = await page.request({ t: "activity" });
    const entry = act.entries.find((e: any) => e.kind === "blob");
    expect(entry).toMatchObject({ blob: blob.id, device: page.deviceId, source: "server" });
    expect(entry.summary).toContain("Photo");
    const del = await page.request({ t: "activity_delete", seq: entry.seq });
    expect(del).toMatchObject({ t: "ack", seq: entry.seq });
    expect(await env.FILES.head(`t/${h.id}/blobs/${blob.id}`)).toBeNull();
    const gone = await api(h, "GET", `blobs/${blob.id}`);
    expect(gone.status).toBe(404);
    await gone.text();
    page.close();
  });

  it("agent uploads blobs with PUT blobs and can use one as the icon", async () => {
    const h = await create();
    const up = await apiJson(h, "PUT", "blobs", new Uint8Array([1, 2]), undefined);
    expect(up.url).toBe(`_tendril/blob/${up.id}`);
    const info = await apiJson(h, "PATCH", "", { icon: up.id });
    expect(info.meta.icon).toBe(up.id);
    const icon = await req(h.page_url + "_tendril/icon");
    expect((await icon.arrayBuffer()).byteLength).toBe(2);
  });

  it("records instructions, evals, versions, wakes, event counts and notes", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    page.onEval = () => 1;
    await page.request({ t: "send", kind: "instruction", text: "show the map", via: "voice" });
    for (let i = 0; i < 3; i++) await page.request({ t: "send", data: { type: "location", i }, wake: false });
    await page.request({ t: "send", data: { type: "tap" }, wake: false });
    await apiJson(h, "POST", "eval", { code: "return 1" });
    await apiJson(h, "PUT", "files/index.html", "<p>x</p>");
    await apiJson(h, "POST", "activity", { text: "note" }, 201);
    const { entries, cursor } = await apiJson(h, "GET", "activity");
    const kinds = entries.map((e: any) => e.kind);
    for (const k of ["created", "instruction", "wake", "events", "eval", "version", "note"]) expect(kinds, k).toContain(k);
    expect(entries.find((e: any) => e.kind === "instruction").summary).toContain("show the map");
    expect(entries.find((e: any) => e.kind === "events").summary).toBe("Page sent 4 events (location ×3, tap ×1)");
    expect(entries.find((e: any) => e.kind === "eval").summary).toContain("return 1");
    expect(cursor).toBe(entries[entries.length - 1].seq);
    expect((await apiJson(h, "GET", `activity?after=${cursor}`)).entries).toEqual([]);
    page.close();
  });

  it("aggregates withheld wakes into one entry", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    await apiJson(h, "PUT", "wake", { budget: { page_per_hour: 0 } });
    for (let i = 0; i < 3; i++) await page.request({ t: "send", data: {} });
    const entries = (await apiJson(h, "GET", "activity")).entries.filter((e: any) => e.kind === "wake_withheld");
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain("3 page wakes withheld");
    page.close();
  });

  it("drops activity and events older than 30 days during cleanup", async () => {
    const h = await create();
    await apiJson(h, "POST", "activity", { text: "old" }, 201);
    await advance(h.id, 31 * 86400_000);
    await apiJson(h, "POST", "activity", { text: "new" }, 201);
    await inDO(h.id, (t) => t.cleanup());
    const entries = (await apiJson(h, "GET", "activity")).entries;
    expect(entries.map((e: any) => e.summary)).toEqual(["new"]);
  });

  it("guests cannot read activity", async () => {
    const h = await create();
    const link = await apiJson(h, "POST", "links", { role: "guest" }, 201);
    const guest = await PageClient.connect(link.url);
    expect(await guest.request({ t: "activity" })).toMatchObject({ code: "forbidden" });
    guest.close();
  });
});

describe("lifetime and deletion", () => {
  it("ad_hoc tendrils expire after 24 h with no check-in and no device; storage and R2 wiped", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/index.html", "<p>x</p>");
    await apiJson(h, "PUT", "blobs", new Uint8Array([1]));
    expect((await env.FILES.list({ prefix: `t/${h.id}/` })).objects.length).toBe(2);
    await advance(h.id, 23 * 3600_000);
    await runAlarm(h.id);
    expect((await api(h, "GET", "")).status).toBe(200); // still alive, and this check-in extends it
    await advance(h.id, 25 * 3600_000);
    await runAlarm(h.id);
    const gone = await api(h, "GET", "");
    expect(gone.status).toBe(404);
    await gone.text();
    const page = await req(h.page_url);
    expect(page.status).toBe(404);
    await page.text();
    expect((await env.FILES.list({ prefix: `t/${h.id}/` })).objects.length).toBe(0);
  });

  it("a connected device keeps an ad_hoc tendril alive", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    await advance(h.id, 48 * 3600_000);
    await runAlarm(h.id);
    expect((await api(h, "GET", "")).status).toBe(200);
    page.close();
  });

  it("resident tendrils never expire", async () => {
    const h = await create({ lifetime: "resident" });
    await advance(h.id, 90 * 86400_000);
    await runAlarm(h.id);
    const r = await api(h, "GET", "");
    expect(r.status).toBe(200);
    expect((await r.json<any>()).expires_at).toBeNull();
  });

  it("DELETE wipes everything and closes sockets", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/index.html", "<p>x</p>");
    const page = await PageClient.connect(h.page_url);
    const del = await api(h, "DELETE", "");
    expect(del.status).toBe(204);
    await sleep(50);
    expect(page.closed?.code).toBe(4004);
    expect((await env.FILES.list({ prefix: `t/${h.id}/` })).objects.length).toBe(0);
    const after = await api(h, "GET", "");
    expect(after.status).toBe(404);
    await after.text();
    expect(await inDO(h.id, (t) => t.exists())).toBe(false);
  });
});
