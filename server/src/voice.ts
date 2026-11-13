// Fast voice layer, server side (PROTOCOL section 9). Owned by the voice agent.
//
// Mints a short-lived client credential so the browser can open a realtime voice
// session directly with the provider. The provider API key never leaves the server.
//
// Provider "openai-realtime" — docs used (read 2026-11-13):
//   Create client secret: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
//     POST https://api.openai.com/v1/realtime/client_secrets
//     body {expires_after:{anchor:"created_at",seconds:10..7200}, session:{type:"realtime",model,instructions,tools,tool_choice,audio:{input,output:{voice}}}}
//     → {value:"ek_…", expires_at, session}
//   WebRTC flow:          https://developers.openai.com/api/docs/guides/voice-webrtc
//     (browser POSTs its SDP offer to https://api.openai.com/v1/realtime/calls with the ephemeral key;
//      the guide's example model is "gpt-realtime-2.1" and it sends an OpenAI-Safety-Identifier header)
//   Function calling:     https://developers.openai.com/api/docs/guides/realtime-function-calling
//   Transcription:        https://developers.openai.com/api/docs/guides/realtime-transcription
import type { Env } from "./env";

export const DEFAULT_OPENAI_MODEL = "gpt-realtime-2.1";
const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const OPENAI_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const OPENAI_VOICE = "marin";
const OPENAI_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
// The key is only needed to open the WebRTC call; the call itself outlives it.
const SECRET_TTL_SECONDS = 120;

const MAX_TOOLS = 64;
const MAX_PAGE_INSTRUCTIONS = 4000;
const MAX_DESCRIPTION = 1024;
const MAX_PARAMS_JSON = 8000;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const BASE_INSTRUCTIONS = `You are the fast voice layer of a web page that an AI agent built and controls. The user talks to you through the page.
- Be very brief: a few words or one short sentence. Never lecture or list.
- When one of your functions covers the request, call it, then confirm in a few words ("Done.", "Ticked milk.").
- For anything else (questions about the content, changes to the page, new content, research, anything you are unsure about) call ask_agent with the request in the user's words, then say it was passed to the agent, e.g. "Passed to the agent."
- Never claim you did something you did not do through a function, and never invent a function result.
- If the speech is clearly not addressed to you, do nothing.`;

export const ASK_AGENT_TOOL = {
  name: "ask_agent",
  description: "Hand the user's request to the agent that owns this page. Use for anything no other function covers. The agent replies later.",
  parameters: { type: "object", properties: { request: { type: "string", description: "The user's request, in their own words." } }, required: ["request"] },
};

type Tool = { name: string; description: string; parameters: object };

function err(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function providerName(env: Env): "openai-realtime" | null {
  const p = (env.VOICE_PROVIDER || "").trim();
  if (p === "openai-realtime" || (!p && env.OPENAI_API_KEY)) return env.OPENAI_API_KEY ? "openai-realtime" : null;
  return null;
}

export function voiceAvailable(env: Env): boolean {
  return providerName(env) !== null;
}

/** Validates and normalises tools from the page; always includes ask_agent. Throws a string on bad input. */
export function sanitizeTools(input: unknown): Tool[] {
  if (input !== undefined && !Array.isArray(input)) throw "tools must be an array";
  const out: Tool[] = [];
  const seen = new Set<string>();
  for (const t of (input as any[]) || []) {
    if (!t || typeof t !== "object") throw "each tool must be an object";
    const name = t.name;
    if (typeof name !== "string" || !TOOL_NAME.test(name)) throw `invalid tool name ${JSON.stringify(name)}`;
    if (seen.has(name)) continue;
    let parameters: any = t.parameters;
    if (parameters === undefined || parameters === null) parameters = { type: "object", properties: {} };
    if (typeof parameters !== "object" || Array.isArray(parameters)) throw `tool ${name}: parameters must be a JSON Schema object`;
    if (JSON.stringify(parameters).length > MAX_PARAMS_JSON) throw `tool ${name}: parameters too large`;
    if (parameters.type === undefined) parameters = { type: "object", ...parameters };
    const description = typeof t.description === "string" ? t.description.slice(0, MAX_DESCRIPTION) : "";
    seen.add(name);
    out.push({ name, description, parameters });
  }
  // The server's ask_agent definition is authoritative.
  const rest = out.filter((t) => t.name !== ASK_AGENT_TOOL.name);
  if (rest.length > MAX_TOOLS - 1) throw `too many tools (max ${MAX_TOOLS - 1})`;
  return [...rest, ASK_AGENT_TOOL];
}

export function buildInstructions(name: string, pageInstructions: unknown): string {
  let s = BASE_INSTRUCTIONS + `\nThe page is called "${String(name || "Tendril").slice(0, 100)}".`;
  if (typeof pageInstructions === "string" && pageInstructions.trim()) {
    s += `\n\nContext from the page:\n${pageInstructions.trim().slice(0, MAX_PAGE_INSTRUCTIONS)}`;
  }
  return s;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function openaiSession(env: Env, ctx: { tendrilId: string; name: string }, instructions: string, tools: Tool[]): Promise<Response> {
  const model = (env.VOICE_MODEL || "").trim() || DEFAULT_OPENAI_MODEL;
  const body = {
    expires_after: { anchor: "created_at", seconds: SECRET_TTL_SECONDS },
    session: {
      type: "realtime",
      model,
      instructions,
      tools: tools.map((t) => ({ type: "function", ...t })),
      tool_choice: "auto",
      audio: {
        input: { transcription: { model: OPENAI_TRANSCRIBE_MODEL }, turn_detection: { type: "semantic_vad" } },
        output: { voice: OPENAI_VOICE },
      },
    },
  };
  let res: Response;
  try {
    res = await fetch(OPENAI_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        // Stable, non-identifying id per tendril for OpenAI's abuse monitoring.
        "OpenAI-Safety-Identifier": await sha256Hex(`tendril:${ctx.tendrilId}`),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return err(502, "provider_error", `Voice provider unreachable: ${(e as any)?.message ?? e}`);
  }
  if (!res.ok) {
    // Pass the provider's message through (never our key, which is not in it), trimmed.
    let detail = "";
    try { const j: any = await res.json(); detail = j?.error?.message || ""; } catch {}
    return err(502, "provider_error", `Voice provider returned ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`);
  }
  const j: any = await res.json();
  const secret = j?.value ?? j?.client_secret?.value;
  if (typeof secret !== "string" || !secret) return err(502, "provider_error", "Voice provider returned no client secret");
  return Response.json(
    {
      provider: "openai-realtime",
      client_secret: secret,
      expires_at: j?.expires_at ?? j?.client_secret?.expires_at ?? null,
      model: j?.session?.model ?? model,
      voice: OPENAI_VOICE,
      calls_url: OPENAI_CALLS_URL,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleVoiceSession(request: Request, env: Env, ctx: { tendrilId: string; name: string }): Promise<Response> {
  const provider = providerName(env);
  if (!provider) return err(501, "unavailable", "No voice provider configured");
  if (request.method !== "POST") return err(405, "method_not_allowed", "Use POST");
  let body: any = {};
  try {
    const text = await request.text();
    if (text.length > 200_000) return err(413, "too_large", "Body too large");
    body = text ? JSON.parse(text) : {};
  } catch {
    return err(400, "bad_request", "Body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "bad_request", "Body must be a JSON object");
  let tools: Tool[];
  try { tools = sanitizeTools(body.tools); } catch (e) { return err(400, "bad_request", String(e)); }
  const instructions = buildInstructions(ctx.name, body.instructions);
  return openaiSession(env, ctx, instructions, tools);
}
