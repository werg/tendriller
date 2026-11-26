// CLI commands for Issue #136 outbound OAuth connections:
//   tendril connection providers [--server URL]
//   tendril connection connect <provider> --tier agent-held|host-brokered [--custody personal|page] [--scopes s1,s2] [--actions a1,a2] [--page SLUG] [--label TEXT]
//   tendril connection list
//   tendril connection pull
//   tendril connection revoke <id>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unsealAgentTokens } from '@tendriller/core/connections';

async function agentFetch(workspace, path, { method = 'GET', body, signal } = {}) {
  const cred = await workspace.credential();
  const base = cred.service.replace(/\/+$/u, '');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cred.token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status} from ${path}`);
    err.code = data?.error?.code || 'request_failed';
    throw err;
  }
  return data;
}

export async function listProviders(serviceOrigin, signal) {
  const base = serviceOrigin.replace(/\/+$/u, '');
  const res = await fetch(`${base}/api/oauth/providers`, { signal });
  if (!res.ok) throw new Error(`Could not load OAuth providers (${res.status})`);
  return res.json();
}

export async function connectProvider(workspace, provider, flags, signal) {
  const tier = flags.tier || 'agent-held';
  const custody = flags.custody || 'personal';
  const payload = {
    provider,
    tier,
    custody,
    ...(flags.label ? { label: flags.label } : {}),
    ...(flags.scopes ? { scopes: String(flags.scopes).split(',').map(s => s.trim()).filter(Boolean) } : {}),
    ...(flags.actions ? { actions: String(flags.actions).split(',').map(s => s.trim()).filter(Boolean) } : {}),
  };
  if (flags.page) {
    const page = await workspace.page(flags.page);
    payload.page_id = page.id;
  }
  return agentFetch(workspace, '/api/agent/connections/connect', { method: 'POST', body: payload, signal });
}

export async function listConnections(workspace, signal) {
  return agentFetch(workspace, '/api/agent/connections', { signal });
}

/**
 * Unseal any pending X25519 handoff envelopes using the workspace's private wrapKey:
 * - Tier A (`agent-held`): unseals OAuth tokens directly to `.tendriller/private/connections/<id>.json` (0600).
 * - Tier B (`host-brokered`): unseals `connection_key` (`K_conn`) to `.tendriller/private/connections/<id>.json` (0600)
 *   so the agent can invoke `/api/agent/connections/<id>/invoke` with zero manual copy-paste.
 * Calls `/ack` so the host immediately wipes the ephemeral sealed handoff envelope.
 */
export async function pullAgentConnections(workspace, signal) {
  const { connections } = await listConnections(workspace, signal);
  const wrap = await workspace.wrapKey();
  const cred = await workspace.credential();
  const dir = join(workspace.paths.secret, 'connections');
  const pulled = [];

  for (const conn of connections ?? []) {
    if (!conn.sealed_handoff) continue;
    const aad = `${conn.id}:${cred.agentId}:${conn.provider}`;
    const payload = await unsealAgentTokens(wrap.privateKey, wrap.publicKey, conn.sealed_handoff, aad);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${conn.id}.json`);
    const record = conn.tier === 'host-brokered'
      ? {
          id: conn.id,
          provider: conn.provider,
          tier: conn.tier,
          custody: conn.custody,
          label: conn.label,
          scopes: conn.scopes,
          actions: conn.actions,
          external_label: conn.external_label,
          connection_key: payload.connection_key,
          saved_at: Date.now(),
        }
      : {
          id: conn.id,
          provider: conn.provider,
          tier: conn.tier,
          label: conn.label,
          scopes: conn.scopes,
          external_label: conn.external_label,
          tokens: payload,
          saved_at: Date.now(),
        };
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await agentFetch(workspace, `/api/agent/connections/${encodeURIComponent(conn.id)}/ack`, { method: 'POST', signal });
    pulled.push({ id: conn.id, provider: conn.provider, tier: conn.tier, path: file });
  }
  return { pulled };
}

export async function revokeConnection(workspace, id, signal) {
  return agentFetch(workspace, `/api/agent/connections/${encodeURIComponent(id)}/revoke`, { method: 'POST', signal });
}
