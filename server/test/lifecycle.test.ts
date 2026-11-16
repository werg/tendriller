import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { advance, api, apiJson, create, inDO, PageClient, publishedFile, publishFilesJson, req, runAlarm, sleep, uploadBlobJson } from "./helpers";

describe("tokens and shared tendrils", () => {
  it("issues named tokens, attributes changes, lists and revokes", async () => {
    const h = await create();
    const t2 = await apiJson(h, "POST", "tokens", { name: "alice-agent" }, 201);
    expect(t2).toMatchObject({ name: "alice-agent", token: expect.stringMatching(/^tk_/) });
    const dup = await api(h, "POST", "tokens", { name: "alice-agent" });
    expect(dup.status).toBe(409);
    await dup.text();
    const page = await PageClient.connect(h.page_url);
    const r = await api(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: {}, ops: [{ op: "set", path: ["list"], value: { x: 1 } }] }, {}, t2.token);
    await r.text();
    expect(await page.next("state")).toMatchObject({ by: "agent:alice-agent" });
    const note = await api(h, "POST", "activity", { text: "added an item" }, {}, t2.token);
    expect(note.status).toBe(201);
    await note.text();
    await publishFilesJson(h, { "index.html": "<p>x</p>" }, { token: t2.token });
    const act = await apiJson(h, "GET", "activity");
    expect(act.entries.find((e: any) => e.kind === "note")).toMatchObject({ summary: "added an item", by: "alice-agent", source: "agent" });
    expect(act.entries.find((e: any) => e.kind === "version")).toMatchObject({ by: "agent:alice-agent", source: "server" });
    const versions = await apiJson(h, "GET", "publications");
    expect(versions.versions[0].by).toBe("agent:alice-agent");

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

});

describe("blobs and activity", () => {
  it("page uploads a blob; agent reads it; activity references it; owner deletion removes the bytes", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    const cid = crypto.randomUUID();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const blob = await uploadBlobJson(h, bytes, { page, cid, type: "image/jpeg", name: "drawer.jpg" });
    const repeated = await uploadBlobJson(h, bytes, { page, cid, type: "image/jpeg", name: "drawer.jpg" });
    expect(repeated).toEqual(blob);
    expect(blob).toEqual({ id: expect.stringMatching(/^b_[a-z2-7]{20}$/), url: `_tendril/blobs/${blob.id}`,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/), size: 3, type: "image/jpeg", name: "drawer.jpg", created_at: expect.any(Number),
      retention: { expires_at: expect.any(Number), reasons: ["unreferenced_upload"] } });
    const viaPage = await req(new URL(blob.url, h.page_url).href);
    expect(viaPage.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await viaPage.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    const viaApi = await api(h, "GET", `blobs/${blob.id}`);
    expect((await viaApi.arrayBuffer()).byteLength).toBe(3);
    const list = await apiJson(h, "GET", "blobs");
    expect(list.blobs[0]).toMatchObject({ id: blob.id, type: "image/jpeg", size: 3, name: "drawer.jpg" });

    const act = await page.request({ t: "activity" });
    const entries = act.entries.filter((e: any) => e.kind === "blob");
    expect(entries).toHaveLength(1); // A repeated completion receipt does not duplicate the audit.
    const entry = entries[0];
    expect(entry).toMatchObject({ blob: blob.id, device: page.deviceId, source: "server" });
    expect(entry.summary).toContain("Photo");
    const del = await page.request({ t: "activity_delete", seq: entry.seq });
    expect(del).toMatchObject({ t: "ack", seq: entry.seq });
    expect(await env.FILES.head(`t/${h.id}/files/${blob.sha256}`)).toBeNull();
    const gone = await api(h, "GET", `blobs/${blob.id}`);
    expect(gone.status).toBe(404);
    await gone.text();
    page.close();
  });

  it("agent uploads verified bytes and can keep them through an icon reference", async () => {
    const h = await create();
    const up = await uploadBlobJson(h, new Uint8Array([1, 2]));
    expect(up.url).toBe(`_tendril/blobs/${up.id}`);
    const info = await apiJson(h, "PATCH", "", { icon: up.id });
    expect(info.meta.icon).toBe(up.id);
    const icon = await req(h.page_url + "_tendril/icon");
    expect((await icon.arrayBuffer()).byteLength).toBe(2);
  });

  it("records instructions, evals, versions, wakes, event counts and notes", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    page.onEval = () => 1;
    await page.request({ t: "send", expected_generations: {}, kind: "instruction", text: "show the map", via: "voice" });
    for (let i = 0; i < 3; i++) await page.request({ t: "send", expected_generations: {}, data: { type: "location", i }, wake: false });
    await page.request({ t: "send", expected_generations: {}, data: { type: "tap" }, wake: false });
    await apiJson(h, "POST", "eval", { code: "return 1" });
    await publishFilesJson(h, { "index.html": "<p>x</p>" });
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
    await apiJson(h, "PUT", "wake", { budget: { page_streak: 0 } });
    for (let i = 0; i < 3; i++) await page.request({ t: "send", expected_generations: {}, data: {} });
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

  it("unreferenced page and agent uploads expire after 30 days while pins and the icon stay", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    const pageBlob = await uploadBlobJson(h, "photo", { page, type: "text/plain" });
    const iconBlob = await uploadBlobJson(h, "icon", { page, type: "image/png" });
    const agentBlob = await uploadBlobJson(h, "temporary asset", { type: "text/plain" });
    const pinnedBlob = await uploadBlobJson(h, "kept asset", { type: "text/plain" });
    await apiJson(h, "PUT", `blobs/${pinnedBlob.id}/pin`, { cid: crypto.randomUUID(), expected_generations: {}, keep: true });
    await apiJson(h, "PATCH", "", { icon: iconBlob.id });
    await advance(h.id, 31 * 86400_000);
    await inDO(h.id, (t) => t.cleanup());
    const ids = (await apiJson(h, "GET", "blobs")).blobs.map((b: any) => b.id).sort();
    expect(ids).toEqual([iconBlob.id, pinnedBlob.id].sort());
    expect(await env.FILES.get(`t/${h.id}/files/${pageBlob.sha256}`)).toBeNull();
    expect(await env.FILES.get(`t/${h.id}/files/${agentBlob.sha256}`)).toBeNull();
    expect((await api(h, "GET", `blobs/${iconBlob.id}`)).status).toBe(200);
    expect((await api(h, "GET", `blobs/${pinnedBlob.id}`)).status).toBe(200);
    page.close();
  });

  it("prunes old publications and releases their unreferenced bytes after the upload window", async () => {
    const h = await create();
    await publishFilesJson(h, { "index.html": "<p>First</p>", "old.txt": "only in v1" });
    const first = await apiJson(h, "GET", "publications/1");
    const hashOld = first.files.find((file: any) => file.path === "old.txt").sha256;
    const current = await uploadBlobJson(h, "<p>Current</p>", { type: "text/html" });
    let head = (await apiJson(h, "GET", "publications")).head_revision;
    for (let i = 0; i < 55; i++) {
      const published = await apiJson(h, "POST", "publications", { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: head,
        entry: "index.html", files: [{ path: "index.html", blob_id: current.id, type: current.type }] });
      head = published.head_revision;
    }
    await advance(h.id, 31 * 86400_000);
    await inDO(h.id, (t) => t.cleanup());
    const vs = (await apiJson(h, "GET", "publications")).versions;
    expect(vs.length).toBe(50);
    expect(vs[0].version).toBe(56);
    expect(await env.FILES.head(`t/${h.id}/files/${hashOld}`)).toBeNull();
    // files of kept versions are still served
    expect(await (await publishedFile(h, "index.html")).text()).toBe("<p>Current</p>");
  });

});

describe("lifetime and deletion", () => {
  it("ad_hoc tendrils expire after 24 h with no check-in and no device; storage and R2 wiped", async () => {
    const h = await create();
    await publishFilesJson(h, { "index.html": "<p>x</p>" });
    await uploadBlobJson(h, new Uint8Array([1]));
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


  it("DELETE wipes everything and closes sockets", async () => {
    const h = await create();
    await publishFilesJson(h, { "index.html": "<p>x</p>" });
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
