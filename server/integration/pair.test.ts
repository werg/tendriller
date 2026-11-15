import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { assertValid } from "../../contract/index.mjs";
import lock from "../../composition.lock.json";
import { api, apiJson, create, req, PageClient, type Handle } from "../test/helpers";

const command = (data: unknown = {}, expected_generations: Record<string, string> = {}) => ({
  cid: crypto.randomUUID(), expected_generations, data,
});
const workflow = (h: Handle, operation: string, data: unknown = {}, guards: Record<string, string> = {}) =>
  apiJson(h, "POST", `workflows/sessions/${operation}`, command(data, guards));
const pageWorkflow = (url: string, operation: string, body: unknown, anonymous = false) => req(`${url}_tendril/workflows/sessions/${operation}`, {
  method: "POST", anonymous, headers: { "Content-Type": "application/json", Origin: new URL(url).origin }, body: JSON.stringify(body),
});

async function approvedGuest(h: Handle, label: string) {
  const account = crypto.randomUUID(), email = `${label}-${account}@example.test`, raw = crypto.randomUUID(), now = Date.now();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(account, now, email),
    env.ACCOUNTS.prepare("INSERT INTO identities(provider,subject,account_id,login,email,created_at) VALUES('google',?,?,?,?,?)").bind(account, account, label, email, now),
    env.ACCOUNTS.prepare("INSERT INTO identity_emails(provider,subject,email) VALUES('google',?,?)").bind(account, email),
    env.ACCOUNTS.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)').bind(hash, account, now, now + 86400000),
  ]);
  const link = await apiJson(h, 'POST', 'links', { role: 'guest' }, 201);
  const auth = `/auth/page?tendril=${h.id}&key=${new URL(link.url).pathname.split('/')[2]}`;
  const headers = { Cookie: `__Host-tendriller=${raw}` };
  const invite = await req(auth, { headers, anonymous: true, redirect: 'manual' });
  expect(invite.status).toBe(200);
  const nonce = /name="nonce" value="([^"]+)"/.exec(await invite.text())?.[1];
  expect(nonce).toBeTruthy();
  const joined = await req(auth, { method: 'POST', headers: { ...headers, Origin: new URL(h.api).origin }, anonymous: true, body: new URLSearchParams({ nonce: nonce! }) });
  expect(joined.status).toBe(200);
  const approval = await req(`${h.page_url}_tendril/guests/${account}/${link.id}/approve`, { method: 'POST', headers: { Origin: new URL(h.page_url).origin } });
  expect(approval.status).toBe(200);
  const issued = await req(auth, { headers, anonymous: true, redirect: 'manual' });
  expect(issued.status).toBe(303);
  const redemption = await req(issued.headers.get('Location')!, { anonymous: true, redirect: 'manual' });
  expect(redemption.status).toBe(303);
  const cookie = redemption.headers.get('Set-Cookie')!.split(';')[0];
  return { account, call: (operation: string, data: unknown = {}, guards: Record<string, string> = {}) => req(`${link.url}_tendril/workflows/sessions/${operation}`, {
    method: 'POST', anonymous: true, headers: { Cookie: cookie, Origin: new URL(link.url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(command(data, guards)),
  }) };
}

it("advertises the exact composed archive independently from its interface versions", async () => {
  const service = await (await req("/api/service")).json<any>();
  assertValid("serviceDescriptor", service);
  expect(service.contract).toBe(lock.contract);
  expect(service.workflows).toHaveLength(1);
  expect(service.workflows[0]).toMatchObject({ id: "sessions", ...lock.workflow.interfaces.sessions, implementation_version: lock.workflow.sha256 });
  const h = await create();
  expect((await apiJson(h, "GET", "service")).workflows).toEqual(service.workflows);
  expect((await api(h, "POST", "workflows/unselected/activate", command())).status).toBe(404);
  expect((await api(h, "POST", "workflows/sessions/activate", command({ scope: "unknown" }))).status).toBe(400);
});

it("archives and resets through the archived module atomically and retries without repeating the reset", async () => {
  const h = await create();
  const { scope } = await workflow(h, "activate", { scope: "notebook" });
  const guards = { [scope.id]: scope.generation };
  expect((await api(h, "PUT", "state", { cid: crypto.randomUUID(), expected_generations: {}, state: { notebook: {} } })).status).toBe(428);
  await apiJson(h, "PUT", "state", { cid: crypto.randomUUID(), expected_generations: guards, state: { notebook: { entries: [{ text: "Keep this observation" }] }, ordinary: 1 } });
  const snapshot = await workflow(h, "archivePreview", { scope: "notebook" });
  const body = command({ scope: "notebook", title: "First session", expected_state_revision: snapshot.state_revision, expected_interaction_revision: snapshot.interaction_revision }, guards);
  const result = await apiJson(h, "POST", "workflows/sessions/archive", body);
  expect(result.archive.shared_state.notebook.entries).toEqual([{ text: "Keep this observation" }]);
  expect(result.scope.generation).not.toBe(scope.generation);
  expect((await apiJson(h, "GET", "state")).state).toEqual({ notebook: {}, ordinary: 1 });
  const nextGuards = { [scope.id]: result.scope.generation };
  await apiJson(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: nextGuards, ops: [{ op: "set", path: ["notebook", "draft"], value: "Next session" }] });
  expect(await apiJson(h, "POST", "workflows/sessions/archive", body)).toEqual(result);
  expect((await apiJson(h, "GET", "state")).state.notebook.draft).toBe("Next session");
  expect((await api(h, "PATCH", "state", { cid: crypto.randomUUID(), expected_generations: guards, ops: [{ op: "set", path: ["notebook"], value: { stale: true } }] })).status).toBe(409);
  const events = (await apiJson(h, "GET", "events?after=0")).events;
  const archived = events.filter((event: any) => event.context?.workflow === "sessions" && event.context?.operation === "archive");
  expect(archived).toHaveLength(1);
  expect(archived[0].context.generations).toEqual(guards);
  const ordinary = await apiJson(h, "POST", "events", command({ type: "session_archived", session: "application-data" }));
  const plain = (await apiJson(h, "GET", "events?after=0")).events.find((event: any) => event.seq === ordinary.seq);
  expect(plain.context.workflow).toBeUndefined();
  expect((await workflow(h, "archives")).archives).toHaveLength(1);
});

it("keeps owner decisions private and preserves the session when archiving unfinished work fails", async () => {
  const h = await create();
  const { scope } = await workflow(h, "activate", { scope: "decisions" });
  const guards = { [scope.id]: scope.generation };
  const proposal = await workflow(h, "decisionCreate", { title: "Review", summary: "Private proposal", proposal: { secret: "owner-only" } }, guards);
  const response = command({ id: proposal.id, expected_version: proposal.version, decision: "approve" }, guards);
  expect((await api(h, "POST", "workflows/sessions/decisionRespond", response)).status).toBe(403);
  const owner = await PageClient.connect(h.page_url);
  const display = (await owner.request({ t: "links", create: { role: "display" } })).created;
  owner.close();
  expect((await pageWorkflow(display.url, "decisions", command(), true)).status).toBe(403);
  expect((await pageWorkflow(display.url, "activate", command({ scope: "facilitation" }), true)).status).toBe(403);
  const approval = await pageWorkflow(h.page_url, "decisionRespond", response);
  expect(approval.status).toBe(200);
  const approved = await approval.json<any>();
  expect(approved.status).toBe("approved");
  expect(JSON.stringify((await apiJson(h, "GET", "state")).state)).not.toContain("owner-only");
  const snapshot = await workflow(h, "archivePreview", { scope: "decisions" });
  const archive = command({ scope: "decisions", expected_state_revision: snapshot.state_revision, expected_interaction_revision: snapshot.interaction_revision }, guards);
  const denied = await api(h, "POST", "workflows/sessions/archive", archive);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({ error: { code: "work_in_progress" } });
  expect((await apiJson(h, "GET", "scopes")).scopes[0].generation).toBe(scope.generation);
  expect((await workflow(h, "archives")).archives).toEqual([]);
  await workflow(h, "decisionUpdate", { id: approved.id, expected_version: approved.version, status: "completed", result: "Done" }, guards);
  const latest = await workflow(h, "archivePreview", { scope: "decisions" });
  const saved = await workflow(h, "archive", { scope: "decisions", expected_state_revision: latest.state_revision, expected_interaction_revision: latest.interaction_revision }, guards);
  expect(saved.archive.decisions[0].status).toBe("completed");
  expect((await workflow(h, "decisions")).decisions).toEqual([]);
});

it('isolates assignments and private answers between two approved participants in the composed artifact', async () => {
  const h = await create();
  const { scope } = await workflow(h, 'activate', { scope: 'facilitation' });
  const guards = { [scope.id]: scope.generation };
  const alice = await approvedGuest(h, 'alice'), bob = await approvedGuest(h, 'bob');
  const aliceTask = await workflow(h, 'assignmentCreate', { participant: alice.account, title: 'Alice private title', prompt: 'Alice private instructions' }, guards);
  const bobTask = await workflow(h, 'assignmentCreate', { participant: bob.account, title: 'Bob private title', prompt: 'Bob private instructions' }, guards);
  const mine = await (await alice.call('assignments')).json<any>();
  expect(mine.participant).toBe(alice.account);
  expect(mine.assignments.map((item: any) => item.id)).toEqual([aliceTask.id]);
  expect((await (await bob.call('assignments')).json<any>()).assignments.map((item: any) => item.id)).toEqual([bobTask.id]);
  expect((await bob.call('responseSubmit', { prompt_id: aliceTask.prompt_id, answer: 'Unauthorized answer', expected_assignment_revision: aliceTask.revision }, guards)).status).toBe(404);
  const saved = await alice.call('responseSubmit', { prompt_id: aliceTask.prompt_id, answer: 'Alice private answer', expected_assignment_revision: aliceTask.revision }, guards);
  expect(saved.status).toBe(200);
  expect((await (await alice.call('responses')).json<any>()).responses[0].answer).toBe('Alice private answer');
  expect((await (await bob.call('responses')).json<any>()).responses).toEqual([]);
  expect((await bob.call('responsesAll')).status).toBe(403);
  expect((await bob.call('assignmentsAll')).status).toBe(403);
  expect((await workflow(h, 'responsesAll')).responses[0]).toMatchObject({ participant: alice.account, answer: 'Alice private answer' });
  expect((await workflow(h, 'assignmentsAll')).assignments).toHaveLength(2);
  const publicData = JSON.stringify([(await apiJson(h, 'GET', 'state')).state, (await apiJson(h, 'GET', 'events?after=0')).events]);
  for (const privateValue of ['Alice private answer', 'Alice private instructions', 'Bob private instructions', alice.account, bob.account]) expect(publicData).not.toContain(privateValue);
  const preview = await workflow(h, 'archivePreview', { scope: 'facilitation' });
  const archived = await workflow(h, 'archive', { scope: 'facilitation', expected_state_revision: preview.state_revision, expected_interaction_revision: preview.interaction_revision }, guards);
  expect(archived.archive.responses[0].answer).toBe('Alice private answer');
  expect(archived.archive.assignments).toHaveLength(2);
  expect((await alice.call('archiveGet', { id: archived.archive.id })).status).toBe(403);
  expect((await (await alice.call('assignments')).json<any>()).assignments).toEqual([]);
  expect((await bob.call('responseSubmit', { prompt_id: bobTask.prompt_id, answer: 'Old task', expected_assignment_revision: bobTask.revision }, guards)).status).toBe(409);
});
