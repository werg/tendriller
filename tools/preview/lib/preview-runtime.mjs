// Local protocol adapter for the production browser runtime. No browser API is
// replaced here: the runtime owns its socket, state, IDB outbox and health.
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import * as previewSupport from "@tendriller/runtime/preview-support";
import { assertValid, CONTRACT_VERSION } from "@tendriller/core/contract";
import { createStreamFixtures } from "./preview-streams.mjs";
import { createPreviewStorage } from "./preview-storage.mjs";

/** Exact-value fixture references avoid hard-coding randomly assigned IDs. */
export function resolveFixture(value, context) {
  if (typeof value === "string" && /^\$(event|device)\./.test(value)) {
    const [root, ...parts] = value.slice(1).split(".");
    let result = context[root];
    for (const part of parts) {
      if (["__proto__", "constructor", "prototype"].includes(part)) throw Error("Reserved fixture reference");
      result = result?.[part];
    }
    if (result === undefined) throw Error(`Fixture reference is unavailable: ${value}`);
    return structuredClone(result);
  }
  if (Array.isArray(value)) return value.map(item => resolveFixture(item, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveFixture(item, context)]));
  return value;
}

export async function attachRuntime(server, { state = {}, role = "owner", name = "Local preview", onEvent, streams, version = () => 1, scopes = [], service = {contract:CONTRACT_VERSION,workflows:[]}, implementation } = {}) {
  const { applyOps, validateOps, historyPage, matchesContext } = implementation || previewSupport;
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  const devices = new Map();
  const deviceSecrets = new Map();
  const dedupe = new Map();
  const events = [], messages = [], activity = [], transcript = [];
  let shared = structuredClone(state), rev = 0, seq = 0, online = true;
  let focus = null, closing = false, closePromise;
  let presence = { state: "listening", text: "Preview agent ready", last_seen: Date.now(), schedule_minutes: null, withheld: 0, wake: "long_poll" };
  const send = (ws, message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
  const streamFixtures = createStreamFixtures(streams, { historyPage, role: () => role, send });
  const storage = createPreviewStorage({ role: () => role, scopes: () => scopes, matchesContext,
    verifyDevice: headers => {
      const id = headers["x-tendril-device"], secret = headers["x-tendril-device-secret"];
      return typeof secret === "string" && devices.has(id) && deviceSecrets.get(id) === secret ? id : null;
    } });
  const blobs = storage.blobs;
  const broadcast = (message, except) => { for (const ws of sockets) if (ws !== except) send(ws, message); };
  const log = (kind, summary, device) => activity.push({ seq: activity.length + 1, ts: Date.now(), kind, summary, device });
  const api = {
    events, messages, activity, blobs, storage, streams: streamFixtures,
    get state() { return structuredClone(shared); },
    get rev() { return rev; },
    get online() { return online; },
    get role() { return role; },
    get scopes() { return structuredClone(scopes); },
    setScopes(value) { scopes = structuredClone(value); broadcast({ t: "scopes", scopes }); },
    get devices() { return [...devices.values()]; },
    configuration() { return { devices: [...devices.values()], focus: focus && focus.expires_at > Date.now() ? focus : null }; },
    updateDevice(value) {
      const device = devices.get(value.id);
      if (!device) throw Error("No such device");
      if (Object.hasOwn(value, "role")) throw Error("Device purpose does not change access permissions");
      assertValid("device", { ...device, ...value });
      if (value.purpose) device.purpose = value.purpose;
      if (value.name) device.name = value.name;
      broadcast({ t: "device_config", ...api.configuration() });
      return api.configuration();
    },
    setFocus(value) {
      if (value.device === null) focus = null;
      else {
        const device = devices.get(value.device), ttl = value.ttl_seconds ?? 900;
        if (!device || device.role !== "owner") throw Error("Choose an owner device");
        if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86400) throw Error("ttl_seconds must be 30–86400");
        focus = { device: value.device, expires_at: Date.now() + ttl * 1000 };
      }
      broadcast({ t: "device_config", ...api.configuration() }); return api.configuration();
    },
    setOnline(value) {
      if (closing) return;
      online = !!value;
      if (!online) for (const ws of sockets) ws.close();
    },
    setRole(value) {
      assertValid("device", { id: "preview", role: value });
      role = value;
      for (const d of devices.values()) d.role = role;
      broadcast({ t: "role", role, pending: false });
    },
    updateState(ops) {
      const clean = validateOps(ops);
      shared = applyOps(shared, clean); rev++;
      broadcast({ t: "state", ops: clean, rev, by: "agent:preview" });
    },
    say(value) {
      const body = assertValid("say", typeof value === "string" ? { text: value } : value);
      const message_id = randomUUID(), ts = Date.now();
      transcript.push({ ts, from: "agent", text: body.text, message_id, ...(body.in_reply_to === undefined ? {} : { in_reply_to: body.in_reply_to }) });
      log("say", `Message ${message_id}: ${body.text}`);
      // Explicit fixture speak:true can exercise local TTS. Default avoids model downloads.
      broadcast({ t: "say", ...body, speak: body.speak === true, message_id, ts });
      return message_id;
    },
    setPresence(value) { presence = { ...presence, ...value }; broadcast({ t: "presence", ...presence }); },
    broadcast,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      storage.close();
      online = false;
      closePromise = new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
      for (const ws of wss.clients) ws.terminate();
      return closePromise;
    },
  };

  server.on("upgrade", (request, socket, head) => {
    if (closing || !online || new URL(request.url, "http://preview").pathname !== "/_tendril/ws") { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      if (closing) { ws.terminate(); return; }
      sockets.add(ws);
      let device;
      ws.on("close", () => { sockets.delete(ws); streamFixtures.disconnect(ws); });
      ws.on("message", async buffer => {
        if (closing) return;
        let m;
        try { m = JSON.parse(String(buffer)); } catch { return; }
        messages.push(m);
        if (m.t === "hello") {
          if (deviceSecrets.has(m.device_id) && deviceSecrets.get(m.device_id) !== m.device_secret) { ws.close(); return; }
          if (typeof m.device_secret === "string") deviceSecrets.set(m.device_id, m.device_secret);
          device = { id: m.device_id, name: m.name || "Preview browser", role, purpose: devices.get(m.device_id)?.purpose || "general", pending: false, connected: true };
          devices.set(device.id, device);
          send(ws, { t: "welcome", device_id: device.id, role, pending: false, primary: true,
            tendril: { id: "preview", name }, version: { current: version(), latest: version(), healthy: version(), served: m.version || version() },
            state: shared, scopes, service, rev, presence, transcript, features: { push: false },
            budget: { page_streak: 12 }, focus: null });
          return;
        }
        if (!device) { ws.close(); return; }
        const reply = message => send(ws, { ...message, ...(m.cid ? { cid: m.cid } : {}) });
        const ack = value => reply({ t: "ack", ...value });
        const key = device.id + ":" + m.cid;
        const subscription = m.t === "stream_subscribe" || m.t === "stream_unsubscribe";
        const fingerprint = JSON.stringify(m);
        if (!subscription && m.cid && dedupe.has(key)) {
          const prior = dedupe.get(key);
          ack(prior.fingerprint === fingerprint ? prior.result : { error: "command_conflict", message: "CID belongs to a different command" });
          return;
        }
        let result;
        try {
          const operation = { send: "event", state: "state", capture_complete: "capture" }[m.t];
          if (operation) {
            assertValid("preconditions", m);
            if (!matchesContext(scopes, m, operation, m.ops || []))
              throw Object.assign(Error("The fixture scope generation changed after this command was captured."), { code: "stale_generation" });
          }
          switch (m.t) {
            case "stream_subscribe": result = streamFixtures.subscribe(ws, m.stream, m.after); break;
            case "stream_unsubscribe": streamFixtures.unsubscribe(ws, m.stream); result = {}; break;
            case "ping": reply({ t: "pong" }); return;
            case "send":
            case "capture_complete": {
              if (role === "display") { result = { error: "forbidden", message: "Display devices cannot send" }; break; }
              if (operation === "capture" && ((m.kind ?? "event") !== "event" || !blobs.has(m.blob) || blobs.get(m.blob).device !== device.id)) {
                result = { error: "bad_capture", message: "Capture completion requires an application event and an uploaded blob reference" }; break;
              }
              if (JSON.stringify(m.data ?? null).length > 65536) { result = { error: "too_large", message: "Event data exceeds 64 KB" }; break; }
              const instruction = m.kind === "instruction" && role === "owner";
              const event = { seq: ++seq, ts: Date.now(), type: instruction ? "instruction" : "event", role, device: device.id,
                data: m.kind === "instruction" ? { text: m.text, via: m.via || "text" } : m.data ?? null,
                context: { ...(m.scope ? { scope: m.scope } : {}), generations: structuredClone(m.expected_generations) }, wake: m.wake !== false, withheld: false };
              assertValid("event", event); events.push(event); result = { seq: event.seq };
              if (m.kind === "instruction") {
                const entry = { message_id: randomUUID(), ts: event.ts, from: "user", text: m.text, cid: m.cid, device: device.id };
                transcript.push(entry); broadcast({ ...entry, t: "instruction_echo", seq: event.seq });
              }
              log("event", `${event.type} ${event.seq}`, device.id);
              // Scripted fixtures are deterministic responders, never a claim to a live host.
              if (onEvent) Promise.resolve(onEvent(event, api)).catch(error => log("error", error.message));
              break;
            }
            case "state": {
              if (role === "display") { result = { error: "forbidden", message: "Display devices cannot change state" }; break; }
              const ops = validateOps(m.ops); shared = applyOps(shared, ops); rev++;
              broadcast({ t: "state", ops, rev, by: `device:${device.id}` }, ws);
              result = { rev }; break;
            }
            case "versions": reply({ t: "versions", versions: [{ version: version(), status: "healthy", message: "Local preview", created_at: Date.now() }], current: version(), healthy: version() }); return;
            case "activity": reply({ t: "activity", entries: activity, cursor: activity.length }); return;
            case "devices": reply({ t: "devices", devices: [...devices.values()] }); return;
            case "links": reply({ t: "links", links: [] }); return;
            case "say_rendered": {
              if (typeof m.message_id !== "string" || !/^[0-9a-f-]{36}$/.test(m.message_id)) { result = { error: "bad_message" }; break; }
              if (!transcript.some(entry => entry.from === "agent" && entry.message_id === m.message_id)) { result = { error: "unknown_message" }; break; }
              const summary = `Message ${m.message_id} rendered`;
              if (!activity.some(entry => entry.kind === "say_rendered" && entry.device === device.id && entry.summary === summary)) log("say_rendered", summary, device.id);
              result = {}; break;
            }
            case "health": log("health", m.ok ? "Version healthy" : JSON.stringify(m.errors), device.id); return;
            case "log": for (const entry of m.entries || []) log(entry.level, entry.message, device.id); return;
            case "sensor_usage": log("sensor", JSON.stringify(m.active), device.id); return;
            case "eval_result": return;
            default: result = { error: "preview_unsupported", message: `${m.t} requires a real service; use the local Worker E2E suite` };
          }
        } catch (error) { result = { error: error.code || "bad_request", message: error.message }; }
        if (m.cid) { if (!subscription && !result?.error) dedupe.set(key, { fingerprint, result: result || {} }); ack(result); }
        if (m.t === "state" && result?.error) reply({ t: "state_reset", state: shared, scopes, rev });
      });
    });
  });
  return api;
}

/** Explicit fixture event transport, independent of the production API object. */
export const FIXTURE_TRANSPORT = String.raw`(() => {
  window.__tendrilEmit = async (event, data) => {
    const response = await fetch("/_preview/events", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({event,data})});
    if (!response.ok) throw Error("Fixture event was rejected");
  };
})();`;
