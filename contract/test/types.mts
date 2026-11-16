import type { RuntimeApi, SendResult, SessionBrief, DurableTimer, PortableBundle, DeviceConfigMessage } from "../index.mjs";
import { createClient } from "../client.mjs";

declare const page: RuntimeApi<{ count: number }>;
const count: number = page.state.get().count;
const result: SendResult = await page.send({ count });
if (result.status === "accepted") { const seq: number = result.seq; void seq; }
if (result.status === "rejected") { const code: string = result.error; void code; }
// @ts-expect-error queued events do not yet have a server sequence.
if (result.status === "queued") result.seq;
// @ts-expect-error require an explicit resume cursor.
createClient({ api: "https://example.test/api/t/id", token: "tk_private" }).readEvents({});
const session: SessionBrief = { purpose: "Experiment", current_task: "Measure", completed: [], decisions: [], open_questions: [], last_handled_seq: 1 };
const timer: DurableTimer = { id: "timer", title: "Check", due_at: 1, timezone: "Europe/Berlin", missed: "fire_once", notify: true, state: "scheduled", created_at: 1, updated_at: 1 };
const bundle: PortableBundle = { format: "tendriller-bundle", version: 3, entry: "app.html", name: "Copy", files: [], media: [{ id: "b_media", type: "image/png", name: null, base64: "AA==" }] };
const guestConfig: DeviceConfigMessage = { devices: [{ id: "d_camera", purpose: "camera" }], focus: null };
page.on("upload_event", result => { if (result.status === "accepted") { const id: string = result.blob.id; void id; } });
page.on("say", message => { const audioOnly: boolean = message.present === false; void audioOnly; });
void [session, timer, bundle, guestConfig];
