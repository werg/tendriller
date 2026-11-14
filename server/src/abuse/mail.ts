import PostalMime from "postal-mime";
import type { Env } from "../env";
import { TENDRIL_ID_RE } from "../ids";

// Public abuse mail is intake evidence. A private forwarding recipient, configured
// in Email Routing, is the capability for immediate complaint holds.
export async function abuseEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const recipient = message.to.toLowerCase();
  const trusted = !!env.ABUSE_FORWARD_ADDRESS && recipient === env.ABUSE_FORWARD_ADDRESS.toLowerCase();
  if (recipient !== `abuse@${new URL(env.PUBLIC_BASE).hostname}` && !trusted) {
    message.setReject("Unknown recipient");
    return;
  }
  if (message.rawSize > 256_000) {
    message.setReject("Message too large");
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw);
  const content = `${parsed.subject ?? ""}\n${parsed.text ?? ""}`.slice(0, 32_000);
  const domain = env.PAGE_BASE_DOMAIN.toLowerCase();
  const ids = new Set<string>();
  for (const match of content.matchAll(/https:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ""));
      if (!url.hostname.toLowerCase().endsWith(`.${domain}`)) continue;
      const id = url.hostname.slice(0, -(domain.length + 1));
      if (TENDRIL_ID_RE.test(id) && /^\/s\/[a-z2-7]{26}(?:\/|$)/.test(url.pathname)) ids.add(id);
    } catch { /* Ignore malformed URLs in mail. */ }
    if (ids.size >= 10) break;
  }
  const reason = `${trusted ? "Forwarded complaint" : "Abuse email"}: ${content.replace(/\s+/g, " ").slice(0, 1500) || "No reason supplied"}`;
  for (const id of ids) {
    const stub = env.TENDRIL.get(env.TENDRIL.idFromName(id));
    const result = await stub.fetch(new Request("https://tendril.internal/abuse/report", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: trusted ? "email" : "mail", account_id: null, reason }),
    }));
    if (!result.ok && result.status !== 404) throw new Error(`Could not record abuse email for ${id}: ${result.status}`);
  }
}
