// A complete create → publish → event → reply example. Node 20+.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const service = (process.env.TENDRILLER_SERVICE_BASE || "https://tendriller.dev").replace(/\/$/, "");
const owner = process.env.TENDRILLER_OWNER;
const name = process.env.TENDRILLER_PAGE_NAME || "A little hello";
const headers = { "Content-Type": "application/json" };

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status} ${body?.error?.message || JSON.stringify(body) || response.statusText}`);
  return body;
}

if (!owner) throw new Error("Set TENDRILLER_OWNER to the person’s verified GitHub or Google email address.");
const created = await request(`${service}/api/tendrils`, {
  method: "POST", headers,
  body: JSON.stringify({ name, owner }),
});
const api = created.api;
const auth = { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json" };
const index = await readFile(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
await request(`${api}/files`, { method: "POST", headers: auth, body: JSON.stringify({ files: { "index.html": index }, message: "First hello page" }) });
console.log(`Page ready: ${created.page_url}`);
console.log("Share that URL with the owner. Keep the agent token private.");
console.log("Waiting for the first hello or message. Press Ctrl+C to stop.");

let cursor = 0;
for (;;) {
  try {
    const batch = await request(`${api}/events?after=${cursor}&wait=25`, { headers: { Authorization: auth.Authorization } });
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
  } catch (error) {
    console.error(error);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
