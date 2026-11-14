// A complete create → publish → event → reply example. Node 20+.
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

const service = (process.env.TENDRILLER_SERVICE_BASE || "https://tendriller.dev").replace(/\/$/, "");
const owner = process.env.TENDRILLER_OWNER;
const name = process.env.TENDRILLER_PAGE_NAME || "A little hello";
const headers = { "Content-Type": "application/json" };
const handleFile = process.env.TENDRILLER_HANDLE_FILE || join(homedir(), ".tendriller-example.json");

async function saveHandle(value) {
  const temp = `${handleFile}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(temp, handleFile);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status} ${body?.error?.message || JSON.stringify(body) || response.statusText}`);
  return body;
}

if (!owner) throw new Error("Set TENDRILLER_OWNER to the person’s verified GitHub or Google email address.");
let saved = null;
try { saved = JSON.parse(await readFile(handleFile, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (saved && (saved.owner !== owner || saved.service !== service)) {
  throw new Error(`The saved page in ${handleFile} belongs to a different owner or service. Set TENDRILLER_HANDLE_FILE for a separate page.`);
}
const fresh = !saved;
const created = saved?.handle ?? await request(`${service}/api/tendrils`, {
  method: "POST", headers, body: JSON.stringify({ name, owner }),
});
if (fresh) { saved = { owner, service, handle: created, cursor: 0, published: false }; await saveHandle(saved); }
const api = created.api;
const auth = { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json" };
let cursor = saved.cursor;
async function listenForever() {
  let next = `${api}/events?after=${cursor}&wait=25`;
  for (;;) {
    try {
      const batch = await request(next, { headers: { Authorization: auth.Authorization } });
      for (const event of batch.events || []) {
        if (event.type === "event" && event.data?.type === "hello") {
          await request(`${api}/say`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Hello back! Your page and agent are talking." }) });
          console.log("Replied to a page hello.");
        } else if (event.type === "instruction") {
          console.log("Owner instruction:", event.data?.text);
          await request(`${api}/say`, { method: "POST", headers: auth, body: JSON.stringify({ text: "I heard you. This starter can now be adapted to your task." }) });
        }
      }
      cursor = batch.cursor;
      saved.cursor = cursor;
      await saveHandle(saved);
      next = batch.next_poll;
    } catch (error) {
      console.error(error);
      await new Promise(resolve => setTimeout(resolve, 3000));
      next = `${api}/events?after=${cursor}&wait=25`;
    }
  }
}

// Start the poller before advertising the page. A one-off GET would consume an event
// but leave nobody waiting for the next one.
const listener = listenForever();
let live = false;
for (let attempt = 0; attempt < 50; attempt++) {
  const info = await request(api, { headers: { Authorization: auth.Authorization } });
  if (info.agent_delivery?.mode === "live_poll") { live = true; break; }
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!live) throw new Error("The event listener did not become active. Do not share this page as live.");
if (!saved.published) {
  const index = await readFile(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
  await request(`${api}/files`, { method: "POST", headers: auth, body: JSON.stringify({ files: { "index.html": index }, message: "First hello page" }) });
  saved.published = true;
  await saveHandle(saved);
}
console.log(`Page ready with a live listener: ${created.page_url}`);
console.log("Share that URL with the owner. Keep the agent token private.");
console.log("Keep this process running to answer page events. Press Ctrl+C to stop.");
await listener;
