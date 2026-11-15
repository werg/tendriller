import { beforeAll, expect, inject, it } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { sha256Hex } from "../src/ids";
import { checkEventSession, checkStateSessions } from "../src/archives";
import { api, apiJson, inDO, req, PageClient, type Handle } from "./helpers";
import { validate } from "../../contract/index.mjs";
import { createClient } from "../../contract/client.mjs";

beforeAll(async () => { await applyD1Migrations(env.ACCOUNTS, inject("d1Migrations")); await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); });
let counter = 0;
async function setup() {
  const owner = crypto.randomUUID(), email = `${owner}@example.test`, raw = crypto.randomUUID();
  const response = await req("/api/tendrils", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.101.${++counter}` }, body: JSON.stringify({ owner: email }) });
  expect(response.status).toBe(201); const h = await response.json<Handle>();
  await env.ACCOUNTS.prepare("INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)").bind(owner, email, Date.now() - 30 * 86400000).run();
  await env.ACCOUNTS.prepare("UPDATE tendrils SET owner_account=?,claimed_at=? WHERE id=?").bind(owner, Date.now(), h.id).run();
  const hash = await sha256Hex(raw);
  await inDO(h.id, t => { t.db.set("owner_account", owner); t.db.set("claimed_at", t.now()); t.db.run("INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,'owner',?)", hash, owner, t.now() + 86400000); });
  const page = (path: string, method = "GET", body?: unknown, url = h.page_url, cookie = raw) => req(`${url}_tendril/${path}`, {
    method, headers: { Cookie: `__Host-tendril=${cookie}`, Origin: new URL(url).origin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const guest = async () => {
    const id = crypto.randomUUID(), cookie = crypto.randomUUID(), link = await apiJson(h, "POST", "links", { role: "guest" }), hash = await sha256Hex(cookie);
    await env.ACCOUNTS.prepare("INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)").bind(id, `${id}@example.test`, Date.now() - 30 * 86400000).run();
    await inDO(h.id, t => { t.db.run("INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)", id, link.id, t.now());
      t.db.run("INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,'guest',?)", hash, id, t.now() + 86400000); });
    return { id, cookie, link, call: (path: string, method = "GET", body?: unknown) => page(path, method, body, link.url, cookie) };
  };
  return { h, owner, page, guest, cookie: raw };
}

it("isolates individual tasks, answers and feedback from peers, display, shared state and event history", async () => {
  const { h, page, guest } = await setup(), first = await guest(), second = await guest();
  const task = await apiJson(h, "POST", "assignments", { participant: first.id, title: "Researcher", prompt: "Find the secret blue clue" }, 201);
  expect(validate("assignment", task)).toEqual([]);
  expect((await (await first.call("assignments")).json<any>()).assignments).toHaveLength(1);
  expect((await (await second.call("assignments")).json<any>()).assignments).toEqual([]);
  expect((await second.call("responses", "POST", { prompt_id: task.prompt_id, answer: "Spoofed", expected_assignment_revision: task.revision })).status).toBe(404);
  expect((await first.call("assignments/all")).status).toBe(403);
  expect((await first.call("assignments/participants")).status).toBe(403);
  expect((await first.call(`assignments/${task.id}`, "PATCH", { expected_revision: 1, feedback: "Spoofed" })).status).toBe(403);
  const answer = { prompt_id: task.prompt_id, answer: "The secret answer is six", expected_assignment_revision: task.revision };
  expect((await first.call("responses", "POST", answer)).status).toBe(201);
  expect((await first.call("responses", "POST", answer)).status).toBe(201);
  expect((await apiJson(h, "GET", "responses")).responses).toHaveLength(1);
  const updated = await (await page(`assignments/${task.id}`, "PATCH", { expected_revision: task.revision, feedback: "Your secret feedback" })).json<any>();
  expect(updated.feedback).toBe("Your secret feedback");
  expect((await first.call("responses", "POST", { ...answer, answer: "An edit", expected_revision: 1 })).status).toBe(409);
  const closed = await apiJson(h, "PATCH", `assignments/${task.id}`, { expected_revision: updated.revision, status: "closed" });
  expect((await first.call("responses", "POST", { ...answer, expected_assignment_revision: closed.revision })).status).toBe(409);
  const display = await inDO(h.id, async t => t.renderLink(await t.createLink("display", "Room", null, false)));
  expect((await page("assignments", "GET", undefined, display.url)).status).toBe(403);
  const publicData = JSON.stringify([await apiJson(h, "GET", "state"), await apiJson(h, "GET", "events?after=0"), await apiJson(h, "GET", "activity")]);
  for (const privateText of ["secret blue", "secret answer", "secret feedback", first.id]) expect(publicData).not.toContain(privateText);
  expect((await api(h, "POST", "assignments", { participant: "unknown", title: "x", prompt: "x" })).status).toBe(400);
});

it("archives privately and atomically, fences concurrent answers, and retries the same request without resetting newer work", async () => {
  const { h, page, guest } = await setup(), participant = await guest();
  await apiJson(h, "PUT", "state", { facilitation: { prompt: { id: "q1", text: "Shared question" }, summary: "Shared result" }, unrelated: { keep: true } });
  const task = await apiJson(h, "POST", "assignments", { participant: participant.id, title: "Task", prompt: "Private task" }, 201);
  const preview = await apiJson(h, "GET", "archives/preview?scope=facilitation");
  await participant.call("responses", "POST", { prompt_id: task.prompt_id, answer: "Private answer", expected_assignment_revision: task.revision });
  const stale = { scope: "facilitation", title: "Round one", expected_state_revision: preview.state_revision, expected_interaction_revision: preview.interaction_revision, request_id: crypto.randomUUID() };
  expect((await page("archives", "POST", stale)).status).toBe(409);
  expect((await apiJson(h, "GET", "responses")).responses).toHaveLength(1);
  const current = await apiJson(h, "GET", "archives/preview?scope=facilitation");
  const body = { ...stale, expected_interaction_revision: current.interaction_revision };
  const result = await (await page("archives", "POST", body)).json<any>();
  expect(result.archive.responses[0].answer).toBe("Private answer"); expect(result.archive.assignments[0].prompt).toBe("Private task");
  expect((await apiJson(h, "GET", "responses")).responses).toEqual([]); expect((await apiJson(h, "GET", "assignments")).assignments).toEqual([]);
  const state = (await apiJson(h, "GET", "state")).state;
  expect(state.unrelated).toEqual({ keep: true }); expect(state.facilitation.prompt.id).not.toBe("q1"); expect(state.facilitation.session_id).toBe(result.archive.id);
  expect((await participant.call("archives")).status).toBe(403); expect((await participant.call(`archives/${result.archive.id}`)).status).toBe(403);
  const download = await page(`archives/${result.archive.id}`); expect(download.headers.get("Cache-Control")).toBe("no-store");
  expect((await download.json<any>()).responses[0].answer).toBe("Private answer");
  expect((await participant.call("responses", "POST", { prompt_id: "q1", answer: "Old queued answer" })).status).toBe(409);
  await participant.call("responses", "POST", { prompt_id: state.facilitation.prompt.id, answer: "Next session answer", expected_session_id: state.facilitation.session_id });
  expect((await page("archives", "POST", body)).status).toBe(201);
  expect((await apiJson(h, "GET", "responses")).responses).toHaveLength(1);
  expect((await page("archives", "POST", { ...body, title: "Different request" })).status).toBe(409);
});

it("retains capture references, rejects stale state and input after rollover, and leaves guide instructions intact", async () => {
  const { h } = await setup();
  const blob = await (await api(h, "PUT", "blobs", "photo bytes", { "Content-Type": "text/plain" })).json<any>();
  await apiJson(h, "PUT", "state", { notebook: { entries: { one: { photo: { id: blob.id }, text: "Saved observation" } } }, guide: { steps: [{ id: "one", text: "Start here" }] }, guide_progress: { completed: { one: 1 } } });
  const archive = async (scope: string) => {
    const p = await apiJson(h, "GET", `archives/preview?scope=${scope}`);
    return apiJson(h, "POST", "archives", { scope, expected_state_revision: p.state_revision, expected_interaction_revision: p.interaction_revision, request_id: crypto.randomUUID() }, 201);
  };
  const result = await archive("notebook");
  expect(await inDO(h.id, t => t.db.one("SELECT pinned FROM blobs WHERE id=?", blob.id)?.pinned)).toBe(1);
  await inDO(h.id, t => {
    expect(() => checkEventSession(t, { session: { scope: "notebook", id: "initial" } })).toThrow(/archived session/);
    expect(() => checkStateSessions(t, [{ op: "set", path: ["notebook", "entries", "stale"], value: {} }], { notebook: "initial" })).toThrow(/archived session/);
    expect(() => checkStateSessions(t, [{ op: "set", path: ["notebook", "entries", "fresh"], value: {} }], { notebook: result.archive.id })).not.toThrow();
    expect(() => checkStateSessions(t, [{ op: "set", path: ["notebook"], value: {} }], { notebook: result.archive.id })).toThrow(/archive action/);
  });
  const guide = await archive("guide"); expect(guide.archive.shared_state.guide_progress.completed).toEqual({ one: 1 });
  await inDO(h.id, t => {
    expect(() => checkEventSession(t, { type: "checkpoint", guide_id: "guide", step_id: "one" })).toThrow(/session ID/);
    expect(() => checkEventSession(t, { type: "input", context: { guide_id: "guide" } })).toThrow(/session ID/);
    expect(() => checkEventSession(t, { type: "input", block: "guide-evidence" })).toThrow(/session ID/);
  });
  const state = (await apiJson(h, "GET", "state")).state;
  expect(state.guide.steps[0].text).toBe("Start here"); expect(state.guide_progress.completed).toBeUndefined();
});

it("keeps current work when archive capacity is reached and permits explicit download/removal", async () => {
  const { h, page } = await setup();
  await inDO(h.id, t => { for (let i = 0; i < 20; i++) t.db.run("INSERT INTO session_archives(id,scope,title,created_at,bytes,request,data) VALUES(?,?,?,?,?,?,?)", `old-${i}`, "notebook", "Old session", i, 1, "{}", "{}"); });
  await apiJson(h, "PUT", "state", { notebook: { entries: { one: { text: "Keep this" } } } });
  const preview = await apiJson(h, "GET", "archives/preview?scope=notebook");
  const body = { scope: "notebook", expected_state_revision: preview.state_revision, expected_interaction_revision: preview.interaction_revision, request_id: crypto.randomUUID() };
  expect((await page("archives", "POST", body)).status).toBe(429);
  expect((await apiJson(h, "GET", "state")).state.notebook.entries.one.text).toBe("Keep this");
  expect((await page("archives/old-0", "DELETE")).status).toBe(204);
  expect((await page("archives", "POST", body)).status).toBe(201);
});

it("rejects old queued inputs and state on the actual page WebSocket after archive", async () => {
  const { h, cookie } = await setup();
  const device = await PageClient.connect(h.page_url, { headers: { Cookie: `__Host-tendril=${cookie}`, Origin: new URL(h.page_url).origin } });
  try {
    await apiJson(h, "PUT", "state", { notebook: { entries: { first: { text: "Keep in archive" } } } });
    const preview = await apiJson(h, "GET", "archives/preview?scope=notebook");
    const archived = await apiJson(h, "POST", "archives", { scope: "notebook", expected_state_revision: preview.state_revision, expected_interaction_revision: preview.interaction_revision, request_id: crypto.randomUUID() });
    device.send({ t: "send", cid: "old-input", data: { type: "notebook.observation", observation_id: "old", session: { scope: "notebook", id: "initial" } } });
    expect(await device.next(message => message.cid === "old-input")).toMatchObject({ error: "stale_session" });
    device.send({ t: "state", cid: "old-edit", sessions: { notebook: "initial" }, ops: [{ op: "set", path: ["notebook", "entries", "old"], value: { text: "Old offline edit" } }] });
    expect(await device.next(message => message.cid === "old-edit")).toMatchObject({ error: "stale_session" });
    expect((await apiJson(h, "GET", "state")).state.notebook.entries).toBeUndefined();
    device.send({ t: "state", cid: "current-edit", sessions: { notebook: archived.archive.id }, ops: [{ op: "set", path: ["notebook", "entries", "new"], value: { text: "New session edit" } }] });
    expect(await device.next(message => message.cid === "current-edit")).toHaveProperty("rev");
    expect((await apiJson(h, "GET", "state")).state.notebook.entries.new.text).toBe("New session edit");
    expect(JSON.stringify((await apiJson(h, "GET", "events?after=0")).events)).not.toContain('"observation_id":"old"');
  } finally { device.close(); }
});

it("the generated public client validates real Worker response envelopes across the complete experience APIs", async () => {
  const { h, owner } = await setup();
  const client = createClient(h, { fetch: ((url: string | URL | Request, init?: RequestInit) => req(String(url), init)) as typeof fetch });
  expect((await client.info()).id).toBe(h.id);
  expect((await client.state()).rev).toBe(0);
  await client.updateState({ notebook: { entries: { first: { text: "A real response fixture" } } } });
  expect((await client.devices()).devices).toEqual([]);
  const timer = await client.createTimer({ title: "Later", due_at: Date.now() + 60000 });
  await client.updateTimer(timer.id, { title: "Later still" });
  expect((await client.timers()).timers[0].title).toBe("Later still");
  expect((await client.timerHistory()).runs).toEqual([]);
  await client.updateSession({ purpose: "Conformance", expected_revision: 0 });
  expect((await client.session()).session.purpose).toBe("Conformance");
  const assignment = await client.createAssignment({ participant: owner, title: "A private task", prompt: "Read the sample" });
  await client.updateAssignment(assignment.id, { expected_revision: 1, feedback: "Thank you" });
  expect((await client.assignments()).assignments[0].feedback).toBe("Thank you");
  expect((await client.participants()).participants[0].id).toBe(owner);
  expect((await client.responses()).responses).toEqual([]);
  const decision = await client.createDecision({ title: "Reviewed scope", summary: "A concrete proposal" });
  expect((await api(h, "POST", "decisions", { title: "Typo", summary: "A concrete proposal", typo: true })).status).toBe(400);
  expect((await api(h, "PATCH", `decisions/${decision.id}`, { expected_version: 1, summary: "Typo", typo: true })).status).toBe(400);
  await client.updateDecision(decision.id, { expected_version: 1, summary: "A revised concrete proposal" });
  expect((await client.decisions()).decisions[0].version).toBe(2);
  const preview = await client.previewArchive("decisions");
  const result = await client.createArchive({ scope: "decisions", expected_state_revision: preview.state_revision, expected_interaction_revision: preview.interaction_revision, request_id: crypto.randomUUID() });
  expect((await client.archive(result.archive.id)).decisions).toHaveLength(1);
  expect((await client.archives()).archives).toHaveLength(1);
  expect((await client.readEvents({ after: 0 })).events.length).toBeGreaterThan(0);
  const lease = await client.claimConsumer("conformance", { holder: "worker-check", after: 0 });
  expect((await client.consumers()).consumers[0].name).toBe("conformance");
  const batch = await client.readConsumer("conformance", lease.lease_token);
  expect(batch.events.length).toBeGreaterThan(0);
  await client.renewConsumer("conformance", lease.lease_token, { ttl_seconds: 120 });
  expect((await client.ackConsumer("conformance", lease.lease_token, { through: batch.cursor })).consumer.handled_seq).toBe(batch.cursor);
  expect((await client.releaseConsumer("conformance", lease.lease_token)).consumer.lease).toBeNull();
  expect((await client.say({ text: "A real reply" })).message_id).toBeTruthy();
  const listener = await api(h, "GET", "events/socket", undefined, { Upgrade: "websocket", "Sec-WebSocket-Protocol": `tendriller.agent.v1, ${h.token}` });
  expect(listener.status).toBe(101); listener.webSocket!.accept();
  try {
    const published = await client.writeFiles({ files: { "index.html": "<h1>Conformance</h1>" } });
    const bundle = await client.exportBundle({ includeData: true }); expect(bundle.session?.purpose).toBe("Conformance");
    const staged = await client.stageBundle(bundle); expect(staged.expected_version).toBe(published.version);
    await client.publishBundle({ expected_version: staged.expected_version });
  } finally { listener.webSocket!.close(); }
});
