import type { RuntimeApi, SendResult, SessionBrief, DurableTimer, PortableBundle, DeviceConfigMessage, PublicationManifest, RuntimeConfiguration } from "../index.mjs";
import { createClient } from "../client.mjs";

declare const page: RuntimeApi<{ count: number }>;
const count: number = page.state.get().count;
const snapshotCount: number = (await page.state.snapshot()).state.count;
void snapshotCount;
void page.state.apply([{op:"set",path:["count"],value:count+1}],{conditions:[{path:["count"],equals:count}]});
// @ts-expect-error one condition cannot mean both equality and existence.
void page.state.apply([],{conditions:[{path:["count"],equals:0,exists:true}]});
const stateResult = await page.state.apply([]);
if (stateResult.status === "queued" || stateResult.status === "accepted") { const cid:string = stateResult.cid; void cid; }
// @ts-expect-error unchanged work has no durable command identity.
if (stateResult.status === "unchanged") stateResult.cid;
for (const work of page.state.pending()) { const path:string[] = work.ops[0].path; void path; }
page.on("state_result", receipt => { const cid:string = receipt.cid; const path:string[] = receipt.ops[0].path; void [cid,path]; });
page.on("state_queue", commands => { const cid:string|undefined = commands[0]?.cid; void cid; });
const result: SendResult = await page.send({ count });
if (result.status === "accepted") { const seq: number = result.seq; void seq; }
if (result.status === "rejected") { const code: string = result.error; void code; }
// @ts-expect-error queued events do not yet have a server sequence.
if (result.status === "queued") result.seq;
// @ts-expect-error require an explicit resume cursor.
createClient({ api: "https://example.test/api/t/id", token: "tk_private" }).readEvents({});
const session: SessionBrief = { purpose: "Experiment", current_task: "Measure", completed: [], decisions: [], open_questions: [], last_handled_seq: 1 };
const timer: DurableTimer = { id: "timer", revision: 1, title: "Check", due_at: 1, timezone: "Europe/Berlin", missed: "fire_once", notify: true, state: "scheduled", created_at: 1, updated_at: 1 };
const bundle: PortableBundle = { format: "tendriller-bundle", version: 3, entry: "app.html", name: "Copy", files: [], media: [{ id: "b_media", type: "image/png", name: null, base64: "AA==" }] };
const guestConfig: DeviceConfigMessage = { devices: [{ id: "d_camera", purpose: "camera" }], focus: null };
page.on("upload_event", result => { if (result.status === "accepted") { const id: string = result.blob.id; void id; } });
page.on("say", message => { const audioOnly: boolean = message.present === false; void audioOnly; });
void [session, timer, bundle, guestConfig];

declare const publication: PublicationManifest;
const runtimeBase = { id: "page", base: "/page/", version: 1, ws: "/page/_tendril/ws", features: { push: false, vapid: null, shared_by: "Fixture", speech: null } };
const nestedRuntime: RuntimeConfiguration = { ...runtimeBase, publication, documentPath: "docs/review.html" };
const holdingRuntime: RuntimeConfiguration = { ...runtimeBase, documentPath: null };
// @ts-expect-error publication identity cannot supply the current document implicitly.
const missingDocument: RuntimeConfiguration = { ...runtimeBase, publication };
// @ts-expect-error authored documents require a publication.
const missingPublication: RuntimeConfiguration = { ...runtimeBase, documentPath: "docs/review.html" };
// @ts-expect-error published documents cannot have a null path.
const nullDocument: RuntimeConfiguration = { ...runtimeBase, publication, documentPath: null };
void [nestedRuntime, holdingRuntime, missingDocument, missingPublication, nullDocument];
