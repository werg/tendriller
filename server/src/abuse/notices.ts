import type { Env } from "../env";

async function notice(env: Env, accountId: string, kind: string, tendrilId: string | null, reason: string): Promise<void> {
  await env.ACCOUNTS.prepare("INSERT INTO account_notices (id, account_id, kind, tendril_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), accountId, kind, tendrilId, reason, Date.now()).run();
}

export function ownerNotice(env: Env, accountId: string, tendrilId: string, action: "held" | "restored", reason: string): Promise<void> {
  return notice(env, accountId, action, tendrilId, reason);
}

export function reporterAcknowledgement(env: Env, accountId: string, tendrilId: string): Promise<void> {
  return notice(env, accountId, "report_received", tendrilId, "Your report was received.");
}

export function accountSuspendedNotice(env: Env, accountId: string, reason: string): Promise<void> {
  return notice(env, accountId, "suspended", null, reason);
}
