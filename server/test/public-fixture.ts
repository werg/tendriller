/** Test-only public fixture; never included in the deployed Worker graph. */
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { api, create, inDO, ownerHeaders, req } from './helpers';
import { sha256Hex } from '../src/ids';
import { PEER_RENDEZVOUS_PROTOCOL, PEER_INVITATION_PROTOCOL, PEER_RELAY_PROTOCOL } from '../../contract/peers.mjs';
import { participantMessage, participantPayload } from './peer-exchange';
import { testPeerSocket, type TestHostTraffic } from './fixture-peer-socket';

export async function initializeTestService(migrations: Parameters<typeof applyD1Migrations>[1]): Promise<void> {
  await applyD1Migrations(env.ACCOUNTS, migrations);
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run();
}

/** Fresh synthetic identities exercise the real session and module authorization paths. */
export async function createTestPage(options: { application?: { id: string }; lifetime?: 'ad_hoc' | 'resident' } = {}) {
  const { lifetime, ...selection } = options;
  const handle = await create({ mode: 'dashboard', listener: false, ...selection });
  if (lifetime === 'resident') {
    const response = await api(handle, 'PATCH', '', { lifetime });
    if (!response.ok) throw new Error(`Resident test page setup failed: ${response.status} ${await response.text()}`);
  }
  const applicationId = (await inDO(handle.id, t => t.db.get<{ id: string }>('application', { id: '' }))).id;
  const traffic: TestHostTraffic = { httpRequests: 0, requestBodyBytes: 0, rendezvousUpgrades: 0, rendezvousSentBytes: 0, rendezvousReceivedBytes: 0,
    invitationUpgrades: 0, invitationSentBytes: 0, invitationReceivedBytes: 0, relayUpgrades: 0, relaySentBytes: 0, relayReceivedBytes: 0 };
  const request = (url: string, init: RequestInit) => {
    traffic.httpRequests++;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') traffic.requestBodyBytes += new TextEncoder().encode(init.body).byteLength;
      else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) traffic.requestBodyBytes += init.body.byteLength;
      else throw new TypeError('The public test fixture accepts JSON, text or binary request bodies');
    }
    if (new Headers(init.headers).get('Upgrade')?.toLowerCase() === 'websocket')
      traffic[new URL(url).pathname.endsWith('/peers/invitations') ? 'invitationUpgrades' : new URL(url).pathname.endsWith('/peers/relay') ? 'relayUpgrades' : 'rendezvousUpgrades']++;
    return req(url, init);
  };
  const pageApi = (url: string, headers: Record<string, string>) => (method: string, path: string, body?: unknown) => request(
    `${url}_tendril/${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const exchange = (send: (method: string, path: string, body?: unknown) => Promise<Response>) => async (operation: string, payload: unknown = {}) =>
    participantPayload(await send('POST', 'peers/participant', participantMessage(applicationId, operation, payload)));
  const agentApi = (method: string, path: string, body?: unknown) => {
    const raw = typeof body === 'string' || body instanceof ArrayBuffer || body instanceof Uint8Array;
    return request(`${handle.api}${path ? '/' + path : ''}`, {
      method, headers: { Authorization: `Bearer ${handle.token}`, ...(body === undefined || raw ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: raw ? body as BodyInit : JSON.stringify(body) }),
    });
  };
  const rendezvous = (base: string, headers: Record<string, string>) => (channel: string, peerId: string) => testPeerSocket(() => request(
    `${base}peers/rendezvous?${new URLSearchParams({ channel, peerId })}`, { headers: { ...headers, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_RENDEZVOUS_PROTOCOL } }), traffic, 'rendezvous');
  const invitations = (base: string, headers: Record<string, string>) => (peerId: string) => testPeerSocket(() => request(
    `${base}peers/invitations?${new URLSearchParams({ peerId })}`, { headers: { ...headers, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_INVITATION_PROTOCOL } }), traffic, 'invitation');
  const relay = (base: string, headers: Record<string, string>) => (channel: string, peerId: string, remotePeerId: string, lane: 'reliable' | 'live', extra: Record<string, string> = {}) => testPeerSocket(() => request(
    `${base}peers/relay?${new URLSearchParams({ channel, peerId, remotePeerId, lane, ...extra })}`, { headers: { ...headers, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_RELAY_PROTOCOL } }), traffic, 'relay');
  return {
    /** Exact observed requests/frame bytes, excluding synthetic identity/page setup. */
    get hostTraffic() { return Object.freeze({ ...traffic }); },
    rendezvousSocket: rendezvous(handle.api + '/', { Authorization: `Bearer ${handle.token}` }),
    ownerRendezvousSocket: rendezvous(handle.page_url + '_tendril/', ownerHeaders(handle.page_url)),
    invitationSocket: invitations(handle.api + '/', { Authorization: `Bearer ${handle.token}` }),
    ownerInvitationSocket: invitations(handle.page_url + '_tendril/', ownerHeaders(handle.page_url)),
    relaySocket: relay(handle.api + '/', { Authorization: `Bearer ${handle.token}` }),
    ownerRelaySocket: relay(handle.page_url + '_tendril/', ownerHeaders(handle.page_url)),
    ownerApi: pageApi(handle.page_url, ownerHeaders(handle.page_url)),
    api: agentApi,
    exchange: exchange(agentApi),
    ownerExchange: exchange(pageApi(handle.page_url, ownerHeaders(handle.page_url))),
    asset(path = '') {
      if (path.startsWith('/') || /^[a-z]+:/i.test(path) || path.split('/').includes('..') || /[?#\\]/.test(path)) throw new TypeError('Expected a relative asset path');
      return request(new URL(path, handle.page_url).href, { method: 'GET', headers: ownerHeaders(handle.page_url) });
    },
    async participant() {
      const account = crypto.randomUUID(), secret = crypto.randomUUID();
      await env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(account, Date.now(), `${account}@example.test`).run();
      const link = await inDO(handle.id, async t => {
        const invitation = await t.createLink('guest', 'test participant', null);
        t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)', account, invitation.id, t.now());
        t.db.run('INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,?,?)', await sha256Hex(secret), account, 'guest', t.now() + 86400_000);
        return t.renderLink(invitation);
      });
      const headers = { Cookie: `__Host-tendril=${secret}`, Origin: new URL(link.url).origin };
      return { account, api: pageApi(link.url, headers), exchange: exchange(pageApi(link.url, headers)),
        rendezvousSocket: rendezvous(link.url + '_tendril/', headers), invitationSocket: invitations(link.url + '_tendril/', headers),
        relaySocket: relay(link.url + '_tendril/', headers) };
    },
    async advance(milliseconds: number) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError('Advance by a finite nonnegative duration');
      await inDO(handle.id, t => { t.skew += milliseconds; });
    },
    async restart() {
      // Exercise crash recovery, including a caller that lost an HTTP body.
      // Graceful eviction would wait for that caller's unread response to drain.
      let requested = false;
      try { await inDO(handle.id, t => { requested = true; t.ctx.abort('Public test fixture restart'); }); }
      catch (error) { if (!requested) throw error; }
    },
  };
}
