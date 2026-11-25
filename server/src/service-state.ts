import type { Env } from "./env";
import { HttpError } from "./http";
import { serviceIdentity } from './service-identity';
import { hostAttestationKey, loadHostAttestationIdentity } from './host-attestation';
import ipaddr from "ipaddr.js";

export type ServiceMode = "open" | "creation_paused" | "read_only";

export async function serviceMode(env: Env): Promise<ServiceMode> {
  const row = await env.ACCOUNTS.prepare("SELECT mode FROM service_state WHERE id = 1").first<{ mode: ServiceMode }>();
  if (!row || !["open", "creation_paused", "read_only"].includes(row.mode)) {
    throw new HttpError(503, "unavailable", "Service state is not initialized");
  }
  return row.mode;
}

/** Device and agent admission need a valid host attestation key; pages pin its public key. */
async function attestationReadiness(env: Env) {
  const available = await loadHostAttestationIdentity(env) !== null;
  return { available, key: available ? hostAttestationKey(env) : null, code: available ? null : 'attestation_unconfigured' as const,
    nextAction: available ? null : 'Ask the operator to install the HOST_ATTESTATION_KEY Worker secret (docs/OPERATIONS.md); browser and agent enrollment are unavailable until then.' };
}

/** An advisory service-level preflight; creation still checks live state and admission. */
export async function serviceReadiness(env: Env) {
  const identity = serviceIdentity(env), origin = identity.serviceOrigin;
  let mode: ServiceMode | 'unavailable';
  try { mode = await serviceMode(env); }
  catch { mode = 'unavailable'; }
  const available = mode === 'open';
  return {
    schemaVersion: 1,
    ...identity,
    mode,
    creation: {
      available,
      code: available ? null : mode === 'unavailable' ? 'unavailable' : 'creation_paused',
      message: available ? 'New page creation is enabled; each request still checks current availability and admission.'
        : mode === 'unavailable' ? 'Service readiness could not be established.' : 'New tendrils are temporarily paused.',
      nextAction: available ? `Continue setup on ${origin}; the creation request will recheck current service state.`
        : mode === 'unavailable'
          ? `Stop new-app setup before downloading or installing packages. Ask the operator to restore readiness at ${origin}. Keep this service origin; do not fall back to another host.`
          : `Stop new-app setup before downloading or installing packages. Ask the operator to enable page creation at ${origin}. Do not repeatedly retry creation or fall back to another host.`,
    },
    writes: {
      available: mode === 'open' || mode === 'creation_paused',
      code: mode === 'unavailable' ? 'unavailable' : mode === 'read_only' ? 'read_only' : null,
    },
    attestation: await attestationReadiness(env),
    readinessUrl: origin + '/api/readiness',
    statusUrl: origin + '/status',
    checkedAt: new Date().toISOString(),
  };
}

export type ServiceReadiness = Awaited<ReturnType<typeof serviceReadiness>>;

export async function requireCreationOpen(env: Env): Promise<void> {
  if (await serviceMode(env) !== "open") throw new HttpError(503, "creation_paused", "New tendrils are temporarily paused");
}

export async function requireWritesOpen(env: Env): Promise<void> {
  if (await serviceMode(env) === "read_only") throw new HttpError(503, "read_only", "Writes are temporarily paused");
}

/** Shared address policy for anonymous and account-bound creation. */
export async function checkCreationIp(env: Env, req: Request): Promise<{ ip: string; day: string }> {
  const db = env.ACCOUNTS!;
  const ip = req.headers.get("CF-Connecting-IP");
  if (!ip) throw new HttpError(503, "unavailable", "Creator address is unavailable");
  const blocked = await db.prepare("SELECT 1 FROM blocks WHERE kind = 'ip' AND value = ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(ip, Date.now()).first();
  if (blocked) throw new HttpError(403, "blocked", "Creation is unavailable from this address");
  if (ipaddr.isValid(ip)) {
    const address = ipaddr.parse(ip);
    const ranges = await db.prepare("SELECT value FROM blocks WHERE kind = 'cidr' AND (expires_at IS NULL OR expires_at > ?)")
      .bind(Date.now()).all<{ value: string }>();
    for (const range of ranges.results) {
      try {
        const network = ipaddr.parseCIDR(range.value);
        if (address.kind() === network[0].kind() && address.match(network)) {
          throw new HttpError(403, "blocked", "Creation is unavailable from this address");
        }
      } catch (error) { if (error instanceof HttpError) throw error; }
    }
  }
  return { ip, day: new Date().toISOString().slice(0, 10) };
}

/** Returns a compensation action to call if anonymous creation fails. */
export async function reserveCreationIp(env: Env, req: Request): Promise<() => Promise<void>> {
  const db = env.ACCOUNTS, { ip, day } = await checkCreationIp(env, req);
  const row = await db.prepare(`INSERT INTO creation_ip (ip, day, count) VALUES (?, ?, 1)
    ON CONFLICT(ip, day) DO UPDATE SET count = count + 1 WHERE count < 30 RETURNING count`)
    .bind(ip, day).first<{ count: number }>();
  if (!row) throw new HttpError(429, "rate_limited", "Daily creation limit reached");
  return async () => { await db.prepare("UPDATE creation_ip SET count = count - 1 WHERE ip = ? AND day = ? AND count > 0").bind(ip, day).run(); };
}
