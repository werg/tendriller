// OpenAI Realtime over WebRTC, browser side.
//
// The server (server/src/voice.ts) mints an ephemeral client secret with the session
// config (model, instructions, tools, voice) baked in; the browser then talks to
// OpenAI directly. Docs used (read 2026-11-13):
//   WebRTC flow:       https://developers.openai.com/api/docs/guides/voice-webrtc
//     - SDP offer POSTed to https://api.openai.com/v1/realtime/calls with
//       `Authorization: Bearer <ephemeral key>`, `Content-Type: application/sdp`;
//       the answer SDP comes back as the response body.
//     - JSON events travel over a data channel named "oai-events".
//   Function calling:  https://developers.openai.com/api/docs/guides/realtime-function-calling
//     - `response.done` carries output items `{type:"function_call", name, call_id, arguments}`.
//     - Results go back as `conversation.item.create` with
//       `{type:"function_call_output", call_id, output}` followed by `response.create`.
//   Conversations:     https://developers.openai.com/api/docs/guides/realtime-conversations
//     - text input: `conversation.item.create` with a user `message` of `input_text`.
//   Transcription:     https://developers.openai.com/api/docs/guides/realtime-transcription
//     - `conversation.item.input_audio_transcription.completed` has `transcript`.
import type { ConnectOptions, RealtimeProvider, RealtimeSession, ToolDef } from "./types";

const DEFAULT_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

function toOpenAiTools(tools: ToolDef[]) {
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
}

function parseArgs(s: unknown): any {
  if (typeof s !== "string" || !s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

async function connect(opts: ConnectOptions): Promise<RealtimeSession> {
  const { session, hooks } = opts;
  const key: string | undefined = session.client_secret;
  if (!key) throw new Error("voice session: no client secret");
  const callsUrl: string = session.calls_url || DEFAULT_CALLS_URL;

  const pc = new RTCPeerConnection();
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.muted = !opts.audioOut;
  pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

  let micStream: MediaStream | null = null;
  if (opts.mic) {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of micStream.getTracks()) pc.addTrack(track, micStream);
  } else {
    // Receive-only audio so the model can still speak replies to typed / push-to-talk text.
    pc.addTransceiver("audio", { direction: "recvonly" });
  }

  const dc = pc.createDataChannel("oai-events");
  let closed = false;
  let modality: "audio" | "text" = "audio";
  let chainCalls = 0;

  const send = (ev: object) => { if (dc.readyState === "open") dc.send(JSON.stringify(ev)); };
  const responseCreate = () =>
    send(modality === "text" ? { type: "response.create", response: { output_modalities: ["text"] } } : { type: "response.create" });

  const close = (reason?: string) => {
    if (closed) return;
    closed = true;
    try { dc.close(); } catch {}
    try { pc.close(); } catch {}
    micStream?.getTracks().forEach((t) => t.stop());
    audioEl.srcObject = null;
    hooks.onClose(reason);
  };

  async function onResponseDone(response: any) {
    const output: any[] = Array.isArray(response?.output) ? response.output : [];
    const replyParts: string[] = [];
    const calls: any[] = [];
    for (const item of output) {
      if (item?.type === "function_call") calls.push(item);
      else if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          const t = typeof c?.text === "string" ? c.text : typeof c?.transcript === "string" ? c.transcript : "";
          if (t) replyParts.push(t);
        }
      }
    }
    if (replyParts.length) hooks.onReply(replyParts.join(" ").trim());
    // A cancelled response (user barged in) may hold half-formed calls; ignore them.
    if (calls.length && response?.status !== "cancelled") {
      chainCalls += calls.length;
      for (const call of calls) {
        let out: unknown;
        try { out = await hooks.onToolCall({ name: call.name, callId: call.call_id, args: parseArgs(call.arguments) }); }
        catch (e) { out = { error: String((e as any)?.message ?? e) }; }
        send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(out ?? { ok: true }) },
        });
      }
      if (!closed) responseCreate(); // let the model confirm briefly
      return;
    }
    const n = chainCalls;
    chainCalls = 0;
    hooks.onTurnDone({ toolCalls: n });
  }

  dc.onmessage = (e) => {
    let ev: any;
    try { ev = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
    switch (ev?.type) {
      case "response.done": void onResponseDone(ev.response); break;
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript) hooks.onUserTranscript(String(ev.transcript).trim());
        break;
      case "input_audio_buffer.speech_started": hooks.onSpeech?.(true); break;
      case "input_audio_buffer.speech_stopped": hooks.onSpeech?.(false); break;
      case "error": console.warn("[tendril voice] provider error", ev.error ?? ev); break;
    }
  };
  dc.onclose = () => close("closed");
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") close(pc.connectionState);
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(callsUrl, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/sdp" },
    });
    if (!res.ok) throw new Error(`voice session: SDP exchange failed (${res.status})`);
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    await new Promise<void>((resolve, reject) => {
      if (dc.readyState === "open") return resolve();
      const t = setTimeout(() => reject(new Error("voice session: data channel timeout")), 10000);
      dc.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      dc.addEventListener("error", () => { clearTimeout(t); reject(new Error("voice session: data channel error")); }, { once: true });
    });
  } catch (e) {
    close("connect_failed");
    throw e;
  }

  return {
    mic: opts.mic,
    sendText(text, o) {
      modality = o?.modality ?? "audio";
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      responseCreate();
    },
    updateTools(tools) {
      send({ type: "session.update", session: { type: "realtime", tools: toOpenAiTools(tools), tool_choice: "auto" } });
    },
    setAudioOut(on) { audioEl.muted = !on; },
    close: () => close("closed_by_client"),
  };
}

export const openaiRealtime: RealtimeProvider = { name: "openai-realtime", connect };
