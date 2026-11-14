import type { Env } from "../env";
import { publicBase } from "../urls";
import { sha256Hex } from "../ids";

async function send(env: Env, to: string, subject: string, text: string): Promise<void> {
  if (!env.EMAIL) return;
  try {
    await env.EMAIL.send({ to, from: { email: "notices@tendriller.dev", name: "Tendriller" },
      subject, text, html: `<p>${text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!).replace(/\n/g, "<br>")}</p>` });
  } catch (error) { console.error("Could not send account notice", error); }
}

async function accountEmail(env: Env, accountId: string): Promise<string | null> {
  return (await env.ACCOUNTS.prepare("SELECT email FROM accounts WHERE id = ?").bind(accountId).first<{ email: string | null }>())?.email ?? null;
}

export async function ownerNotice(env: Env, accountId: string, tendrilId: string, action: "held" | "restored", reason: string): Promise<void> {
  const to = await accountEmail(env, accountId);
  if (!to) return;
  const appeal = `${publicBase(env)}/appeal?tendril=${encodeURIComponent(tendrilId)}`;
  const text = action === "held"
    ? `Your Tendriller page ${tendrilId} has been held. Reason: ${reason}\nYou may appeal at ${appeal}. Review times are not guaranteed.`
    : `Your Tendriller page ${tendrilId} has been restored. Reason: ${reason}`;
  await send(env, to, `Tendriller page ${action}`, text);
}

export async function reporterAcknowledgement(env: Env, accountId: string, tendrilId: string): Promise<void> {
  const to = await accountEmail(env, accountId);
  if (to) await send(env, to, "Tendriller report received", `We received your report about page ${tendrilId}. Thank you.`);
}

export async function accountSuspendedNotice(env: Env, accountId: string, reason: string, tendrilId?: string): Promise<void> {
  const to = await accountEmail(env, accountId);
  if (!to) return;
  let appeal = "Contact abuse@tendriller.dev if you believe this is an error.";
  if (tendrilId) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await env.ACCOUNTS.prepare("INSERT INTO appeal_tokens (hash, account_id, tendril_id, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), accountId, tendrilId, Date.now() + 30 * 86_400_000).run();
    appeal = `Appeal at ${publicBase(env)}/appeal?tendril=${encodeURIComponent(tendrilId)}&token=${encodeURIComponent(token)} within 30 days.`;
  }
  await send(env, to, "Tendriller account suspended",
    `Your Tendriller account has been suspended. Reason: ${reason}\n${appeal}`);
}
