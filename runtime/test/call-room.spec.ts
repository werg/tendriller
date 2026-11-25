import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let origin: string;
let server: Server;

test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        export { mountCallRoom, renderTabTakeoverBanner } from './docs/tutorial/shared/ui/call-room.mjs';
        export { openWebRtcConnection } from '@chronolog/peer-session/webrtc';
      `,
      resolveDir: new URL("../..", import.meta.url).pathname,
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    alias: {
      "@tendriller/core/authority": new URL("../../contract/authority.mjs", import.meta.url).pathname,
    },
    write: false,
  });

  server = createServer((req, res) => {
    if (req.url === "/call-bundle.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(bundle.outputFiles[0].text);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html>
<html lang="en">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Call Room E2E</title>
<body style="margin:0;padding:12px">
  <main id="alice"></main>
  <script type="module">
    import { mountCallRoom, openWebRtcConnection } from '/call-bundle.js';

    const aliceKey = '1'.repeat(64);
    const bobKey = '2'.repeat(64);
    const scribeKey = '3'.repeat(64);
    const coachKey = '4'.repeat(64);

    // Real Chromium <-> Chromium WebRTC connection using our upgraded trickle ICE + Perfect Negotiation!
    function queue() {
      const items = []; let wake = null; let closed = false;
      return {
        push(v) { if (!closed) { items.push(v); wake?.(); wake = null; } },
        async *messages() {
          while (true) {
            if (items.length) { yield items.shift(); continue; }
            if (closed) return;
            await new Promise(r => { wake = r; });
          }
        },
        close() { closed = true; wake?.(); wake = null; },
      };
    }
    const qA = queue(), qB = queue();
    const sigA = { messages: qA.messages(), async send(v) { qB.push(structuredClone(v)); }, close: () => qA.close() };
    const sigB = { messages: qB.messages(), async send(v) { qA.push(structuredClone(v)); }, close: () => qB.close() };

    const [rtcA, rtcB] = await Promise.all([
      openWebRtcConnection({ role: 'offerer', signaling: sigA }),
      openWebRtcConnection({ role: 'answerer', signaling: sigB }),
    ]);

    const inBand = { a: null, b: null };
    inBand.a = rtcA.session.attachInBandSignaling({
      polite: true,
      async send(msg) { const c = structuredClone(msg); queueMicrotask(() => { void inBand.b.receive(c); }); },
    });
    inBand.b = rtcB.session.attachInBandSignaling({
      polite: false,
      async send(msg) { const c = structuredClone(msg); queueMicrotask(() => { void inBand.a.receive(c); }); },
    });

    // Shared in-memory signal bus simulating Chronolog session.signals.
    const subs = new Set();
    const makeSignals = authorId => ({
      async send(topic, payload) {
        for (const s of subs) if (!s.topics || s.topics.includes(topic)) s.push({ authorId, topic, payload });
      },
      subscribe({ topics, signal }) {
        const items = []; let wake = null; let closed = false;
        const entry = { topics, push(v) { if (!closed) { items.push(v); wake?.(); wake = null; } } };
        subs.add(entry);
        const stop = () => { closed = true; subs.delete(entry); wake?.(); wake = null; };
        signal?.addEventListener('abort', stop, { once: true });
        return { async *[Symbol.asyncIterator]() {
          try { while (true) { if (items.length) { yield items.shift(); continue; } if (closed || signal?.aborted) return; await new Promise(r => { wake = r; }); } }
          finally { stop(); }
        } };
      },
    });

    const stop = new AbortController();
    const aliceSignals = makeSignals(aliceKey);
    const bobSignals = makeSignals(bobKey);
    const scribeSignals = makeSignals(scribeKey);
    const coachSignals = makeSignals(coachKey);
    window.commands = [];
    window.bobReceivedData = [];
    window.bobReceivedTracks = 0;

    rtcB.session.media.onTrack(({ track }) => {
      if (track) window.bobReceivedTracks += 1;
    });
    rtcB.session.streams.onStream(stream => {
      void (async () => {
        for await (const data of stream.messages(stop.signal)) {
          window.bobReceivedData.push(data instanceof Uint8Array ? Array.from(data) : data);
        }
      })();
    });

    const bobPeerHandle = {
      peerId: bobKey,
      connectionId: 'conn-1',
      transportKind: 'direct',
      media: rtcA.session.media,
      streams: rtcA.session.streams,
      signal: rtcA.signal,
    };
    const attachment = {
      rtc: {
        peers: () => [bobPeerHandle],
        getPeer: id => (id === bobKey ? bobPeerHandle : undefined),
        onPeer(fn) { fn({ type: 'connected', peer: bobPeerHandle }); return () => {}; },
      },
    };
    const sensorListeners = new Map();
    const registeredSensors = new Set();
    const runtime = {
      on(type, fn) { let s = sensorListeners.get(type); if (!s) sensorListeners.set(type, s = new Set()); s.add(fn); return () => s.delete(fn); },
      sensors: {
        register(spec) {
          const ctrl = new AbortController();
          const h = { kind: spec.kind, signal: ctrl.signal, setState() {}, unregister() { if (!ctrl.signal.aborted) { ctrl.abort(); registeredSensors.delete(h); } } };
          registeredSensors.add(h);
          return h;
        },
        async wakeLock() { return { async release() {} }; },
      },
    };
    window.activeSensorsCount = () => registeredSensors.size;
    window.emitStopSensors = () => { for (const fn of sensorListeners.get('sensors_stopped') ?? []) fn(); };

    const session = {
      identity: { publicKey: aliceKey },
      signal: stop.signal,
      signals: aliceSignals,
      async command(name, input) { window.commands.push({ name, input }); return {}; },
    };

    window.admitted = [];
    const ui = await mountCallRoom({
      runtime,
      session,
      attachment,
      container: document.querySelector('#alice'),
      title: 'Weekly Standup',
      transcription: 'off',
      agentAudio: 'ask',
      onAdmit: async knock => { window.admitted.push(knock.displayName); },
    });
    window.ui = ui;

    // Announce Bob + two agents (scribe=transcript, coach=audio) + waiting guest Carol.
    await bobSignals.send('call/presence', { callId: 'main', kind: 'human', displayName: 'Bob', joined: true, muted: false, cameraOn: true });
    await scribeSignals.send('call/presence', { callId: 'main', kind: 'agent', handle: 'scribe', mode: 'transcript', joined: true });
    await coachSignals.send('call/presence', { callId: 'main', kind: 'agent', handle: 'coach', mode: 'audio', joined: true });

    window.triggerTranscriptAndKnock = async () => {
      await bobSignals.send('call/transcript.final', {
        callId: 'main', utteranceId: 'u-bob-1', seq: 1,
        text: 'Hey @scribe, note that we shipped trickle ICE.', startedAtMs: Date.now(), endedAtMs: Date.now() + 1500,
      });
      await makeSignals('5'.repeat(64)).send('call/waiting.knock', {
        callId: 'main', displayName: 'Carol',
      });
    };

    window.sendWhiteboardBytes = () => {
      const ds = ui.room.dataStream('whiteboard', { ordered: false, maxRetransmits: 0 });
      ds.send(new Uint8Array([42, 43, 44]));
    };

    window.e2eReady = true;
  </script>
</body>
</html>`);
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

test.afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("mountCallRoom negotiates real WebRTC media tracks, custom binary data stream, per-person captions, waiting-room admit, and cleans up sensors", async ({ page }) => {
  await page.goto(origin);
  await page.waitForFunction(() => (window as any).e2eReady === true, { timeout: 15_000 });

  // Lobby shows title + ready agents before joining.
  await expect(page.getByRole("heading", { name: "Weekly Standup" })).toBeVisible();
  await expect(page.getByText("@scribe (transcript)")).toBeVisible();
  await expect(page.getByText("@coach (audio)")).toBeVisible();

  // Fill display name & click Join call (real trusted gesture -> acquires fake camera/mic).
  await page.getByPlaceholder("Enter your display name").fill("Alice");
  await page.getByRole("button", { name: "Join call" }).click();

  // Active call stage renders video tiles, honest agent modality pills, and zero horizontal overflow!
  await expect(page.getByText("Alice (You)")).toBeVisible();
  await expect(page.getByText("@scribe · Transcript only")).toBeVisible();
  await expect(page.getByText("@coach · Audio requested")).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // Verify real RTP audio + video tracks arrived at Peer B over in-band Perfect Negotiation!
  await page.waitForFunction(() => (window as any).bobReceivedTracks >= 2, { timeout: 10_000 });

  // Verify custom binary data stream works over the same WebRTC peer connection!
  await page.evaluate(() => (window as any).sendWhiteboardBytes());
  await page.waitForFunction(() => (window as any).bobReceivedData.length >= 1, { timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).bobReceivedData[0])).toEqual([42, 43, 44]);

  // Verify per-person transcript & 1-click Waiting Room Admit toast!
  await page.evaluate(() => (window as any).triggerTranscriptAndKnock());
  await expect(page.getByText("Hey @scribe, note that we shipped trickle ICE.")).toBeVisible();
  await expect(page.getByText("Carol is in the waiting room")).toBeVisible();
  await page.getByRole("button", { name: "Admit" }).click();
  expect(await page.evaluate(() => (window as any).admitted)).toEqual(["Carol"]);

  // Verify explicit agent audio consent button updates disclosure pill.
  await page.getByRole("button", { name: "Allow audio" }).click();
  await expect(page.getByText("@coach · Listening to audio")).toBeVisible();

  // Verify Stop sensors cleanly leaves the call and releases all sensor registrations.
  expect(await page.evaluate(() => (window as any).activeSensorsCount())).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).emitStopSensors());
  await expect(page.getByRole("button", { name: "Join call" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).activeSensorsCount())).toBe(0);
});
