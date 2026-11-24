import type { Tendril } from './tendril';
import { AGENT_SCOPES, agentScopes, type AgentScope } from './access';
import { addActivity } from './activity';
import { selectedApplication } from './application';
import { hostApprovalBinding, requireHostApprovalBinding, requireHostApprovalPolicy, type HostApproval } from './host-adoption';
import { HttpError } from './http';
import { sha256Hex, sixDigits } from './ids';
import { ADOPT_CODE_TTL } from './limits';
import { publicBase } from './urls';

/** Scopes an owner can grant to an additional agent from a review surface. */
export const AGENT_SCOPE_ITEMS: ReadonlyArray<{ value: AgentScope; label: string; desc: string; defaultChecked?: boolean }> = [
  { value: 'host:read', label: 'Read host status', desc: 'Inspect page info, publications and activity.', defaultChecked: true },
  { value: 'participants:connect', label: 'Connect enrolled participants', desc: 'Relay peer introductions for already-enrolled devices.', defaultChecked: true },
  { value: 'control:write', label: 'Update signed application control', desc: 'Stage and commit Chronolog control transitions.' },
  { value: 'publication:write', label: 'Publish signed code', desc: 'Upload and activate new signed page releases.' },
  { value: 'assistant:manage', label: 'Propose assistant access', desc: 'Advertise queries, commands and events for assistant review.' },
];
const KNOWN = new Set<string>(AGENT_SCOPES);
export const AGENT_NAME_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
const CODE_RE = /^[a-z2-7]{12}-\d{6}$/;
const APP_RE = /^[a-f0-9]{64}$/;

export interface AgentInvite {
  code: string;
  name: string;
  scopes: AgentScope[];
  applicationId: string;
  expiresAt: number;
  serviceOrigin: string;
}

/**
 * Issues the single pending, non-replacing delegation code for a named agent.
 * `authorize` runs inside the committing transaction to re-check the caller.
 */
export async function issueAgentInvite(t: Tendril, ownerAccount: string, rawName: unknown, rawScopes: unknown,
  authorize: () => void = () => {}): Promise<AgentInvite> {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!AGENT_NAME_RE.test(name)) throw new HttpError(400, 'invalid_agent_name', 'Choose a short agent name using letters, numbers, dots, dashes or underscores.');
  if (name === 'setup') throw new HttpError(400, 'reserved_agent_name', 'Choose an agent name other than the fixed setup binding.');
  const requested = Array.isArray(rawScopes) ? rawScopes.filter((s): s is string => typeof s === 'string') : [];
  const scopes = agentScopes(requested.length ? requested : ['host:read', 'participants:connect']);
  const binding = hostApprovalBinding(t, ownerAccount);
  const code = `${t.tid}-${sixDigits()}`, expiresAt = t.now() + ADOPT_CODE_TTL;
  const hash = await sha256Hex(code);
  await requireHostApprovalPolicy(t, binding);
  t.transaction(() => {
    requireHostApprovalBinding(t, binding);
    authorize();
    if (t.db.one('SELECT 1 FROM tokens WHERE name=?', name)) throw new HttpError(409, 'agent_name_in_use', `An agent named ${name} is already connected. Choose another name.`);
    if ((t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM tokens')?.n ?? 0) >= 32) throw new HttpError(429, 'agent_binding_capacity', 'This page already has the maximum of 32 agents.');
    t.db.set('adopt', { ...binding, hash, expires_at: expiresAt, attempts: 0, mode: 'delegate', name, scopes } satisfies HostApproval);
    addActivity(t, { kind: 'agent_delegation', summary: `The owner approved an additional scoped agent: ${name}`, by: `owner:${ownerAccount}` });
  });
  return { code, name, scopes, applicationId: selectedApplication(t).id, expiresAt, serviceOrigin: publicBase(t.env) };
}

/** Owner-facing JSON for a freshly issued agent invitation. */
export function agentInviteResponse(invite: AgentInvite, pageName: string) {
  return {
    name: invite.name, scopes: invite.scopes, code: invite.code, application_id: invite.applicationId,
    expires_at: invite.expiresAt, join_url: agentJoinUrl(invite),
    blurb: agentInviteBlurb(invite, pageName), link_blurb: agentLinkBlurb(invite, pageName),
  };
}

const quoted = (value: string) => JSON.stringify(value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80));
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function instructions(invite: AgentInvite): string {
  const body = JSON.stringify({ code: invite.code, expectedMode: 'delegate', applicationId: invite.applicationId });
  return [
    `1. Read how agent bindings work: ${invite.serviceOrigin}/docs/AGENT_BINDINGS.md`,
    `   (New to Tendriller? Start with ${invite.serviceOrigin}/agent.md.)`,
    `2. Before ${utc(invite.expiresAt)}, redeem this one-time code exactly once:`,
    `   POST ${invite.serviceOrigin}/api/adopt`,
    `   Content-Type: application/json`,
    `   ${body}`,
    `3. The response is your private page handle. Store it securely and never put it in page files, logs or chat.`,
    `   If the response is lost, do not retry: ask the owner for a new code.`,
    ``,
    `Agent name: ${invite.name}`,
    `Host permissions: ${invite.scopes.join(', ')}`,
  ].join('\n');
}

/** Paste-ready text containing the one-time credential itself. */
export function agentInviteBlurb(invite: AgentInvite, pageName: string): string {
  return `Please join my Tendriller page ${quoted(pageName)} as the agent "${invite.name}".\n\n${instructions(invite)}\n`;
}

/** Paste-ready text that refers to the stateless instructions URL instead. */
export function agentLinkBlurb(invite: AgentInvite, pageName: string): string {
  return `Please join my Tendriller page ${quoted(pageName)} as the agent "${invite.name}". ` +
    `Fetch these one-time instructions (single use, valid until ${utc(invite.expiresAt)}) and follow them: ${agentJoinUrl(invite)}`;
}

export function agentJoinUrl(invite: AgentInvite): string {
  const url = new URL('/join/agent', invite.serviceOrigin);
  url.searchParams.set('code', invite.code);
  url.searchParams.set('app', invite.applicationId);
  url.searchParams.set('name', invite.name);
  url.searchParams.set('scopes', invite.scopes.join(' '));
  url.searchParams.set('expires', String(invite.expiresAt));
  return url.toString();
}

/**
 * Stateless rendering of joining instructions. It never looks up or validates the
 * code, so it cannot be used to probe codes, and it echoes only strictly
 * validated fields: no free text from the URL reaches the document.
 */
export function agentJoinDocument(url: URL, serviceOrigin: string): Response {
  const code = url.searchParams.get('code') ?? '', app = url.searchParams.get('app') ?? '';
  const name = url.searchParams.get('name') ?? '', expires = Number(url.searchParams.get('expires'));
  const scopes = (url.searchParams.get('scopes') ?? '').split(/[\s,]+/).filter(Boolean);
  const headers = { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };
  if (!CODE_RE.test(code) || !APP_RE.test(app) || !AGENT_NAME_RE.test(name) || !Number.isSafeInteger(expires) ||
      !scopes.length || scopes.length > KNOWN.size || scopes.some(scope => !KNOWN.has(scope)))
    return new Response(`# Invalid agent invitation link\n\nThis link is incomplete. Ask the page owner to copy the invitation again from their Tendriller dashboard or page settings.\n`, { status: 400, headers });
  const invite: AgentInvite = { code, name, scopes: scopes as AgentScope[], applicationId: app, expiresAt: expires, serviceOrigin };
  const expired = expires <= Date.now();
  return new Response(`# Join a Tendriller page as an agent\n\nA page owner invited you to connect to their Tendriller page as the agent "${name}".\n` +
    (expired ? `\n> This invitation expired at ${utc(expires)}. Ask the owner for a new one.\n` : '') +
    `\n${instructions(invite)}\n`, { headers });
}

export interface GuestInviteInput { role?: unknown; email?: unknown; label?: unknown; expires_in?: unknown }
export function parseShareExpiry(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 365 * 86400) throw new HttpError(400, 'bad_request', 'expires_in must be between 1 second and 365 days');
  return seconds;
}
