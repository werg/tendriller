/** Test-only public fixture; never included in the deployed Worker graph. */
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { api, create, inDO, ownerHeaders, req } from './helpers';
import { sha256Hex } from '../src/ids';
import { PEER_RENDEZVOUS_PROTOCOL } from '../../contract/peers.mjs';
import { testRendezvousSocket, type TestHostTraffic } from './fixture-rendezvous';

export async function initializeTestService(migrations: Parameters<typeof applyD1Migrations>[1]): Promise<void> {
  await applyD1Migrations(env.ACCOUNTS, migrations);
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run();
}

/** Fresh synthetic identities exercise the real session and module authorization paths. */
export async function createTestPage(options: { application?: { kind: 'cloudflare' | 'peer'; id: string }; lifetime?: 'ad_hoc' | 'resident' } = {}) {
  const { lifetime, ...selection } = options;
  const handle = await create({ mode: 'dashboard', listener: false, ...selection });
  if (lifetime === 'resident') {
    const response = await api(handle, 'PATCH', '', { lifetime });
    if (!response.ok) throw new Error(`Resident test page setup failed: ${response.status} ${await response.text()}`);
  }
  const traffic: TestHostTraffic = { httpRequests: 0, requestBodyBytes: 0, rendezvousUpgrades: 0, rendezvousSentBytes: 0, rendezvousReceivedBytes: 0 };
  const request = (url: string, init: RequestInit) => {
    traffic.httpRequests++;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') traffic.requestBodyBytes += new TextEncoder().encode(init.body).byteLength;
      else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) traffic.requestBodyBytes += init.body.byteLength;
      else throw new TypeError('The public test fixture accepts JSON, text or binary request bodies');
    }
    if (new Headers(init.headers).get('Upgrade')?.toLowerCase() === 'websocket') traffic.rendezvousUpgrades++;
    return req(url, init);
  };
  const pageApi = (url: string, headers: Record<string, string>) => (method: string, path: string, body?: unknown) => request(
    `${url}_tendril/${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const workflow = (url: string, headers: Record<string, string>) =>
    (module: string, operation: string, data: unknown = {}, guards: Record<string, string> = {}, cid = crypto.randomUUID()) => request(
      `${url}workflows/${encodeURIComponent(module)}/${encodeURIComponent(operation)}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid, expected_generations: guards, data }),
      },
    );
  const owner = workflow(handle.page_url + '_tendril/', ownerHeaders(handle.page_url));
  const agentApi = (method: string, path: string, body?: unknown) => {
    const raw = typeof body === 'string' || body instanceof ArrayBuffer || body instanceof Uint8Array;
    return request(`${handle.api}${path ? '/' + path : ''}`, {
      method, headers: { Authorization: `Bearer ${handle.token}`, ...(body === undefined || raw ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: raw ? body as BodyInit : JSON.stringify(body) }),
    });
  };
  const agent = (module: string, operation: string, data: unknown = {}, guards: Record<string, string> = {}, cid = crypto.randomUUID()) =>
    agentApi('POST', `workflows/${encodeURIComponent(module)}/${encodeURIComponent(operation)}`, { cid, expected_generations: guards, data });
  const rendezvous = (base: string, headers: Record<string, string>) => (channel: string, peerId: string) => testRendezvousSocket(() => request(
    `${base}peers/rendezvous?${new URLSearchParams({ channel, peerId })}`, { headers: { ...headers, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_RENDEZVOUS_PROTOCOL } }), traffic);
  return {
    owner, agent,
    /** Exact observed requests/frame bytes, excluding synthetic identity/page setup. */
    get hostTraffic() { return Object.freeze({ ...traffic }); },
    rendezvousSocket: rendezvous(handle.api + '/', { Authorization: `Bearer ${handle.token}` }),
    ownerRendezvousSocket: rendezvous(handle.page_url + '_tendril/', ownerHeaders(handle.page_url)),
    ownerApi: pageApi(handle.page_url, ownerHeaders(handle.page_url)),
    api: agentApi,
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
      return { account, call: workflow(link.url + '_tendril/', headers), api: pageApi(link.url, headers),
        rendezvousSocket: rendezvous(link.url + '_tendril/', headers) };
    },
    async display() {
      const link = await inDO(handle.id, async t => t.renderLink(await t.createLink('display', 'test display', null)));
      return workflow(link.url + '_tendril/', { Cookie: '', Origin: new URL(link.url).origin });
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
