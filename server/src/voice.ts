// STUB — owned by the voice agent. See docs/PROTOCOL.md section 9.
import type { Env } from "./env";
export function voiceAvailable(_env: Env): boolean { return false; }
export async function handleVoiceSession(_request: Request, _env: Env, _ctx: { tendrilId: string; name: string }): Promise<Response> {
  return Response.json({ error: { code: "unavailable", message: "No voice provider configured" } }, { status: 501 });
}
