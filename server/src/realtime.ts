/**
 * Cloudflare Realtime TURN credential minting and SFU session/track proxy for enrolled Chronolog members.
 * Media bytes stay strictly on Cloudflare's Anycast Realtime network; the Tendril DO only gates
 * membership/entitlements, tracks room membership in RAM, and records monthly egress usage.
 */
import type { Principal } from "./access";
import { participantIdentity } from "./access";
import { canConsumeMedia, getAccountEntitlements, quotaError, recordAccountUsage } from "./billing/entitlements";
import type { Env } from "./env";
import { HttpError, isPlainObject, json, readJson } from "./http";
import type { Tendril } from "./tendril";
import { publicBase } from "./urls";
import { TtlCache } from "./isolate-cache";

const DEFAULT_REALTIME_BASE = "https://rtc.live.cloudflare.com/v1";
const DEFAULT_STUN_SERVER = Object.freeze({ urls: "stun:stun.cloudflare.com:3478" });
const MAX_USAGE_REPORT_BYTES = 512 * 1024 * 1024;
const SFU_SESSION_IDLE_MS = 60 * 60 * 1000;

export interface SfuTrackRef {
  trackName: string;
  mid?: string;
  kind?: "audio" | "video" | "data";
}

interface SfuPeerEntry {
  sessionId: string;
  callId: string;
  peerId: string;
  route: string;
  tracks: SfuTrackRef[];
  createdAt: number;
  lastActivityAt: number;
  /** Server clock at the start of the next coalesced usage interval. */
  lastUsageAt: number;
  /** True when a complimentary grant was active at `lastUsageAt` (covers same-ms revocation). */
  lastUsageComplimentary: boolean;
  reportedBytes: number;
}

const sfuRooms = new WeakMap<Tendril, Map<string, SfuPeerEntry>>();

export function turnConfigured(env: Env): boolean {
  return Boolean(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN);
}

export function sfuConfigured(env: Env): boolean {
  return Boolean(env.CF_REALTIME_APP_ID && env.CF_REALTIME_API_TOKEN);
}

function realtimeBase(env: Env): string {
  return (env.CF_REALTIME_API_BASE || DEFAULT_REALTIME_BASE).replace(/\/+$/, "");
}

function roomMap(t: Tendril): Map<string, SfuPeerEntry> {
  let map = sfuRooms.get(t);
  if (!map) sfuRooms.set(t, map = new Map());
  const cutoff = t.now() - SFU_SESSION_IDLE_MS;
  for (const [id, entry] of map.entries()) {
    if (entry.lastActivityAt < cutoff) map.delete(id);
  }
  return map;
}

async function mintTurnIceServers(env: Env, ttlSeconds = 3600): Promise<Array<Record<string, unknown>>> {
  const url = `${realtimeBase(env)}/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID!)}/credentials/generate-ice-servers`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl: ttlSeconds }),
  });
  if (!res.ok) {
    throw new HttpError(502, "turn_upstream_error", `Cloudflare TURN credential request failed (${res.status})`);
  }
  const data = await res.json() as { iceServers?: unknown };
  if (Array.isArray(data.iceServers)) {
    return data.iceServers.filter((item): item is Record<string, unknown> => isPlainObject(item));
  }
  if (isPlainObject(data.iceServers)) {
    return [data.iceServers];
  }
  return [];
}

/**
 * Minted TURN credentials live 3600 seconds. One page reuses them for at most
 * 20 minutes, so every handed-out set stays valid for at least 40 minutes, and
 * the upstream mint runs at most three times an hour per page and isolate
 * instead of once per peer connection. Entitlement checks still run on every
 * request; this only avoids repeating the upstream call.
 */
const TURN_TTL_SECONDS = 3600;
const TURN_REUSE_MS = 20 * 60_000;
const turnCredentials = new TtlCache<Array<Record<string, unknown>> | null>(TURN_REUSE_MS, 0, 512);

async function pageTurnIceServers(env: Env, pageId: string): Promise<Array<Record<string, unknown>>> {
  const servers = await turnCredentials.get(`${env.CF_TURN_KEY_ID}|${pageId}`, async () => {
    const minted = await mintTurnIceServers(env, TURN_TTL_SECONDS);
    // An empty answer is not remembered, so the next request retries upstream.
    return minted.length ? minted : null;
  });
  return servers ? structuredClone(servers) : [];
}

async function sfuFetch<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  if (!sfuConfigured(env)) {
    throw new HttpError(503, "sfu_unconfigured", "Cloudflare Realtime SFU is not configured on this host.");
  }
  const url = `${realtimeBase(env)}/apps/${encodeURIComponent(env.CF_REALTIME_APP_ID!)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_REALTIME_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HttpError(502, "sfu_upstream_error", `Cloudflare Realtime SFU error (${res.status})`, {
      status: res.status,
      detail: detail.slice(0, 300),
    });
  }
  return await res.json() as T;
}

/**
 * `POST /_tendril/peers/ice` — returns STUN + optional short-lived Cloudflare TURN credentials
 * and SFU/media quota availability for the page's owner account. Never fails when quota is
 * exhausted: degrades cleanly to STUN-only so direct P2P keeps working.
 */
export async function handleRealtimeIce(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== "POST" && req.method !== "GET") throw new HttpError(405, "method_not_allowed");
  participantIdentity(t, principal);
  const ownerAccount = t.db.get<string | null>("owner_account", null);
  const origin = publicBase(t.env);
  const ent = ownerAccount ? await getAccountEntitlements(t.env, ownerAccount, t.now()) : null;

  const mediaAllowed = ent ? canConsumeMedia(ent).allowed : false;
  const hasTurn = turnConfigured(t.env) && mediaAllowed;
  const hasSfu = sfuConfigured(t.env) && Boolean(ent?.quotas.sfuEnabled) && mediaAllowed;

  let iceServers: Array<Record<string, unknown>> = [{ ...DEFAULT_STUN_SERVER }];
  let turnEnabled = false;
  if (hasTurn) {
    try {
      const minted = await pageTurnIceServers(t.env, t.tid);
      if (minted.length) {
        iceServers = [{ ...DEFAULT_STUN_SERVER }, ...minted];
        turnEnabled = true;
      }
    } catch (err) {
      console.error("TURN credential minting failed; falling back to STUN", err);
    }
  }

  return json({
    iceServers,
    turnEnabled,
    sfuAvailable: hasSfu,
    sfuConfigured: sfuConfigured(t.env),
    sfuLimits: {
      maxPeers: ent?.quotas.sfuMaxPeers ?? 0,
      maxHeight: ent?.quotas.sfuMaxHeight ?? 0,
    },
    mediaQuota: {
      plan: ent?.plan ?? "free",
      usedBytes: ent?.usage.mediaBytes ?? 0,
      limitBytes: ent?.quotas.mediaBytesPerMonth ?? null,
      paygEnabled: ent?.paygEnabled ?? false,
      withinSpendCap: ent?.overage.withinSpendCap ?? false,
      exhausted: ent ? !mediaAllowed : false,
      resetsAt: ent?.usage.resetsAt ?? null,
      upgradeUrl: `${origin}/dashboard/billing`,
      pricingUrl: `${origin}/pricing`,
      selfHostUrl: `${origin}/self-host`,
    },
  });
}

function validId(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new HttpError(400, "bad_request", "Expected a bounded identifier.");
  }
  return value;
}

/**
 * Authenticated SFU control plane (`peers/sfu/*`):
 * - `GET  peers/sfu/room?callId=...`
 * - `POST peers/sfu/sessions`
 * - `POST peers/sfu/tracks`
 * - `PUT  peers/sfu/renegotiate`
 * - `PUT  peers/sfu/close`
 * - `POST peers/sfu/usage`
 */
export async function handleRealtimeSfu(
  t: Tendril,
  req: Request,
  url: URL,
  action: string,
  principal: Principal,
): Promise<Response> {
  const { route } = participantIdentity(t, principal);
  const ownerAccount = t.db.get<string | null>("owner_account", null);
  if (!ownerAccount) {
    throw new HttpError(403, "claim_required", "Claim this page before using SFU media routing.");
  }
  const authorizedAt = t.now();
  const ent = await getAccountEntitlements(t.env, ownerAccount, authorizedAt);

  if (action === "room") {
    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
    const callId = validId(url.searchParams.get("callId") ?? "main", 64);
    const map = roomMap(t);
    const peers = [...map.values()]
      .filter(entry => entry.callId === callId)
      .map(entry => ({ sessionId: entry.sessionId, peerId: entry.peerId, tracks: entry.tracks }));
    return json({ callId, peers, maxPeers: ent.quotas.sfuMaxPeers, maxHeight: ent.quotas.sfuMaxHeight });
  }

  if (action === "usage") {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const body = await readJson(req, 8192);
    if (!isPlainObject(body)) throw new HttpError(400, "bad_request");
    const sessionId = validId(body.sessionId, 160);
    const delta = Number(body.bytesReceivedDelta ?? 0);
    if (!Number.isFinite(delta) || delta < 0 || delta > MAX_USAGE_REPORT_BYTES) {
      throw new HttpError(400, "bad_request", "Invalid media usage delta.");
    }
    const entry = roomMap(t).get(sessionId);
    if (!entry || entry.route !== route) {
      throw new HttpError(403, "forbidden", "Unknown or unowned SFU session.");
    }
    const recordedAt = t.now();
    const mediaIntervalStart = Math.min(entry.lastUsageAt, recordedAt);
    const intervalStartedComplimentary = entry.lastUsageComplimentary;
    entry.lastActivityAt = recordedAt;
    entry.lastUsageAt = recordedAt;
    entry.reportedBytes += Math.floor(delta);
    if (delta > 0) {
      // We cannot split coalesced bytes at an exact grant boundary. Waive the
      // whole interval if it overlaps complimentary access, rather than bill
      // previously authorized test traffic merely because its report was late.
      await recordAccountUsage(t.env, ownerAccount, { mediaBytes: Math.floor(delta) }, recordedAt, {
        mediaIntervalStart,
        ...(intervalStartedComplimentary ? { mediaComplimentary: true } : {}),
      });
    }
    const updated = await getAccountEntitlements(t.env, ownerAccount, t.now());
    entry.lastUsageComplimentary = Boolean(updated.premiumGrant);
    const allowed = updated.quotas.sfuEnabled && canConsumeMedia(updated).allowed;
    return json({
      ok: true,
      continueSfu: allowed,
      usedBytes: updated.usage.mediaBytes,
      limitBytes: updated.quotas.mediaBytesPerMonth,
      paygEnabled: updated.paygEnabled,
      withinSpendCap: updated.overage.withinSpendCap,
    });
  }

  // Closing an existing SFU session must always succeed even after quota is exhausted.
  if (action === "close") {
    if (req.method !== "PUT" && req.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const body = await readJson(req, 64 * 1024);
    if (!isPlainObject(body)) throw new HttpError(400, "bad_request");
    const sessionId = validId(body.sessionId, 160);
    const map = roomMap(t);
    const entry = map.get(sessionId);
    if (!entry || entry.route !== route) throw new HttpError(403, "forbidden", "Unknown or unowned SFU session.");
    const tracks = Array.isArray(body.tracks) ? body.tracks : [];
    const finalBytes = Number(body.bytesReceivedDelta ?? 0);
    if (Number.isFinite(finalBytes) && finalBytes > 0 && finalBytes <= MAX_USAGE_REPORT_BYTES) {
      const recordedAt = t.now(), mediaIntervalStart = Math.min(entry.lastUsageAt, recordedAt);
      const intervalStartedComplimentary = entry.lastUsageComplimentary;
      entry.lastUsageAt = recordedAt;
      t.ctx.waitUntil(recordAccountUsage(t.env, ownerAccount, { mediaBytes: Math.floor(finalBytes) }, recordedAt, {
        mediaIntervalStart,
        ...(intervalStartedComplimentary ? { mediaComplimentary: true } : {}),
      }));
    }
    let result: Record<string, unknown> = { ok: true };
    if (tracks.length > 0 && sfuConfigured(t.env)) {
      result = await sfuFetch<Record<string, unknown>>(
        t.env, "PUT", `/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
          tracks,
          force: body.force === true,
          ...(isPlainObject(body.sessionDescription) ? { sessionDescription: body.sessionDescription } : {}),
        },
      );
    }
    if (body.endSession !== false) map.delete(sessionId);
    return json(result);
  }

  // Remaining SFU control actions require SFU entitlement & media budget.
  if (!sfuConfigured(t.env)) {
    throw new HttpError(503, "sfu_unconfigured", "Cloudflare Realtime SFU is not configured on this host.");
  }
  if (!ent.quotas.sfuEnabled) {
    throw quotaError({
      env: t.env,
      status: 402,
      quota: "sfu",
      plan: ent.plan,
      used: 0,
      limit: 0,
      resetsAt: null,
      message: "Multi-party SFU video routing requires Pro or Team (or self-hosting with your own Cloudflare Realtime keys).",
      localAlternative: "Direct peer-to-peer WebRTC audio, video, and live captions remain free when networks permit direct connections.",
    });
  }
  if (!canConsumeMedia(ent).allowed) {
    const cap = ent.quotas.mediaBytesPerMonth ?? 0;
    const isPaygCapped = ent.paygEnabled && !ent.overage.withinSpendCap;
    throw quotaError({
      env: t.env,
      status: 429,
      quota: "media_bytes",
      plan: ent.plan,
      used: ent.usage.mediaBytes,
      limit: cap,
      resetsAt: ent.usage.resetsAt,
      message: isPaygCapped
        ? "Monthly pay-as-you-go media spend cap reached. Raise or disable your spend cap in billing settings, or fall back to direct P2P / audio-only."
        : `Monthly SFU/TURN media allowance reached on ${ent.plan}.`,
      localAlternative: "Switch to audio-only or direct P2P mesh, enable pay-as-you-go in billing, or self-host with your own Cloudflare Realtime account (1 TB/mo free).",
    });
  }

  if (action === "sessions") {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const body = await readJson(req, 64 * 1024);
    if (!isPlainObject(body)) throw new HttpError(400, "bad_request");
    const callId = validId(body.callId ?? "main", 64);
    const peerId = validId(body.peerId, 128);
    const map = roomMap(t);
    // Evict any prior stale session for the same peer/call/route on reload before checking capacity.
    for (const [oldId, existing] of map.entries()) {
      if (existing.callId === callId && existing.peerId === peerId && existing.route === route) {
        map.delete(oldId);
      }
    }
    const activeInCall = [...map.values()].filter(entry => entry.callId === callId && entry.peerId !== peerId);
    if (ent.quotas.sfuMaxPeers > 0 && activeInCall.length >= ent.quotas.sfuMaxPeers) {
      throw quotaError({
        env: t.env,
        status: 429,
        quota: "sfu",
        plan: ent.plan,
        used: activeInCall.length,
        limit: ent.quotas.sfuMaxPeers,
        resetsAt: null,
        message: `This SFU room reached its ${ent.quotas.sfuMaxPeers}-participant limit on ${ent.plan}.`,
        localAlternative: "Upgrade to Team for up to 50 SFU participants, or self-host with your own Cloudflare Realtime credentials.",
      });
    }
    const cfPayload: Record<string, unknown> = {};
    if (isPlainObject(body.sessionDescription)) cfPayload.sessionDescription = body.sessionDescription;
    const created = await sfuFetch<{ sessionId: string; sessionDescription?: unknown }>(
      t.env, "POST", "/sessions/new", Object.keys(cfPayload).length ? cfPayload : undefined,
    );
    const now = t.now();
    map.set(created.sessionId, {
      sessionId: created.sessionId,
      callId,
      peerId,
      route,
      tracks: [],
      createdAt: now,
      lastActivityAt: now,
      lastUsageAt: authorizedAt,
      lastUsageComplimentary: Boolean(ent.premiumGrant),
      reportedBytes: 0,
    });
    return json({ ...created, maxPeers: ent.quotas.sfuMaxPeers, maxHeight: ent.quotas.sfuMaxHeight }, 201);
  }

  if (action === "tracks") {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const body = await readJson(req, 128 * 1024);
    if (!isPlainObject(body)) throw new HttpError(400, "bad_request");
    const sessionId = validId(body.sessionId, 160);
    const map = roomMap(t);
    const entry = map.get(sessionId);
    if (!entry || entry.route !== route) throw new HttpError(403, "forbidden", "Unknown or unowned SFU session.");
    const tracks = Array.isArray(body.tracks) ? body.tracks : [];
    if (!tracks.length || tracks.length > 32) throw new HttpError(400, "bad_request", "Supply 1..32 track descriptors.");
    const forwardBody: Record<string, unknown> = { tracks };
    if (isPlainObject(body.sessionDescription)) forwardBody.sessionDescription = body.sessionDescription;
    const res = await sfuFetch<Record<string, unknown>>(
      t.env, "POST", `/sessions/${encodeURIComponent(sessionId)}/tracks/new`, forwardBody,
    );
    entry.lastActivityAt = t.now();
    for (const tr of tracks) {
      if (isPlainObject(tr) && tr.location === "local" && typeof tr.trackName === "string") {
        if (!entry.tracks.some(existing => existing.trackName === tr.trackName)) {
          entry.tracks.push({
            trackName: tr.trackName,
            mid: typeof tr.mid === "string" ? tr.mid : undefined,
            kind: tr.kind === "audio" || tr.kind === "video" || tr.kind === "data" ? tr.kind : undefined,
          });
        }
      }
    }
    return json(res);
  }

  if (action === "renegotiate") {
    if (req.method !== "PUT") throw new HttpError(405, "method_not_allowed");
    const body = await readJson(req, 128 * 1024);
    if (!isPlainObject(body) || !isPlainObject(body.sessionDescription)) throw new HttpError(400, "bad_request");
    const sessionId = validId(body.sessionId, 160);
    const entry = roomMap(t).get(sessionId);
    if (!entry || entry.route !== route) throw new HttpError(403, "forbidden", "Unknown or unowned SFU session.");
    entry.lastActivityAt = t.now();
    const res = await sfuFetch<Record<string, unknown>>(
      t.env, "PUT", `/sessions/${encodeURIComponent(sessionId)}/renegotiate`, { sessionDescription: body.sessionDescription },
    );
    return json(res);
  }

  throw new HttpError(404, "not_found");
}
