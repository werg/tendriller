import { test, expect, type Page } from "@playwright/test";
import { savedForOffline } from "./publication";
import { MockServer, type MockTendril } from "./mock-server";

let mock: MockServer;
test.beforeAll(async () => { mock = new MockServer(); await mock.start(); });
test.afterAll(async () => { await mock.stop(); });

async function open(page: Page, t: MockTendril) {
  await page.goto(mock.url(t));
  await page.waitForFunction(() => (window as any).tendril && (window as any).tendril.connected);
}

test("stream runtime replays durable history, restores subscriptions, and never queues offline live samples", async ({ page }) => {
  const makeRecord = (seq: number, stream = "training.loss") => ({ stream, seq, ts: seq, received_at: seq,
    id: `run:${seq}`, type: "metric", data: { loss: 1 / seq }, producer: "producer:trainer" });
  const history = [makeRecord(1), makeRecord(2)];
  const t = mock.create({ onMessage(message, socket) {
    if (message.t === "stream_subscribe") {
      const durable = message.stream === "training.loss";
      const cursor = durable ? history.at(-1)!.seq : 0;
      const records = durable ? history.filter(record => record.seq > message.after) : [];
      socket.send(JSON.stringify({ t: "ack", cid: message.cid, stream: message.stream,
        durability: durable ? "durable" : "ephemeral", cursor,
        ...(durable && message.after !== undefined ? { batch: { stream: message.stream, durability: "durable", records,
          cursor: records.at(-1)?.seq ?? message.after, history: { earliest_available_seq: 1, latest_seq: cursor, gap: false, missing_through: null } } } : {}) }));
      return true;
    }
    if (message.t === "stream_unsubscribe") {
      socket.send(JSON.stringify({ t: "ack", cid: message.cid, stream: message.stream }));
      return true;
    }
  } });
  await open(page, t);
  await page.evaluate(() => {
    const w = window as any;
    w.streamRecords = []; w.liveRecords = []; w.streamErrors = [];
    w.stopTrainingStream = w.tendril.streams.subscribe("training.loss", (record: any) => w.streamRecords.push(record.seq),
      { after: 0, onError: (error: any) => w.streamErrors.push(error.code) });
    w.stopLiveStream = w.tendril.streams.subscribe("machine.live", (record: any) => w.liveRecords.push(record.seq));
  });
  await expect.poll(() => page.evaluate(() => (window as any).streamRecords)).toEqual([1, 2]);
  await mock.waitFor(() => mock.messages(t, "stream_subscribe").length === 2);
  history.push(makeRecord(3));
  mock.broadcast(t, { t: "stream_record", record: history.at(-1) });
  mock.broadcast(t, { t: "stream_record", record: makeRecord(1, "machine.live") });
  await expect.poll(() => page.evaluate(() => (window as any).streamRecords)).toEqual([1, 2, 3]);
  await expect.poll(() => page.evaluate(() => (window as any).liveRecords)).toEqual([1]);
  mock.goOffline(t);
  await page.waitForFunction(() => !window.tendril.connected);
  const offline = await page.evaluate(async () => {
    try { await window.tendril.streams.publish("machine.live", { records: [{ id: "offline", type: "metric", data: {} }] }); return "accepted"; }
    catch (error) { return (error as any).code; }
  });
  expect(offline).toBe("offline");
  expect(mock.messages(t, "stream_publish")).toHaveLength(0);
  history.push(makeRecord(4), makeRecord(5));
  mock.goOnline(t);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => page.evaluate(() => (window as any).streamRecords)).toEqual([1, 2, 3, 4, 5]);
  const subscriptions = mock.messages(t, "stream_subscribe");
  expect(subscriptions.filter(m => m.stream === "training.loss").at(-1).after).toBe(3);
  expect(subscriptions.filter(m => m.stream === "machine.live").every(m => m.after === undefined)).toBe(true);
  expect(mock.messages(t, "stream_publish")).toHaveLength(0);
  expect(mock.messages(t, "send")).toHaveLength(0);
  await page.evaluate(() => { (window as any).stopTrainingStream(); (window as any).stopLiveStream(); });
  await mock.waitFor(() => mock.messages(t, "stream_unsubscribe").length === 2);
  expect(await page.evaluate(() => (window as any).streamErrors)).toEqual([]);
});

test("headless replies expose routing without speaking or imposing application UI", async ({ page }) => {
  const t = mock.create({ html: '<main><h1>Authored workspace</h1><canvas width="300" height="120"></canvas></main>' });
  const requested: string[] = []; page.on("request", request => requested.push(request.url()));
  await page.addInitScript(() => {
    (window as any).spoken = [];
    speechSynthesis.speak = utterance => { (window as any).spoken.push(utterance.text); };
  });
  await open(page, t);
  await page.evaluate(() => {
    const w = window as any; w.replies = []; w.displayed = [];
    w.tendril.on("reply", (message: any) => w.replies.push(message));
    w.tendril.on("say", (message: any) => w.displayed.push(message));
  });
  mock.broadcast(t, { t: "say", message_id: "visible-id", ts: 1, text: "Read this", speak: true });
  mock.broadcast(t, { t: "say", message_id: "audio-id", ts: 2, text: "Optional audio", present: false, speak: true });
  await expect.poll(() => page.evaluate(() => (window as any).replies.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).spoken)).toEqual([]);
  expect(await page.evaluate(() => (window as any).displayed.map((m: any) => m.message_id))).toEqual(["visible-id"]);
  expect(await page.evaluate(() => window.tendril.conversation.entries().map(entry => entry.message_id))).toEqual(["visible-id"]);
  expect(await page.evaluate(() => ({ tts: typeof (window.tendril as any).tts, control: typeof (window.tendril as any).control, preferences: typeof (window.tendril as any).preferences })))
    .toEqual({ tts: "undefined", control: "undefined", preferences: "undefined" });
  await expect(page.locator("tendril-control")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage page" })).toHaveAttribute("href", mock.url(t) + "_tendril/manage");
  expect(requested.some(url => /voice|speech|tts|resources\.json/.test(url))).toBe(false);
  await page.evaluate(() => window.tendril.conversation.presented("visible-id"));
  await mock.waitFor(() => mock.messages(t, "say_rendered").length === 1);
  expect(mock.messages(t, "say_rendered")[0].message_id).toBe("visible-id");
});

test("a BFCache return restores live sensor reporting without remounting the authored page", async ({ page }) => {
  await page.addInitScript(() => {
    // Keep permission replies immediate so the assertions isolate observer lifecycle.
    navigator.permissions.query = async () => Object.assign(new EventTarget(), { state: "prompt" }) as PermissionStatus;
  });
  const t = mock.create();
  await open(page, t);
  await page.evaluate(() => {
    const w = window as any;
    w.sensorUpdates = []; w.capabilityUpdates = [];
    w.tendril.sensors.on((status: any) => w.sensorUpdates.push(status));
    w.tendril.on("capabilities", (report: any) => w.capabilityUpdates.push(report.capabilities.motion.active));
  });
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.evaluate(() => {
      const w = window as any;
      w.sensorUpdates = []; w.capabilityUpdates = [];
      w.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      w.addEventListener("devicemotion", () => {});
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });
    // Both observers stay detached, including after the second departure.
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => ({ sensors: (window as any).sensorUpdates, capabilities: (window as any).capabilityUpdates })))
      .toEqual({ sensors: [], capabilities: [] });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(() => page.evaluate(() => (window as any).sensorUpdates)).toEqual([{ active: ["motion"], pending: [] }]);
    await expect.poll(() => page.evaluate(() => (window as any).capabilityUpdates)).toEqual([true]);

    // A capability-only signal must reach the newly attached observer exactly once.
    await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event("devicechange")));
    await expect.poll(() => page.evaluate(() => (window as any).capabilityUpdates)).toEqual([true, true]);
    await page.getByRole("button", { name: "Stop Motion", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).sensorUpdates)).toEqual([{ active: ["motion"], pending: [] }, { active: [], pending: [] }]);
    await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (window as any).capabilityUpdates)).toEqual([true, true, false]);
    expect(await page.evaluate(() => window.tendril.sensors.status().active)).toEqual([]);
  }
  expect(t.pageLoads).toBe(1);
});

test("window.tendril exists synchronously; hello and welcome", async ({ page }) => {
  const t = mock.create({
    html: `<script>
      window.__sync = typeof tendril === "object" && typeof tendril.send === "function" && typeof tendril.state.get === "function" && typeof tendril.ready.manual === "function";
      window.__connectedAtStart = tendril.connected;
      tendril.send({ early: 1 });
    </script>`,
  });
  await open(page, t);
  expect(await page.evaluate(() => (window as any).__sync)).toBe(true);
  expect(await page.evaluate(() => (window as any).__connectedAtStart)).toBe(false);
  const hello = mock.messages(t, "hello")[0];
  expect(hello.device_id).toMatch(/^d_[a-z2-7]{16}$/);
  expect(hello.device_secret).toMatch(/^[a-z2-7]{32}$/);
  expect(hello.version).toBe(1);
  expect(hello.rev).toBe(0);
  expect(typeof hello.name).toBe("string");
  expect(typeof hello.caps).toBe("object");
  expect(t.msgs[0].t).toBe("hello");
  // early send queued before the socket opened is delivered after hello
  const early = await mock.waitFor(() => mock.messages(t, "send").find((m) => m.data && m.data.early === 1));
  expect(early.wake).toBe(true);
  const info = await page.evaluate(() => ({ device: { ...(window as any).tendril.device }, version: (window as any).tendril.version, core: typeof (window as any).tendril._core, keys: Object.keys((window as any).tendril) }));
  expect(info.device.id).toBe(hello.device_id);
  expect(info.device.role).toBe("owner");
  expect(info.version).toBe(1);
  expect(info.core).toBe("undefined");
  expect(info.keys).not.toContain("_core");
  // device identity is stable across reloads
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.connected);
  expect(mock.messages(t, "hello")[1].device_id).toBe(hello.device_id);
});

test("double inclusion is ignored", async ({ page }) => {
  const t = mock.create();
  t.html = `<script src="${mock.runtimeUrl(t)}tendril.js"></script>`;
  await open(page, t);
  await page.waitForTimeout(300);
  expect(mock.messages(t, "hello").length).toBe(1);
});

test("pending work stays counted until acknowledgement and keeps authoritative generations after offline reload", async ({ page }) => {
  const t = mock.create({ state: { notebook: { session_id: "application-value", entries: {} } }, scopes: [{ id: "scope-a", generation: "old-generation", paths: [["notebook"]], operations: [] }] });
  await open(page, t);
  mock.goOffline(t);
  await page.waitForFunction(() => !window.tendril.connected);
  await page.evaluate(() => {
    window.tendril.state.set(["notebook", "entries", "draft"], { id: "draft", note: "An older session observation" });
    void window.tendril.send({ type: "notebook.observation", session: "application-value" }, { scope: "scope-a" });
  });
  await expect.poll(() => page.evaluate(() => window.tendril.pendingWork())).toEqual({ events: 1, state: 1, captures: 0, timers: 0 });
  await page.waitForFunction(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`tendril:v3:${window.__TENDRIL__.id}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
        request.onsuccess = () => resolve(request.result.filter(item => ["state", "send"].includes(item.msg.t)).length === 2);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.tendril.pendingWork())).toEqual({ events: 1, state: 1, captures: 0, timers: 0 });
  // Another device archived the scope while this device was offline. Hold the
  // replays so the test observes metadata and counts before server acknowledgement.
  t.state = { notebook: { session_id: "application-value", entries: {} } }; t.rev++; t.scopes[0].generation = "new-generation";
  const held: any[] = [];
  t.onMessage = (message, socket) => {
    if (!["state", "send"].includes(message.t)) return;
    held.push({ message, socket }); return true;
  };
  mock.goOnline(t);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => window.tendril.connected);
  await expect.poll(() => held.length).toBe(2);
  expect(held.find(item => item.message.t === "state").message.expected_generations["scope-a"]).toBe("old-generation");
  expect(held.find(item => item.message.t === "send").message.data.session).toBe("application-value");
  expect(await page.evaluate(() => window.tendril.pendingWork())).toEqual({ events: 1, state: 1, captures: 0, timers: 0 });
  for (const { message, socket } of held) socket.send(JSON.stringify({ t: "ack", cid: message.cid, error: "stale_generation", message: "The scope generation changed." }));
  mock.broadcast(t, { t: "state_reset", state: t.state, rev: t.rev });
  await expect.poll(() => page.evaluate(() => window.tendril.pendingWork())).toEqual({ events: 0, state: 0, captures: 0, timers: 0 });
  expect(await page.evaluate(() => window.tendril.state.get("notebook.session_id"))).toBe("application-value");
});

test("a lost state acknowledgement cannot restore work from a rotated scope after reconnect", async ({ page }) => {
  const t = mock.create({ state: { notebook: { session_id: "old-session", entries: {} } }, rev: 4, scopes: [{ id: "scope-a", generation: "old-generation", paths: [["notebook"]], operations: [] }] });
  let accepted: any;
  t.onMessage = message => {
    if (message.t !== "state") return;
    // The old write really succeeded. Only its acknowledgement is lost, so the
    // actual service's cid deduplication will replay this success, not reject it.
    t.state.notebook = structuredClone(message.ops[0].value);
    accepted = { message, acknowledgement: { t: "ack", cid: message.cid, rev: ++t.rev } };
    return true;
  };
  await open(page, t);
  await page.evaluate(() => { void window.tendril.state.set("notebook", {
    session_id: "old-session", entries: { previous: { note: "Keep in the archive" } },
  }); });
  await expect.poll(() => !!accepted).toBe(true);
  expect(t.state.notebook.entries.previous.note).toBe("Keep in the archive");
  mock.goOffline(t); await page.waitForFunction(() => !window.tendril.connected);
  // An independent offline edit must remain optimistic even though its saved
  // metadata also mentions the previous notebook generation.
  await page.evaluate(() => window.tendril.state.set("unrelated", { draft: "Still waiting to sync" }));
  await expect.poll(() => page.evaluate(() => window.tendril.pendingWork().state)).toBe(2);
  const queuedStateCount = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`tendril:v3:${window.__TENDRIL__.id}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
        request.onsuccess = () => resolve(request.result.filter(item => item.msg.t === "state").length);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
  await expect.poll(queuedStateCount).toBe(2);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.tendril.pendingWork().state)).toBe(2);
  // Another device archives while this one is away. Hold the replay replies so
  // the newer welcome and the preserved outbox can be examined independently.
  t.state = { notebook: { session_id: "new-session", entries: { fresh: { note: "Current session" } } } }; t.rev++; t.scopes[0].generation = "new-generation";
  const held: { message: any; socket: any }[] = [];
  t.onMessage = (message, socket) => { if (message.t === "state") { held.push({ message, socket }); return true; } };
  mock.goOnline(t); await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => window.tendril.connected);
  await expect.poll(() => held.length).toBe(2);
  const previous = held.find(item => item.message.cid === accepted.message.cid)!;
  const independent = held.find(item => item !== previous)!;
  expect(previous.message).toEqual(accepted.message);
  expect(independent.message.expected_generations).toEqual({});
  const current = { notebook: t.state.notebook, unrelated: { draft: "Still waiting to sync" } };
  expect(await page.evaluate(() => window.tendril.state.get())).toEqual(current);
  expect(await page.evaluate(() => window.tendril.pendingWork().state)).toBe(2);
  expect(await queuedStateCount()).toBe(2);

  previous.socket.send(JSON.stringify(accepted.acknowledgement));
  await expect.poll(() => page.evaluate(() => window.tendril.pendingWork().state)).toBe(1);
  expect(await page.evaluate(() => window.tendril.state.get())).toEqual(current);
  expect(await page.evaluate(() => (window.tendril as any).state.revision)).toBe(t.rev);
  await expect.poll(queuedStateCount).toBe(1);

  t.state.unrelated = structuredClone(independent.message.ops[0].value);
  independent.socket.send(JSON.stringify({ t: "ack", cid: independent.message.cid, rev: ++t.rev }));
  await expect.poll(() => page.evaluate(() => window.tendril.pendingWork().state)).toBe(0);
  expect(await page.evaluate(() => window.tendril.state.get())).toEqual(current);
  expect(await page.evaluate(() => (window.tendril as any).state.revision)).toBe(t.rev);
  await expect.poll(queuedStateCount).toBe(0);
});

test("an acknowledgement behind a newer delta resyncs without losing own writes or overwriting later changes", async ({ page }) => {
  const t = mock.create({ state: { shared: "before" }, rev: 4 });
  let accepted: { acknowledgement: any; socket: any } | undefined;
  t.onMessage = (message, socket) => {
    if (message.t !== "state") return;
    if (accepted) {
      socket.send(JSON.stringify(accepted.acknowledgement)); return true;
    }
    // Match the real server's apply/dedupe/ack ordering: another socket's
    // synchronous mutation may run while the first handler awaits dedupe.
    t.state.mine = "Accepted own write"; t.state.shared = "Own earlier value";
    accepted = { acknowledgement: { t: "ack", cid: message.cid, rev: ++t.rev }, socket };
    return true;
  };
  await open(page, t);
  await page.evaluate(() => { void window.tendril.state.patch({ mine: "Accepted own write", shared: "Own earlier value" }); });
  await expect.poll(() => !!accepted).toBe(true);
  mock.pushState(t, [{ op: "set", path: ["remote"], value: "Later independent write" }, { op: "set", path: ["shared"], value: "Later conflicting write" }]);
  await page.waitForFunction(() => window.tendril.state.get("remote") === "Later independent write");
  expect(await page.evaluate(() => window.tendril.pendingWork().state)).toBe(1);
  accepted!.socket.send(JSON.stringify(accepted!.acknowledgement));

  await expect.poll(() => mock.messages(t, "hello").length).toBe(2);
  await expect.poll(() => page.evaluate(() => window.tendril.connected && window.tendril.pendingWork().state === 0)).toBe(true);
  expect(await page.evaluate(() => window.tendril.state.get())).toEqual({
    mine: "Accepted own write", remote: "Later independent write", shared: "Later conflicting write",
  });
  expect(await page.evaluate(() => (window.tendril as any).state.revision)).toBe(t.rev);
  const sends = mock.messages(t, "state");
  // The ACK was saved before reconnecting. The full welcome lets its original
  // command finish local cleanup without resending the mutation.
  expect(sends).toHaveLength(1);
  // Once the full welcome covers the receipt, it must not trigger another
  // reconnect. A subsequent ordinary write proves the connection remains usable.
  t.onMessage = undefined;
  await page.evaluate(() => window.tendril.state.set("afterResync", true));
  await expect.poll(() => page.evaluate(() => window.tendril.pendingWork().state)).toBe(0);
  expect(await page.evaluate(() => window.tendril.state.get("afterResync"))).toBe(true);
  expect(mock.messages(t, "hello")).toHaveLength(2);
});

test("send returns seq after ack; wake option", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  const r1 = await page.evaluate(() => (window as any).tendril.send({ a: 1 }));
  expect(r1.status).toBe("accepted");
  expect(r1.status).toBe("accepted");
  expect(typeof r1.seq).toBe("number");
  await page.evaluate(() => (window as any).tendril.send("x", { wake: false }));
  const sends = mock.messages(t, "send");
  expect(sends[0].data).toEqual({ a: 1 });
  expect(sends[0].wake).toBe(true);
  expect(sends[0].cid).toBeTruthy();
  expect(sends[1].wake).toBe(false);
});

test("send distinguishes server rejection from accepted or queued input", async ({ page }) => {
  const t = mock.create();
  t.onMessage = (message, socket) => {
    if (message.t !== "send") return;
    socket.send(JSON.stringify({ t: "ack", cid: message.cid, error: "forbidden", message: "This display cannot send input." }));
    return true;
  };
  await open(page, t);
  expect(await page.evaluate(() => (window as any).tendril.send({ answer: "kept draft" })))
    .toEqual({ status: "rejected", error: "forbidden", message: "This display cannot send input." });
  t.onMessage = (message, socket) => {
    if (message.t !== "send") return;
    socket.send(JSON.stringify({ t: "error", cid: message.cid, code: "rate_limited", message: "Wait a moment." }));
    return true;
  };
  expect(await page.evaluate(() => (window as any).tendril.send({ answer: "retryable" })))
    .toMatchObject({ status: "rejected", error: "rate_limited", message: "Wait a moment." });
});

test("a late conversation rejection retains its identified text across reload", async ({ page }) => {
  const t = mock.create();
  let rejectInstruction: (() => void) | undefined;
  t.onMessage = (message, socket) => {
    if (message.t !== "send" || message.kind !== "instruction") return;
    rejectInstruction = () => socket.send(JSON.stringify({ t: "ack", cid: message.cid,
      error: "forbidden", message: "This device is no longer an owner." }));
    return true;
  };
  await open(page, t);
  await page.evaluate(() => {
    const w = window as any;
    w.rejectedInstructions = [];
    w.tendril.on("conversation_result", (receipt: any) => { if (receipt.status === "rejected") w.rejectedInstructions.push(receipt); });
  });
  expect(await page.evaluate(() => (window as any).tendril.conversation.send("Keep this draft", {via: "text"}))).toEqual({ status: "queued", cid: expect.any(String) });
  expect(await page.evaluate(() => (window as any).tendril.conversation.entries())).toHaveLength(1);
  rejectInstruction!();
  await expect.poll(() => page.evaluate(() => (window as any).rejectedInstructions)).toEqual([
    { cid: expect.any(String), status: "rejected", text: "Keep this draft", error: "forbidden", message: "This device is no longer an owner." },
  ]);
  expect(await page.evaluate(() => (window as any).tendril.conversation.entries())).toEqual([expect.objectContaining({ status: "rejected", text: "Keep this draft" })]);
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.connected);
  expect(await page.evaluate(() => (window as any).tendril.conversation.entries())).toEqual([expect.objectContaining({ status: "rejected", text: "Keep this draft" })]);
  expect(mock.messages(t, "send").filter((message) => message.kind === "instruction")).toHaveLength(1);
});

test("a replayed semantic input emits its receipt with the original data after reload", async ({ page }) => {
  const t = mock.create({ html: '<script>window.sendResults=[];tendril.on("send_result",r=>window.sendResults.push(r));</script>' });
  await open(page, t);
  mock.goOffline(t);
  await page.waitForFunction(() => !(window as any).tendril.connected);
  expect(await page.evaluate(() => (window as any).tendril.send({ type: "observation", observation_id: "note-1", note: "Found a new trail" })))
    .toMatchObject({ status: "queued" });
  await page.reload();
  await page.waitForFunction(() => typeof (window as any).tendril === "object");
  mock.goOnline(t);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => page.evaluate(() => (window as any).sendResults)).toEqual([
    { cid: expect.any(String), scope: undefined, expected_generations: {}, data: { type: "observation", observation_id: "note-1", note: "Found a new trail" },
      status: "accepted", seq: expect.any(Number) },
  ]);
});

test("capture and its semantic input survive offline reload as one transaction", async ({ page }) => {
  const t = mock.create({ html: '<script>window.receipts=[];tendril.on("upload_event",r=>window.receipts.push(r));</script>' });
  await open(page, t);
  mock.goOffline(t);
  await page.waitForFunction(() => !(window as any).tendril.connected);
  const queued = await page.evaluate(() => (window as any).tendril.uploadEvent(new Blob(["drawing-bytes"], { type: "image/png" }), {
    name: "drawing.png", data: { type: "ui", block: "sketch", value: { width: 640, height: 320 } }, dataPath: ["value"], keep: true,
  }));
  expect(queued).toMatchObject({ status: "queued", capture_id: expect.any(String) });
  expect(t.blobs.size).toBe(0);
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.captures().length === 1);
  expect(await page.evaluate(() => (window as any).tendril.captures()[0])).toMatchObject({ capture_id: queued.capture_id, name: "drawing.png", status: "queued", data: { type: "ui", block: "sketch" } });
  mock.goOnline(t);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => page.evaluate(() => (window as any).receipts.find((result: any) => result.status === "accepted"))).toMatchObject({
    capture_id: queued.capture_id, status: "accepted", blob: { retention: { reasons: ["pinned"], expires_at: null } },
  });
  const sends = mock.messages(t, "capture_complete");
  expect(sends).toHaveLength(1);
  expect(sends[0].data).toEqual({ type: "ui", block: "sketch", capture_id: queued.capture_id, value: { width: 640, height: 320,
    blob: expect.any(String), url: expect.stringContaining("_tendril/blobs/") } });
  expect(t.blobs.size).toBe(1);
  expect([...t.blobs.values()][0].body.toString()).toBe("drawing-bytes");
  expect(await page.evaluate(() => (window as any).tendril.captures())).toEqual([]);
});

test("reload before receiving the upload completion receipt reuses the blob and accepts its input once", async ({ page }) => {
  const t = mock.create({ holdCompletionResponses: 1 });
  await open(page, t);
  await page.evaluate(() => {
    (window as any).capture = (window as any).tendril.uploadEvent(new Blob(["photo"], { type: "image/jpeg" }), {
      name: "photo.jpg", data: { type: "input", modality: "photo", note: "The loose hinge" },
    });
  });
  await mock.waitFor(() => t.blobs.size === 1);
  expect([...t.uploads.values()][0].session.phase).toBe("completed");
  const pending = await page.evaluate(() => (window as any).tendril.captures()[0]);
  expect(pending).toMatchObject({ capture_id: t.transferRequests[0].body.cid, status: "queued" });
  expect(pending.blob).toBeUndefined();
  expect(mock.messages(t, "capture_complete")).toHaveLength(0);
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.connected);
  await mock.waitFor(() => mock.messages(t, "capture_complete").some((message) => message.data?.note === "The loose hinge"));
  expect(t.blobs.size).toBe(1);
  const sends = mock.messages(t, "capture_complete").filter((message) => message.data?.modality === "photo");
  expect(new Set(sends.map(message => message.cid)).size).toBe(1);
  expect(t.sendReceipts.size).toBe(1);
  expect(t.seq).toBe(1);
  const starts = t.transferRequests.filter(request => request.path === "_tendril/uploads");
  expect(starts).toHaveLength(2);
  expect(starts[1].body).toEqual(starts[0].body);
  expect(t.transferRequests.filter(request => request.path.endsWith("/content"))).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => (window as any).tendril.captures())).toEqual([]);
});

test("reload after a lost pin reply keeps original pin and capture guards while preserving rejected evidence", async ({ page }) => {
  const t = mock.create({ dropPinResponses: 1, scopes: [
    { id: "review", generation: "original", paths: [], operations: ["capture", "blob.pin"] },
  ] });
  t.onMessage = (message, socket) => {
    if (message.t !== "capture_complete") return;
    socket.send(JSON.stringify({ t: "ack", cid: message.cid, error: "stale_generation", message: "The review session changed" }));
    return true;
  };
  await open(page, t);
  await page.evaluate(() => {
    void (window as any).tendril.uploadEvent(new Blob(["reviewed evidence"]), {
      data: { submission_id: "review-1", note: "Original review" }, keep: true, scope: "review",
    });
  });
  await mock.waitFor(() => t.pinReceipts.size === 1);
  const originalPin = t.transferRequests.find(request => request.path.endsWith("/pin"))!.body;
  const originalCapture = await page.evaluate(() => (window as any).tendril.captures()[0]);
  t.scopes[0].generation = "new";
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.captures()[0]?.status === "rejected");
  const replay = await page.evaluate(() => (window as any).tendril.captures()[0]);
  expect(replay).toMatchObject({ capture_id: originalCapture.capture_id, data: originalCapture.data,
    expected_generations: { review: "original" }, error: "stale_generation", blob: { retention: { expires_at: null, reasons: ["pinned"] } } });
  const pins = t.transferRequests.filter(request => request.path.endsWith("/pin"));
  expect(pins).toHaveLength(2);
  expect(pins[1].body).toEqual(originalPin);
  expect(originalPin.expected_generations).toEqual({ review: "original" });
  expect(t.transferRequests.filter(request => request.path === "_tendril/uploads")).toHaveLength(1);
  expect(mock.messages(t, "capture_complete")[0].expected_generations).toEqual({ review: "original" });
});

test("rejected captured input remains retryable after reload without duplicating media", async ({ page }) => {
  const t = mock.create();
  t.onMessage = (message, socket) => {
    if (message.t !== "capture_complete") return;
    socket.send(JSON.stringify({ t: "ack", cid: message.cid, error: "rate_limited", message: "Try again shortly." }));
    return true;
  };
  await open(page, t);
  const rejected = await page.evaluate(() => (window as any).tendril.uploadEvent(new Blob(["audio"]), {
    name: "note.webm", data: { type: "input", modality: "audio" },
  }));
  expect(rejected).toMatchObject({ status: "rejected", error: "rate_limited", message: "Try again shortly." });
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.captures()[0]?.status === "rejected");
  t.onMessage = undefined;
  const accepted = await page.evaluate((id) => (window as any).tendril.retryCapture(id), rejected.capture_id);
  expect(accepted).toMatchObject({ capture_id: rejected.capture_id, status: "accepted", seq: expect.any(Number) });
  expect(t.blobs.size).toBe(1);
  const sends = mock.messages(t, "capture_complete");
  expect(sends).toHaveLength(2);
  expect(sends[0].cid).toBe(sends[1].cid);
  expect(sends[0].expected_generations).toEqual(sends[1].expected_generations);
  expect(sends[0].data.blob).toBe(sends[1].data.blob);
});

test("upload rejection retains the capture until retry or discard", async ({ page }) => {
  const t = mock.create({ uploadFailureStatus: 413 });
  await open(page, t);
  const rejected = await page.evaluate(() => (window as any).tendril.uploadEvent(new Blob(["photo"]), {
    data: { type: "input", modality: "photo" },
  }));
  expect(rejected).toMatchObject({ status: "rejected", error: "quota", message: "Capture storage is full." });
  expect(mock.messages(t, "capture_complete")).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).tendril.captures())).toHaveLength(1);
  await page.evaluate((id) => (window as any).tendril.discardCapture(id), rejected.capture_id);
  expect(await page.evaluate(() => (window as any).tendril.captures())).toEqual([]);
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.connected);
  expect(await page.evaluate(() => (window as any).tendril.captures())).toEqual([]);
});

test("capture does not claim to be saved when browser storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => { indexedDB.open = () => { throw new Error("Storage blocked"); }; });
  const t = mock.create();
  await open(page, t);
  const result = await page.evaluate(() => (window as any).tendril.uploadEvent(new Blob(["photo"]), { data: { modality: "photo" } }));
  expect(result).toMatchObject({ status: "rejected", error: "storage_unavailable" });
  expect(t.blobs.size).toBe(0);
  expect(mock.messages(t, "send")).toHaveLength(0);
});

test("page updates can wait for a draft and their apply callback is idempotent", async ({ page }) => {
  const t = mock.create({ html: '<textarea id="draft"></textarea><script>window.addEventListener("tendril:before-reload",e=>{e.preventDefault();window.pendingUpdate=e.detail});</script>' });
  await open(page, t);
  await page.locator("#draft").fill("An unfinished thought");
  t.version = 2;
  mock.broadcast(t, { t: "reload", version: 2 });
  await page.waitForFunction(() => (window as any).pendingUpdate?.version === 2);
  expect(t.pageLoads).toBe(1);
  await expect(page.locator("#draft")).toHaveValue("An unfinished thought");
  await page.evaluate(() => { (window as any).pendingUpdate.apply(); (window as any).pendingUpdate.apply(); });
  await expect.poll(() => t.pageLoads).toBe(2);
  await page.waitForFunction(() => (window as any).tendril.version === 2);
});

test("role message updates tendril.device live; connected reflects socket", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  mock.broadcast(t, { t: "role", role: "guest", pending: true });
  await page.waitForFunction(() => (window as any).tendril.device.role === "guest" && (window as any).tendril.device.pending === true);
  mock.goOffline(t);
  await page.waitForFunction(() => (window as any).tendril.connected === false);
  mock.goOnline(t);
  await page.waitForFunction(() => (window as any).tendril.connected === true, null, { timeout: 15000 });
});

test("offline queue persists across reload and replays in order", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  await page.evaluate(() => {
    (window as any).__events = [];
    (window as any).tendril.on("disconnect", () => (window as any).__events.push("disconnect"));
  });
  mock.goOffline(t);
  await page.waitForFunction(() => !(window as any).tendril.connected);
  expect(await page.evaluate(() => (window as any).__events)).toEqual(["disconnect"]);
  const r = await page.evaluate(async () => {
    const tl = (window as any).tendril;
    const a = await tl.send({ n: 1 });
    await tl.state.set("list.a", { text: "milk" });
    const b = await tl.send({ n: 2 });
    return [a, b];
  });
  expect(r[0].status).toBe("queued");
  expect(r[1].status).toBe("queued");
  expect(mock.messages(t, "send").length).toBe(0);
  // reload with no socket: queue and local state come back from storage
  await page.reload();
  await page.waitForFunction(() => (window as any).tendril.state.get("list.a.text") === "milk");
  await page.evaluate(() => (window as any).tendril.send({ n: 3 }));
  await page.waitForTimeout(200);
  expect(mock.messages(t, "send").length).toBe(0);
  mock.goOnline(t);
  await mock.waitFor(() => mock.messages(t, "send").length >= 3, 20000);
  const order = t.msgs.filter((m) => m.t === "send" || m.t === "state").map((m) => (m.t === "send" ? m.data.n : "state"));
  expect(order).toEqual([1, "state", 2, 3]);
  expect(t.state).toEqual({ list: { a: { text: "milk" } } });
  // acked items leave the queue: another reconnect does not resend them
  await page.waitForFunction(() => (window as any).tendril.connected);
  await page.waitForTimeout(300);
  mock.goOffline(t);
  mock.goOnline(t);
  await mock.waitFor(() => mock.messages(t, "hello").length >= 3, 20000);
  await page.waitForTimeout(500);
  expect(mock.messages(t, "send").length).toBe(3);
});

test("state: local ops, merge patch, remote ops, reset, listeners", async ({ page }) => {
  const t = mock.create({ state: { _prefs: { audio: false }, count: 1 }, rev: 5 });
  await open(page, t);
  expect(await page.evaluate(() => (window as any).tendril.state.get("count"))).toBe(1);
  await page.evaluate(() => {
    const tl = (window as any).tendril;
    (window as any).__changes = [];
    tl.state.on((s: any, ops: any[], by: string) => (window as any).__changes.push({ ops, by }));
    tl.state.set("list.a1.done", true);
    tl.state.set(["weird.key", "x"], 2);
    tl.state.patch({ obj: { y: 1, z: null }, arr: [1, 2], count: null, gone: null });
    tl.state.patch({ obj: { w: 2, y: null } });
    tl.state.delete("list.a1");
  });
  const ops = await mock.waitFor(() => { const s = mock.messages(t, "state"); return s.length >= 5 && s.map((m) => m.ops); });
  expect(ops[0]).toEqual([{ op: "set", path: ["list", "a1", "done"], value: true }]);
  expect(ops[1]).toEqual([{ op: "set", path: ["weird.key", "x"], value: 2 }]);
  expect(ops[2]).toEqual([
    { op: "set", path: ["obj"], value: { y: 1 } }, // target not an object: one set, nulls stripped
    { op: "set", path: ["arr"], value: [1, 2] },
    { op: "delete", path: ["count"] }, // "gone" absent: no op
  ]);
  expect(ops[3]).toEqual([{ op: "set", path: ["obj", "w"], value: 2 }, { op: "delete", path: ["obj", "y"] }]);
  expect(ops[4]).toEqual([{ op: "delete", path: ["list", "a1"] }]);
  const local = await page.evaluate(() => (window as any).tendril.state.get());
  expect(local).toEqual({ _prefs: { audio: false }, list: {}, "weird.key": { x: 2 }, obj: { w: 2 }, arr: [1, 2] });
  // get() returns a copy
  expect(await page.evaluate(() => { const tl = (window as any).tendril; tl.state.get("obj").w = 99; return tl.state.get("obj.w"); })).toBe(2);
  // remote ops
  mock.pushState(t, [{ op: "set", path: ["remote"], value: { v: 1 } }, { op: "set", path: ["_device", "PLACEHOLDER"], value: 0 }]);
  await page.waitForFunction(() => (window as any).tendril.state.get("remote.v") === 1);
  const last = await page.evaluate(() => (window as any).__changes.at(-1));
  expect(last.by).toBe("agent:main");
  // Application device maps remain ordinary data; access uses an explicit path.
  const id = await page.evaluate(() => (window as any).tendril.device.id);
  mock.pushState(t, [{ op: "set", path: ["_device", id], value: { zoom: 3 } }]);
  await page.waitForFunction(id => (window as any).tendril.state.get(["_device", id, "zoom"]) === 3, id);
  expect(await page.evaluate(() => "mine" in window.tendril.state)).toBe(false);
  // reset
  mock.broadcast(t, { t: "state_reset", state: { fresh: true }, rev: 100 });
  await page.waitForFunction(() => (window as any).tendril.state.get("fresh") === true);
  expect(await page.evaluate(() => (window as any).tendril.state.get("remote"))).toBeUndefined();
  expect(await page.evaluate(() => (window as any).tendril.state.revision)).toBe(100);
});

test("pending local op survives a conflicting remote op (server order wins)", async ({ page }) => {
  const t = mock.create();
  let held: any = null;
  t.onMessage = (m) => { if (m.t === "state") { held = m; return true; } };
  await open(page, t);
  await page.evaluate(() => (window as any).tendril.state.set("k", "mine"));
  await mock.waitFor(() => held);
  mock.pushState(t, [{ op: "set", path: ["k"], value: "theirs" }]);
  await page.waitForTimeout(200);
  // our op is still pending → stays visible on top of the remote one
  expect(await page.evaluate(() => (window as any).tendril.state.get("k"))).toBe("mine");
  t.onMessage = undefined;
  mock.broadcast(t, { t: "ack", cid: held.cid, rev: 2 });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).tendril.state.get("k"))).toBe("mine");
});

test("eval: values, errors, DOM serialization", async ({ page }) => {
  const t = mock.create({ html: `<div id="big">${"x".repeat(5000)}</div><p id="p">hi</p>` });
  await open(page, t);
  expect(await mock.eval(t, "return document.title")).toMatchObject({ ok: true, value: `Test ${t.id} v1` });
  expect(await mock.eval(t, "await new Promise(r => setTimeout(r, 50)); return 1 + 1")).toMatchObject({ ok: true, value: 2 });
  const undef = await mock.eval(t, "return undefined");
  expect(undef.ok).toBe(true);
  expect(undef.value).toBeNull();
  const err = await mock.eval(t, "throw new TypeError('boom')");
  expect(err).toMatchObject({ ok: false, error: "TypeError: boom" });
  const syntax = await mock.eval(t, "return (");
  expect(syntax.ok).toBe(false);
  expect(syntax.error).toMatch(/SyntaxError/);
  expect((await mock.eval(t, "return document.getElementById('p')")).value).toBe('<p id="p">hi</p>');
  const big = (await mock.eval(t, "return document.getElementById('big')")).value;
  expect(big.length).toBe(2000);
  const circ = (await mock.eval(t, "const a = {x: 1, e: new Error('inner'), u: undefined, f(){}}; a.self = a; return a")).value;
  expect(circ).toEqual({ x: 1, e: "Error: inner", u: null, f: expect.stringContaining("f()"), self: "[object Object]" });
  expect((await mock.eval(t, "return [document.querySelectorAll('p'), new Map([['a', 1]]), new Set([1]), 10n, NaN]")).value)
    .toEqual([['<p id="p">hi</p>'], { a: 1 }, [1], "10", "NaN"]);
  expect((await mock.eval(t, "return window")).value).toBe("[object Window]");
});

test("console forwarding and window errors as batched logs", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  const consoleSeen: string[] = [];
  page.on("console", (m) => consoleSeen.push(m.text()));
  await page.evaluate(() => {
    console.log("hello", { a: 1 }, 2);
    console.info("info!");
    console.warn("warn!");
    console.error(new Error("bad thing"));
    console.log("y".repeat(10000));
    setTimeout(() => { throw new Error("async fail"); });
    Promise.reject(new Error("rejected!"));
  });
  const entries = await mock.waitFor(() => {
    const all = mock.messages(t, "log").flatMap((m) => m.entries);
    return all.length >= 7 && all;
  });
  expect(mock.messages(t, "log").length).toBeLessThanOrEqual(2);
  const msg = (s: string) => entries.find((e: any) => e.message.includes(s));
  expect(msg("hello")).toMatchObject({ level: "log", message: 'hello {"a":1} 2' });
  expect(msg("info!").level).toBe("info");
  expect(msg("warn!").level).toBe("warn");
  expect(msg("bad thing").level).toBe("error");
  expect(msg("bad thing").stack).toContain("bad thing");
  expect(msg("yyyy").message.length).toBeLessThanOrEqual(4000);
  expect(msg("async fail").level).toBe("error");
  expect(msg("rejected!").message).toContain("Unhandled rejection");
  expect(typeof entries[0].ts).toBe("number");
  // originals still work
  expect(consoleSeen.some((s) => s.startsWith("hello"))).toBe(true);
});

test("health ok", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h).toMatchObject({ t: "health", version: 1, visible: true, ok: true, errors: [] });
});

test("health waits for a visible page before starting its observation window", async ({ page }) => {
  await page.addInitScript(() => {
    let state = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    (window as any).setTestVisibility = (next: string) => {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  const t = mock.create({ html: `<script>addEventListener("load", () => setTimeout(() => { throw new Error("hidden error") }, 200))</script>` });
  await open(page, t);
  await page.waitForTimeout(2300);
  expect(mock.messages(t, "health")).toHaveLength(0);
  await page.evaluate(() => (window as any).setTestVisibility("visible"));
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h).toMatchObject({ visible: true, ok: false });
  expect(h.errors.join(" ")).toContain("hidden error");
});

test("manual ready while hidden reports only after becoming visible", async ({ page }) => {
  await page.addInitScript(() => {
    let state = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    (window as any).setTestVisibility = (next: string) => {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  const t = mock.create({ html: `<script>tendril.ready.manual(); tendril.ready()</script>` });
  await open(page, t);
  expect(mock.messages(t, "health")).toHaveLength(0);
  await page.evaluate(() => (window as any).setTestVisibility("visible"));
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h).toMatchObject({ visible: true, ok: true });
});

test("an offline health result is not sent after the page becomes hidden", async ({ page }) => {
  await page.addInitScript(() => {
    let state = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    (window as any).setTestVisibility = (next: string) => {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  const t = mock.create();
  await open(page, t);
  mock.goOffline(t);
  await page.waitForFunction(() => !(window as any).tendril.connected);
  await page.waitForTimeout(2300);
  expect(mock.messages(t, "health")).toHaveLength(0);
  await page.evaluate(() => (window as any).setTestVisibility("hidden"));
  mock.goOnline(t);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => (window as any).tendril.connected);
  expect(mock.messages(t, "health")).toHaveLength(0);
  await page.evaluate(() => (window as any).setTestVisibility("visible"));
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h).toMatchObject({ visible: true, ok: true });
});

test("health failure on uncaught error after load", async ({ page }) => {
  const t = mock.create({ version: 7, html: `<script>addEventListener("load", () => setTimeout(() => { throw new Error("broken page") }, 200))</script>` });
  await open(page, t);
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h.ok).toBe(false);
  expect(h.version).toBe(7);
  expect(h.errors.join(" ")).toContain("broken page");
});

test("health failure on error thrown while parsing", async ({ page }) => {
  const t = mock.create({ html: `<script>undefinedFunction()</script>` });
  await open(page, t);
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h.ok).toBe(false);
  expect(h.errors[0]).toContain("undefinedFunction");
});

test("health manual mode waits for ready()", async ({ page }) => {
  const t = mock.create({ html: `<script>tendril.ready.manual(); setTimeout(() => tendril.ready(), 3000)</script>` });
  const start = Date.now();
  await open(page, t);
  const h = await mock.waitFor(() => mock.messages(t, "health")[0]);
  expect(h.ok).toBe(true);
  expect(Date.now() - start).toBeGreaterThan(2800);
});

test("reload on reload message only when the version differs", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  mock.broadcast(t, { t: "reload", version: 1 });
  await page.waitForTimeout(500);
  expect(t.pageLoads).toBe(1);
  t.version = 2;
  mock.broadcast(t, { t: "reload", version: 2 });
  await mock.waitFor(() => t.pageLoads === 2);
  await page.waitForFunction(() => (window as any).tendril && (window as any).tendril.version === 2);
});

test("welcome with a newer current version reloads once", async ({ page }) => {
  const t = mock.create();
  t.welcomeExtra = { version: { current: 5, latest: 5, healthy: 5 } };
  await page.goto(mock.url(t));
  await mock.waitFor(() => t.pageLoads >= 2);
  await page.waitForTimeout(1000);
  expect(t.pageLoads).toBe(2); // guarded: no reload loop
});

test("say, instruction and transcript; presence; request correlation", async ({ page }) => {
  const t = mock.create();
  t.onMessage = (m, ws) => {
    if (m.t === "devices") { ws.send(JSON.stringify({ t: "devices", cid: m.cid, devices: [{ id: "d_x" }] })); return true; }
    if (m.t === "adopt_code") { ws.send(JSON.stringify({ t: "error", cid: m.cid, code: "forbidden", message: "no" })); return true; }
  };
  await open(page, t);
  await page.evaluate(() => {
    const tl = (window as any).tendril;
    (window as any).__said = [];
    tl.on("say", (m: any) => (window as any).__said.push(m.text));
    tl.on("presence", (p: any) => ((window as any).__presence = p));
  });
  mock.broadcast(t, { t: "say", message_id: "agent-on-it", text: "On it", speak: true, ts: 1 });
  await page.waitForFunction(() => (window as any).__said.length === 1);
  mock.broadcast(t, { t: "presence", state: "working", text: "Working", last_seen: 1, schedule_minutes: null, withheld: 0, wake: "long_poll" });
  await page.waitForFunction(() => (window as any).__presence?.state === "working");
  expect(await page.evaluate(() => (window as any).tendril.presence.state)).toBe("working");
  await page.evaluate(() => (window as any).tendril.conversation.send("make it blue", {via: "text"}));
  const ins = mock.messages(t, "send").find((m) => m.kind === "instruction");
  expect(ins).toMatchObject({ kind: "instruction", text: "make it blue", via: "text", wake: true });
  const id = await page.evaluate(() => (window as any).tendril.device.id);
  mock.broadcast(t, { t: "instruction_echo", text: "make it blue", via: "text", device: id, cid: ins.cid, message_id: "user-identity", ts: 2 });
  await page.waitForTimeout(100);
  const tr = await page.evaluate(() => (window as any).tendril.conversation.entries().map((e: any) => `${e.from}:${e.text}`));
  expect(tr).toEqual(["agent:On it", "user:make it blue"]);
  const devices = await page.evaluate(() => (window as any).tendril.host.request("devices"));
  expect(devices.devices[0].id).toBe("d_x");
  const err = await page.evaluate(() => (window as any).tendril.host.request("adopt_code").then(() => "resolved", (e: any) => e.code));
  expect(err).toBe("forbidden");
});

test("upload verifies the blob through an immutable transfer session", async ({ page }) => {
  const t = mock.create();
  await open(page, t);
  const r = await page.evaluate(() => (window as any).tendril.upload(new Blob(["abc"], { type: "text/plain" }), { name: "a.txt" }));
  expect(r.id).toMatch(/^b_/);
  expect(r.url).toBe(mock.url(t) + "_tendril/blobs/" + r.id);
  expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(r.size).toBe(3);
  const b = t.blobs.get(r.id)!;
  expect(b.body.toString()).toBe("abc");
  expect(b.type).toBe("text/plain");
  expect(b.name).toBe("a.txt");
});

test("check runs the bundled axe with external downloads blocked and reports violations", async ({ page }) => {
  const external: string[] = [];
  await page.route("https://cdn.jsdelivr.net/**", route => { external.push(route.request().url()); return route.abort(); });
  const t = mock.create({ html: `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">` });
  await open(page, t);
  mock.broadcast(t, { t: "check", call_id: "c1" });
  const r = await mock.waitFor(() => t.msgs.find((m) => m.t === "eval_result" && m.call_id === "c1"), 20000);
  expect(r.ok).toBe(true);
  expect(external).toEqual([]);
  const ids = r.value.violations.map((v: any) => v.id);
  expect(ids).toContain("image-alt");
  expect(typeof r.value.violations[0].nodes).toBe("number");
});

for (const preview of [false, true]) test(`publication A and B retain pinned lazy assets and recover offline in both tabs (preview=${preview})`, async ({ page, context }) => {
  const t = mock.create({ noSw: false, preview, html: `<h1 id="h">Page A</h1><script src="app.js"></script>` });
  t.files["app.js"] = { type: "text/javascript", body: "window.__app = 'A';" };
  t.files["lazy.js"] = { type: "text/javascript", body: "window.__lazy = 'A';" };
  await open(page, t);
  await expect(page).toHaveURL(new RegExp(`/_publications/1/index.html$`));
  await page.evaluate(() => { window.addEventListener("tendril:before-reload", event => event.preventDefault()); });
  await page.evaluate(() => window.tendril.state.set("note", "kept"));
  expect(await savedForOffline(page)).toBe("1");
  t.version = 2; t.html = `<h1 id="h">Page B</h1><script src="app.js"></script>`;
  t.files["app.js"] = { type: "text/javascript", body: "window.__app = 'B';" };
  t.files["lazy.js"] = { type: "text/javascript", body: "window.__lazy = 'B';" };
  const next = await context.newPage(); await open(next, t); expect(await savedForOffline(next)).toBe("2");
  mock.broadcast(t, { t: "reload", version: 2 });
  expect(await page.evaluate(() => window.tendril.version)).toBe(1);
  await context.setOffline(true);
  for (const [tab, label] of [[page, "A"], [next, "B"]] as const) {
    await tab.evaluate(() => new Promise<void>((resolve, reject) => {
      const script = document.createElement("script"); script.src = "lazy.js"; script.onload = () => resolve(); script.onerror = () => reject(new Error("lazy asset failed")); document.head.append(script);
    }));
    expect(await tab.evaluate(() => (window as any).__lazy)).toBe(label);
    await tab.reload(); await expect(tab.locator("#h")).toHaveText(`Page ${label}`);
    expect(await tab.evaluate(() => (window as any).__app)).toBe(label);
    expect(await tab.evaluate(() => window.tendril.state.get("note"))).toBe("kept");
    expect(await tab.evaluate(() => window.tendril.connected)).toBe(false);
  }
  await context.setOffline(false);
});

test("authored composer preserves new text typed while an earlier send awaits acceptance", async ({ page }) => {
  const { conversationPage } = await import("../../test/e2e/authored-pages");
  let accept: (() => void) | undefined;
  const t = mock.create({ html: conversationPage, onMessage(message, socket) {
    if (message.t !== "send" || message.kind !== "instruction") return;
    accept = () => socket.send(JSON.stringify({ t: "ack", cid: message.cid, seq: 1 })); return true;
  } });
  await open(page, t);
  const input = page.getByRole("textbox", { name: "Message to the agent" });
  await input.fill("First submitted thought"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await mock.waitFor(() => accept); await input.fill("Second thought still being written"); accept!();
  await expect(page.locator("#delivery")).toHaveText("accepted");
  await expect(input).toHaveValue("Second thought still being written");
  await page.reload(); await page.waitForFunction(() => window.tendril.connected);
  await expect(input).toHaveValue("Second thought still being written");
});

test("the small utility observes active sensors without opening one and stops tracked use", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).mediaCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      (window as any).mediaCalls++;
      const canvas = document.createElement("canvas");
      const stream = canvas.captureStream(); (window as any).fixtureStream = stream; return stream;
    };
  });
  const t = mock.create({ html: '<button id="camera" onclick="navigator.mediaDevices.getUserMedia({video:true})">Start camera fixture</button>' });
  await open(page, t);
  expect(await page.evaluate(() => (window as any).mediaCalls)).toBe(0);
  expect(await page.evaluate(() => window.tendril.sensors.status().active)).toEqual([]);
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await page.locator("#camera").click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status().active)).toEqual(["camera"]);
  await page.getByRole("button", { name: "Stop Camera", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status().active)).toEqual([]);
  expect(await page.evaluate(() => (window as any).fixtureStream.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended"))).toBe(true);
});

test("the utility exposes pending acquisitions and cancels them before native permission replies", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.mediaRequests = []; w.mediaResults = [];
    navigator.mediaDevices.getUserMedia = () => new Promise((resolve, reject) => w.mediaRequests.push({ resolve, reject }));
  });
  const t = mock.create({ html: `<button id="camera" onclick="navigator.mediaDevices.getUserMedia({video:true}).then(()=>mediaResults.push('accepted'), error=>mediaResults.push(error.name))">Request camera fixture</button>` });
  await open(page, t);
  await page.locator("#camera").click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: ["camera"] });
  await expect(page.locator("tendril-utility").getByRole("status")).toHaveText("Camera request pending");
  await page.getByRole("button", { name: "Stop Camera", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).mediaResults)).toEqual(["AbortError"]);
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.lateStream = document.createElement("canvas").captureStream();
    w.mediaRequests[0].resolve(w.lateStream);
  });
  await expect.poll(() => page.evaluate(() => (window as any).lateStream.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended"))).toBe(true);

  await page.locator("#camera").click();
  await expect(page.getByRole("button", { name: "Stop Camera", exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).mediaRequests[1].reject(new DOMException("Denied", "NotAllowedError")));
  await expect.poll(() => page.evaluate(() => (window as any).mediaResults)).toEqual(["AbortError", "NotAllowedError"]);
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);

  await page.locator("#camera").click();
  await page.evaluate(() => {
    const w = window as any;
    w.freshStream = document.createElement("canvas").captureStream();
    w.mediaRequests[2].resolve(w.freshStream);
  });
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: ["camera"], pending: [] });
  await page.locator("#camera").click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: ["camera"], pending: ["camera"] });
  await expect(page.locator("tendril-utility").getByRole("status")).toHaveText("Camera active. Camera request pending");
  await page.getByRole("button", { name: "Stop Camera", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: [] });
  expect(await page.evaluate(() => (window as any).freshStream.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended"))).toBe(true);
});

test("the utility keeps pending one-shot location cancellable without claiming a location fix", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.locationReads = []; w.locationResults = [];
    navigator.geolocation.getCurrentPosition = (success, error) => w.locationReads.push({ success, error });
  });
  const t = mock.create({ html: `<button id="location" onclick="navigator.geolocation.getCurrentPosition(position=>locationResults.push(position))">Request location fixture</button>` });
  await open(page, t);
  await page.locator("#location").click();
  await expect.poll(() => page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: ["location"] });
  await expect(page.locator("tendril-utility").getByRole("status")).toHaveText("Location request pending");
  await page.getByRole("button", { name: "Stop Location", exact: true }).click();
  await page.evaluate(() => (window as any).locationReads[0].success({ coords: { latitude: 1, longitude: 2 } }));
  expect(await page.evaluate(() => (window as any).locationResults)).toEqual([]);
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.tendril.sensors.status())).toEqual({ active: [], pending: [] });
});
