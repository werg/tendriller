import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "tendril-sw-push-"));
const bundle = join(tmp, "handler.mjs");
let registerPushHandlers;
try {
  await build({ entryPoints: [join(root, "runtime/src/sw-push.ts")], outfile: bundle,
    bundle: true, platform: "neutral", format: "esm", logLevel: "silent" });
  ({ registerPushHandlers } = await import(pathToFileURL(bundle).href));
}
finally { rmSync(tmp, { recursive: true, force: true }); }

function fakeWorker() {
  const handlers = new Map(), notifications = [], opened = [];
  const sw = {
    registration: {
      scope: "https://page.example/t/abc/",
      showNotification: async (title, options) => { notifications.push({ title, options }); },
    },
    location: { origin: "https://page.example" },
    clients: {
      matchAll: async () => [], // All tabs are closed.
      openWindow: async url => { opened.push(url); },
    },
    addEventListener: (kind, handler) => handlers.set(kind, handler),
  };
  registerPushHandlers(sw);
  async function dispatch(kind, event) {
    let completion;
    handlers.get(kind)({ ...event, waitUntil: promise => { completion = promise; } });
    assert.ok(completion, kind + " must extend the service worker lifetime");
    await completion;
  }
  return { dispatch, notifications, opened };
}

test("service worker shows a remote push and opens its page with no client tabs running", async () => {
  const worker = fakeWorker();
  const url = "https://page.example/t/abc/_publications/123/index.html";
  await worker.dispatch("push", { data: { json: () => ({ title: "Job complete", body: "Ready to review",
    url, tag: "job-42", tendril: "abc" }) } });
  assert.equal(worker.notifications.length, 1);
  const { title, options } = worker.notifications[0];
  assert.equal(title, "Job complete");
  assert.equal(options.body, "Ready to review");
  assert.equal(options.tag, "job-42");
  assert.equal(options.data.url, url);
  let closed = false;
  await worker.dispatch("notificationclick", { notification: { data: options.data, close: () => { closed = true; } } });
  assert.equal(closed, true);
  assert.deepEqual(worker.opened, [url]);
});

test("service worker never opens foreign or out-of-scope notification URLs", async () => {
  for (const url of ["https://evil.example/steal", "https://page.example/outside", "//evil.example/path"]) {
    const worker = fakeWorker();
    await worker.dispatch("push", { data: { json: () => ({ title: "A", url }) } });
    assert.equal(worker.notifications[0].options.data.url, "https://page.example/t/abc/");
    await worker.dispatch("notificationclick", { notification: { data: { url }, close() {} } });
    assert.deepEqual(worker.opened, ["https://page.example/t/abc/"]);
  }
});
