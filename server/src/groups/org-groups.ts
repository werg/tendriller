/**
 * GitHub Organization/Team & Google Workspace Domain identity tie-ins,
 * admin-signed page group policies, companion host group attestations,
 * and seamless zero-trust org offboarding (Issue #136 Part 2).
 */
import { requireHostAttestationIdentity, signRecord, verifyRecord, type Signed } from '../host-attestation';
import type { Env } from '../env';
import type { Tendril } from '../tendril';
import type { PagePrincipal } from '../access';
import { allows } from '../access';
import { addActivity } from '../activity';
import { selectedApplication } from '../application';
import { readControlState, type MaterializedControlState } from '../authority';
import { notifyDiscoveryWatchers } from '../discovery';
import { HttpError, isPlainObject, json, readJson } from '../http';
import { TENDRIL_ID_RE } from '../ids';
import { serviceSession } from '../accounts/auth';
import { requireTeamOrgEntitlement } from '../oauth-outbound/entitlements';
import { verifyHmacSha256 } from '../oauth-outbound/crypto';

export const GROUP_POLICY_DOMAIN = 'tendriller-group-policy-v1';
export const GROUP_ATTESTATION_DOMAIN = 'tendriller-group-attestation-v1';
export const ORG_DEPARTURE_DOMAIN = 'tendriller-org-departure-v1';

export const GROUP_ID_RE = /^(?:google-domain:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+|github-org:[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?|github-team:[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9][a-z0-9_-]{0,99})$/;
export const RULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONSUMER_GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const GITHUB_GROUP_TTL_MS = 30 * 60_000;
const GOOGLE_DOMAIN_TTL_MS = 30 * 24 * 60 * 60_000;
const GROUP_ATTESTATION_TTL_MS = 60 * 60_000;

export type GroupRole = 'reader' | 'writer' | 'admin';

export interface PageGroupRule {
  readonly ruleId: string;
  readonly group: string;
  readonly role: GroupRole;
  readonly label?: string;
}

export interface PageGroupPolicy {
  readonly pageId: string;
  readonly applicationId: string;
  readonly revision: number;
  readonly rules: readonly PageGroupRule[];
  readonly updatedAt: number;
}

export interface GroupAttestationPayload {
  readonly pageId: string;
  readonly applicationId: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly wrapKey: string;
  readonly group: string;
  readonly ruleId: string;
  readonly role: GroupRole;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface OrgDeparturePayload {
  readonly pageId: string;
  readonly applicationId: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly group: string;
  readonly ruleId: string;
  readonly observedAbsentAt: number;
}

export interface StoredOrgMember {
  accountId: string;
  group: string;
  ruleId: string;
  role: GroupRole;
  joinedAt: number;
}

export function normalizeGroupId(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (!GROUP_ID_RE.test(clean)) {
    throw new HttpError(400, 'invalid_group_id', 'Group must be google-domain:<domain>, github-org:<org>, or github-team:<org>/<team>');
  }
  if (clean.startsWith('google-domain:') && CONSUMER_GOOGLE_DOMAINS.has(clean.slice('google-domain:'.length))) {
    throw new HttpError(400, 'invalid_group_id', 'Consumer Google domains (gmail.com) cannot be used as a Workspace org rule');
  }
  return clean;
}

/** Record a verified Google Workspace hosted domain (`hd` claim) on sign-in. */
export async function recordGoogleWorkspaceDomain(
  env: Env,
  subject: string,
  accountId: string,
  hostedDomain: string | null | undefined,
  now = Date.now(),
): Promise<void> {
  if (!env.ACCOUNTS) return;
  const previous = await env.ACCOUNTS.prepare("SELECT group_id FROM identity_groups WHERE provider = 'google' AND subject = ?")
    .bind(subject).all<{ group_id: string }>().catch(() => ({ results: [] }));
  const prevSet = new Set(previous.results.map(r => r.group_id));

  const clean = typeof hostedDomain === 'string' ? hostedDomain.trim().toLowerCase() : '';
  const nextGroup = clean && !CONSUMER_GOOGLE_DOMAINS.has(clean) && GROUP_ID_RE.test(`google-domain:${clean}`)
    ? `google-domain:${clean}` : null;

  await env.ACCOUNTS.prepare("DELETE FROM identity_groups WHERE provider = 'google' AND subject = ?").bind(subject).run().catch(() => {});
  if (nextGroup) {
    await env.ACCOUNTS.prepare(`INSERT INTO identity_groups (provider, subject, account_id, group_id, display_name, verified_at, expires_at)
      VALUES ('google', ?, ?, ?, ?, ?, ?)`).bind(subject, accountId, nextGroup, clean, now, now + GOOGLE_DOMAIN_TTL_MS).run().catch(() => {});
    prevSet.delete(nextGroup);
  }
  if (prevSet.size > 0) {
    await propagateOrgDepartures(env, accountId, [...prevSet], now);
  }
}

/** Follow GitHub RFC 5988 Link pagination (`rel="next"`), bounded to `maxPages` and pinned to `api.github.com`. */
async function fetchGitHubPaginated<T>(
  initialUrl: string,
  headers: Record<string, string>,
  { maxPages = 5, required = false }: { maxPages?: number; required?: boolean } = {},
): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | null = initialUrl;
  for (let page = 0; page < maxPages && nextUrl; page++) {
    const parsed = new URL(nextUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.github.com') break;
    const res = await fetch(nextUrl, { headers, redirect: 'manual' });
    if (!res.ok) {
      if (required && page === 0) {
        throw new HttpError(502, 'github_org_sync_failed', `Could not read GitHub organizations (${res.status})`);
      }
      break;
    }
    const batch = await res.json().catch(() => null);
    if (Array.isArray(batch)) items.push(...(batch as T[]));
    const link = res.headers.get('Link') ?? '';
    const nextMatch = /<([^>]+)>;\s*rel="next"/i.exec(link);
    nextUrl = nextMatch ? nextMatch[1]! : null;
  }
  return items;
}

/** Sync a user's verified GitHub organizations & teams using an OAuth token with `read:org`. */
export async function syncGitHubOrgGroups(
  env: Env,
  subject: string,
  accountId: string,
  accessToken: string,
  now = Date.now(),
): Promise<{ groups: string[]; departed: string[] }> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Tendriller' };
  const [orgs, teams] = await Promise.all([
    fetchGitHubPaginated<{ login?: string }>('https://api.github.com/user/orgs?per_page=100', headers, { required: true }),
    fetchGitHubPaginated<{ slug?: string; name?: string; organization?: { login?: string } }>('https://api.github.com/user/teams?per_page=100', headers),
  ]);

  const nextGroups = new Map<string, string>();
  for (const org of Array.isArray(orgs) ? orgs : []) {
    if (typeof org?.login !== 'string') continue;
    const id = `github-org:${org.login.toLowerCase()}`;
    if (GROUP_ID_RE.test(id)) nextGroups.set(id, org.login);
  }
  for (const team of Array.isArray(teams) ? teams : []) {
    const orgLogin = team?.organization?.login;
    const slug = team?.slug;
    if (typeof orgLogin !== 'string' || typeof slug !== 'string') continue;
    const id = `github-team:${orgLogin.toLowerCase()}/${slug.toLowerCase()}`;
    if (GROUP_ID_RE.test(id)) nextGroups.set(id, team.name ? `${orgLogin}/${team.name}` : `${orgLogin}/${slug}`);
  }

  const prevRows = await env.ACCOUNTS.prepare("SELECT group_id FROM identity_groups WHERE provider = 'github' AND subject = ?")
    .bind(subject).all<{ group_id: string }>();
  const departed = prevRows.results.map(r => r.group_id).filter(g => !nextGroups.has(g));

  const expiresAt = now + GITHUB_GROUP_TTL_MS;
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare("DELETE FROM identity_groups WHERE provider = 'github' AND subject = ?").bind(subject),
    ...[...nextGroups.entries()].map(([groupId, displayName]) =>
      env.ACCOUNTS.prepare(`INSERT INTO identity_groups (provider, subject, account_id, group_id, display_name, verified_at, expires_at)
        VALUES ('github', ?, ?, ?, ?, ?, ?)`).bind(subject, accountId, groupId, displayName, now, expiresAt),
    ),
  ]);

  if (departed.length > 0) {
    await propagateOrgDepartures(env, accountId, departed, now);
  }
  return { groups: [...nextGroups.keys()], departed };
}

/** Active, non-expired verified group IDs for an account. */
export async function accountVerifiedGroups(env: Env, accountId: string, now = Date.now()): Promise<string[]> {
  if (!env.ACCOUNTS) return [];
  const rows = await env.ACCOUNTS.prepare('SELECT DISTINCT group_id FROM identity_groups WHERE account_id = ? AND expires_at > ?')
    .bind(accountId, now).all<{ group_id: string }>().catch(() => ({ results: [] }));
  return rows.results.map(r => r.group_id);
}

/** Validate an admin-signed PageGroupPolicy against the page's current Chronolog v2 `$permissions`. */
export async function validateSignedGroupPolicy(
  t: Tendril,
  state: MaterializedControlState,
  signed: Signed<PageGroupPolicy>,
): Promise<PageGroupPolicy> {
  if (!signed || typeof signed !== 'object' || !signed.payload || typeof signed.signer !== 'string' || typeof signed.signature !== 'string') {
    throw new HttpError(400, 'invalid_group_policy', 'Group policy must be a signed record');
  }
  await verifyRecord(GROUP_POLICY_DOMAIN, signed);
  if (!state.permissions.administrators.has(signed.signer)) {
    throw new HttpError(403, 'administrator_required', 'Group policy must be signed by a current page administrator');
  }
  const p = signed.payload;
  const app = selectedApplication(t);
  if (p.pageId !== t.tid || p.applicationId !== app.id) {
    throw new HttpError(409, 'group_policy_scope_mismatch', 'Group policy pageId or applicationId does not match this page');
  }
  if (!Number.isSafeInteger(p.revision) || p.revision < 0 || !Array.isArray(p.rules) || p.rules.length > 32) {
    throw new HttpError(400, 'invalid_group_policy', 'Group policy requires a valid revision and at most 32 rules');
  }
  const existing = t.db.get<Signed<PageGroupPolicy> | null>('group_policy', null);
  if (existing && p.revision <= existing.payload.revision) {
    throw new HttpError(409, 'group_policy_stale', `Group policy revision must exceed current revision ${existing.payload.revision}`);
  }
  const seenIds = new Set<string>();
  for (const rule of p.rules) {
    if (!rule || typeof rule !== 'object' || !RULE_ID_RE.test(rule.ruleId ?? '') || seenIds.has(rule.ruleId)) {
      throw new HttpError(400, 'invalid_group_rule', 'Each group rule requires a unique lowercase ruleId');
    }
    seenIds.add(rule.ruleId);
    normalizeGroupId(rule.group);
    if (rule.role !== 'reader' && rule.role !== 'writer' && rule.role !== 'admin') {
      throw new HttpError(400, 'invalid_group_rule', 'Group rule role must be reader, writer, or admin');
    }
  }
  return p;
}

export function readPageGroupPolicy(t: Tendril): Signed<PageGroupPolicy> | null {
  return t.db.get<Signed<PageGroupPolicy> | null>('group_policy', null);
}

/** Find the highest-privilege active group rule matched by `accountId` on page `t`. */
export async function matchingPageGroupRule(t: Tendril, accountId: string): Promise<PageGroupRule | null> {
  const policy = readPageGroupPolicy(t);
  if (!policy || !policy.payload.rules.length) return null;
  const groups = new Set(await accountVerifiedGroups(t.env, accountId, t.now()));
  const rank: Record<GroupRole, number> = { reader: 1, writer: 2, admin: 3 };
  let best: PageGroupRule | null = null;
  for (const rule of policy.payload.rules) {
    if (groups.has(rule.group.toLowerCase())) {
      if (!best || rank[rule.role] > rank[best.role]) best = rule;
    }
  }
  return best;
}

/** Issue and store a companion host-signed group attestation alongside standard device attestation. */
export async function maybeSignGroupAttestation(
  t: Tendril,
  input: { accountId: string; publicKey: string; wrapKey: string },
): Promise<Signed<GroupAttestationPayload> | null> {
  const rule = await matchingPageGroupRule(t, input.accountId);
  if (!rule) return null;
  const host = await requireHostAttestationIdentity(t.env);
  const now = t.now();
  const signed = await signRecord(GROUP_ATTESTATION_DOMAIN, {
    pageId: t.tid,
    applicationId: selectedApplication(t).id,
    accountId: input.accountId,
    publicKey: input.publicKey,
    wrapKey: input.wrapKey,
    group: rule.group.toLowerCase(),
    ruleId: rule.ruleId,
    role: rule.role,
    issuedAt: now,
    expiresAt: now + GROUP_ATTESTATION_TTL_MS,
  } satisfies GroupAttestationPayload, host);

  const map = t.db.get<Record<string, Signed<GroupAttestationPayload>>>('group_attestations', {});
  const updated = { ...map, [input.publicKey]: signed };
  // Prune expired
  for (const [k, v] of Object.entries(updated)) {
    if (v.payload.expiresAt <= now) delete updated[k];
  }
  t.db.set('group_attestations', updated);
  t.db.set(`org_member:${input.accountId}`, {
    accountId: input.accountId,
    group: rule.group.toLowerCase(),
    ruleId: rule.ruleId,
    role: rule.role,
    joinedAt: now,
  } satisfies StoredOrgMember);
  return signed;
}

/** Seamless zero-trust offboarding on a single Tendril DO when `accountId` leaves `departedGroups`. */
export async function enforceOrgDepartureOnPage(
  t: Tendril,
  input: { accountId: string; departedGroups: string[]; observedAbsentAt?: number },
): Promise<{ gated: boolean; departures: Signed<OrgDeparturePayload>[] }> {
  const owner = t.db.get<string | null>('owner_account', null);
  // Guardrail: org departure NEVER revokes the page owner.
  if (!input.accountId || input.accountId === owner) return { gated: false, departures: [] };

  const orgMember = t.db.get<StoredOrgMember | null>(`org_member:${input.accountId}`, null);
  const policy = readPageGroupPolicy(t);
  const departedSet = new Set(input.departedGroups.map(g => g.toLowerCase()));

  // Check if the user still matches ANY remaining active group rule on this page.
  const stillMatched = await matchingPageGroupRule(t, input.accountId);
  if (stillMatched) return { gated: false, departures: [] };

  // Also check if the user has a separate explicit individual guest invite (non-org link).
  const individualGuest = t.db.one<{ x: number }>(
    "SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND approved = 1 AND link_id != '__org__'",
    input.accountId,
  );
  if (individualGuest) return { gated: false, departures: [] };

  const affectedGroup = orgMember && departedSet.has(orgMember.group)
    ? orgMember.group
    : policy?.payload.rules.find(r => departedSet.has(r.group.toLowerCase()))?.group.toLowerCase() ?? departedSet.values().next().value;
  if (!affectedGroup) return { gated: false, departures: [] };
  const affectedRuleId = orgMember?.ruleId
    ?? policy?.payload.rules.find(r => r.group.toLowerCase() === affectedGroup)?.ruleId
    ?? 'org';

  // Layer 1: Immediate host access gate (revoke page sessions, org guest access, and close live WebSockets).
  t.transaction(() => {
    t.db.del(`org_member:${input.accountId}`);
    t.db.run('DELETE FROM page_sessions WHERE account_id = ?', input.accountId);
    t.db.run("DELETE FROM guest_accounts WHERE account_id = ? AND link_id = '__org__'", input.accountId);
  });
  for (const ws of t.ctx.getWebSockets()) {
    const att = ws.deserializeAttachment() as { principal?: { accountId?: string } } | null;
    if (att?.principal?.accountId === input.accountId) {
      try { ws.close(4001, 'Organization membership ended'); } catch { /* gone */ }
    }
  }

  // Layer 2: Sign host departure attestations for every Chronolog member device key associated with this account
  // (excluding genesis administrators and individually invited members).
  const state = await readControlState(t);
  const signedDepartures: Signed<OrgDeparturePayload>[] = [];
  if (state) {
    const genesisAdmins = new Set(
      ((state.genesis.initialTopics.$permissions as { members?: Array<{ publicKey: string; administrator?: boolean }> } | undefined)?.members ?? [])
        .filter(m => m.administrator)
        .map(m => m.publicKey),
    );
    const attestations = t.db.get<Record<string, Signed<GroupAttestationPayload>>>('group_attestations', {});
    const accountKeys = new Set(
      Object.values(attestations)
        .filter(a => a.payload.accountId === input.accountId)
        .map(a => a.payload.publicKey),
    );
    const targetKeys = state.permissions.members
      .map(m => m.publicKey)
      .filter(pk => !genesisAdmins.has(pk) && accountKeys.has(pk));

    if (targetKeys.length > 0) {
      const host = await requireHostAttestationIdentity(t.env);
      const observedAbsentAt = input.observedAbsentAt ?? t.now();
      const existing = t.db.get<Record<string, Signed<OrgDeparturePayload>>>('org_departures', {});
      const nextMap = { ...existing };
      const appId = selectedApplication(t).id;
      for (const publicKey of targetKeys) {
        const dep = await signRecord(ORG_DEPARTURE_DOMAIN, {
          pageId: t.tid,
          applicationId: appId,
          accountId: input.accountId,
          publicKey,
          group: affectedGroup,
          ruleId: affectedRuleId,
          observedAbsentAt,
        } satisfies OrgDeparturePayload, host);
        nextMap[publicKey] = dep;
        signedDepartures.push(dep);
      }
      t.db.set('org_departures', nextMap);
    }
  }

  addActivity(t, {
    kind: 'org_departure',
    summary: `Gated access & queued key rotation after member left ${affectedGroup}`,
    by: 'host:org-sync',
  });
  notifyDiscoveryWatchers(t);
  return { gated: true, departures: signedDepartures };
}

/** Fan out org departure notifications from D1 `page_group_rules` to every affected page DO. */
export async function propagateOrgDepartures(env: Env, accountId: string, departedGroups: string[], now = Date.now()): Promise<number> {
  if (!env.ACCOUNTS || !departedGroups.length) return 0;
  const placeholders = departedGroups.map(() => '?').join(',');
  const rows = await env.ACCOUNTS.prepare(`SELECT DISTINCT page_id FROM page_group_rules WHERE group_id IN (${placeholders})`)
    .bind(...departedGroups.map(g => g.toLowerCase())).all<{ page_id: string }>().catch(() => ({ results: [] }));
  let notified = 0;
  for (const row of rows.results) {
    if (!TENDRIL_ID_RE.test(row.page_id)) continue;
    try {
      const res = await env.TENDRIL.get(env.TENDRIL.idFromName(row.page_id)).fetch(new Request('https://tendril.internal/org-departure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tendril-id': row.page_id },
        body: JSON.stringify({ account_id: accountId, departed_groups: departedGroups, observed_absent_at: now }),
      }));
      await res.body?.cancel();
      if (res.ok) notified++;
    } catch { /* best-effort per page */ }
  }
  return notified;
}

/** Service-origin routes for verified groups & GitHub org departure webhooks. */
export async function routeGroupsApi(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const m = req.method;

  if (path === '/api/account/groups' && (m === 'GET' || m === 'HEAD')) {
    const session = await serviceSession(req, env);
    if (!session) throw new HttpError(401, 'unauthorized', 'Sign in first');
    const rows = await env.ACCOUNTS.prepare('SELECT provider, group_id, display_name, verified_at, expires_at FROM identity_groups WHERE account_id = ? AND expires_at > ? ORDER BY group_id ASC')
      .bind(session.accountId, Date.now()).all();
    return json({ groups: rows.results });
  }

  // Inbound GitHub organization/team webhook for instant zero-click offboarding.
  if (path === '/api/webhooks/github-org' && m === 'POST') {
    const secret = env.GITHUB_ORG_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(503, 'webhook_unconfigured', 'GITHUB_ORG_WEBHOOK_SECRET is not configured');
    const sig = req.headers.get('X-Hub-Signature-256') ?? '';
    const raw = await req.arrayBuffer();
    if (!(await verifyHmacSha256(secret, raw, sig))) {
      throw new HttpError(401, 'invalid_signature', 'Invalid GitHub webhook signature');
    }
    const event = req.headers.get('X-GitHub-Event') ?? '';
    const payload = JSON.parse(new TextDecoder().decode(raw)) as {
      action?: string;
      organization?: { login?: string };
      team?: { slug?: string };
      membership?: { user?: { id?: number } };
      member?: { id?: number };
    };
    const orgLogin = payload.organization?.login?.toLowerCase();
    const ghUserId = payload.membership?.user?.id ?? payload.member?.id;
    if (!orgLogin || !Number.isSafeInteger(ghUserId)) {
      return json({ ignored: true, event });
    }
    const departed: string[] = [];
    if (event === 'organization' && payload.action === 'member_removed') {
      departed.push(`github-org:${orgLogin}`);
    } else if (event === 'membership' && payload.action === 'removed' && payload.team?.slug) {
      departed.push(`github-team:${orgLogin}/${payload.team.slug.toLowerCase()}`);
    } else {
      return json({ ignored: true, event, action: payload.action ?? null });
    }

    const identity = await env.ACCOUNTS.prepare("SELECT account_id FROM identities WHERE provider = 'github' AND subject = ?")
      .bind(String(ghUserId)).first<{ account_id: string }>();
    if (!identity) return json({ handled: false, reason: 'unknown_identity' });

    if (event === 'organization' && payload.action === 'member_removed') {
      // Leaving an org also removes all teams under that org.
      const teamRows = await env.ACCOUNTS.prepare("SELECT group_id FROM identity_groups WHERE provider = 'github' AND subject = ? AND group_id LIKE ?")
        .bind(String(ghUserId), `github-team:${orgLogin}/%`).all<{ group_id: string }>();
      for (const r of teamRows.results) departed.push(r.group_id);
      await env.ACCOUNTS.prepare("DELETE FROM identity_groups WHERE provider = 'github' AND subject = ? AND (group_id = ? OR group_id LIKE ?)")
        .bind(String(ghUserId), `github-org:${orgLogin}`, `github-team:${orgLogin}/%`).run();
    } else {
      await env.ACCOUNTS.prepare("DELETE FROM identity_groups WHERE provider = 'github' AND subject = ? AND group_id = ?")
        .bind(String(ghUserId), departed[0]).run();
    }

    const pages = await propagateOrgDepartures(env, identity.account_id, departed);
    return json({ handled: true, departed, pages_notified: pages });
  }

  return null;
}

/** Page-local group policy, companion group attestations, and pending org departures (`_tendril/groups*`). */
export async function handlePageGroups(t: Tendril, req: Request, sub: string, principal: PagePrincipal): Promise<Response> {
  const m = req.method;
  const now = t.now();

  if (sub === 'groups' && (m === 'GET' || m === 'HEAD')) {
    if (!principal.accountId && principal.role !== 'owner') throw new HttpError(403, 'forbidden');
    const policy = readPageGroupPolicy(t);
    const attestations = t.db.get<Record<string, Signed<GroupAttestationPayload>>>('group_attestations', {});
    const activeAttestations = Object.values(attestations).filter(a => a.payload.expiresAt > now);
    const departures = Object.values(t.db.get<Record<string, Signed<OrgDeparturePayload>>>('org_departures', {}));
    return json({
      policy,
      group_attestations: activeAttestations,
      departures,
    }, 200, { 'Cache-Control': 'no-store' });
  }

  if (sub === 'groups/policy' && m === 'PUT') {
    if (!allows(principal, 'page.owner') && principal.role !== 'guest') throw new HttpError(403, 'forbidden');
    const owner = t.db.get<string | null>('owner_account', null);
    const state = await readControlState(t);
    if (!state) throw new HttpError(409, 'page_uninitialized', 'Initialize page authority before setting group admission rules');
    const b = await readJson(req, 64 * 1024);
    if (!isPlainObject(b) || !isPlainObject(b.policy)) throw new HttpError(400, 'bad_request', 'Signed policy object is required');
    const signed = b.policy as unknown as Signed<PageGroupPolicy>;
    const verified = await validateSignedGroupPolicy(t, state, signed);
    if (verified.rules.length > 0 && owner) {
      await requireTeamOrgEntitlement(t.env, owner);
    }

    t.transaction(() => {
      t.db.set('group_policy', signed);
    });

    // Mirror active rules to D1 `page_group_rules` for fast webhook & departure lookup.
    await t.env.ACCOUNTS.batch([
      t.env.ACCOUNTS.prepare('DELETE FROM page_group_rules WHERE page_id = ?').bind(t.tid),
      ...verified.rules.map(rule =>
        t.env.ACCOUNTS.prepare('INSERT INTO page_group_rules (page_id, rule_id, group_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(t.tid, rule.ruleId, rule.group.toLowerCase(), rule.role, now),
      ),
    ]);

    addActivity(t, {
      kind: 'group_policy',
      summary: `Updated org/group admission policy (${verified.rules.length} rule${verified.rules.length === 1 ? '' : 's'})`,
      by: principal.accountId ? `${principal.role}:${principal.accountId}` : `admin:${signed.signer.slice(0, 12)}`,
    });
    notifyDiscoveryWatchers(t);
    return json({ policy: signed });
  }

  const ackMatch = /^groups\/departures\/([a-f0-9]{64})\/ack$/.exec(sub);
  if (ackMatch && m === 'POST') {
    const pk = ackMatch[1]!;
    const state = await readControlState(t);
    const stillMember = state?.permissions.members.some(mem => mem.publicKey === pk) ?? false;
    if (stillMember) {
      throw new HttpError(409, 'member_still_present', 'Cannot clear departure until Chronolog membership removes this device key');
    }
    const existing = t.db.get<Record<string, Signed<OrgDeparturePayload>>>('org_departures', {});
    if (existing[pk]) {
      const next = { ...existing };
      delete next[pk];
      t.db.set('org_departures', next);
    }
    return json({ cleared: true, publicKey: pk });
  }

  throw new HttpError(404, 'not_found');
}
