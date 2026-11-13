// STUB — owned by the push agent. See docs/PROTOCOL.md section 10.
import type { Env } from "./env";
export function pushAvailable(env: Env): boolean { return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY); }
export function vapidPublicKey(env: Env): string | null { return env.VAPID_PUBLIC_KEY ?? null; }
export async function sendWebPush(_env: Env, _subscription: PushSubscriptionJSON, _payload: unknown, _opts?: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string }): Promise<{ ok: boolean; status: number; gone: boolean }> {
  return { ok: false, status: 501, gone: false };
}
interface PushSubscriptionJSON { endpoint?: string; expirationTime?: number | null; keys?: Record<string, string> }
