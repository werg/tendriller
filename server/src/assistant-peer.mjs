// Worker-owned Chronolog device. Only an enrolled signer can open application data.
import { openApplicationDevice, openPeerApplication, verifyAuthorityBundle } from '@chronolog/peer-session';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { scopedDeadline } from '../../integrations/chatgpt/common.mjs';
import { createPeersClient, createPeerIntroductions } from '../../contract/peers.mjs';

const PREFIX = 'assistant/device/';
export function assistantDeviceStore(t) {
  return {
    async get(key) {
      const value = t.db.one('SELECT value FROM participant_records WHERE key=?', PREFIX + key)?.value;
      return value ? new Uint8Array(value) : null;
    },
    async put(key, bytes) {
      t.db.run('INSERT INTO participant_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', PREFIX + key, bytes.slice().buffer);
    },
    async initialize(entries) {
      t.transaction(() => {
        for (const { key, value } of entries)
          t.db.run('INSERT OR IGNORE INTO participant_records(key,value) VALUES(?,?)', PREFIX + key, value.slice().buffer);
      });
    },
  };
}

export async function initializeAssistantDevice(t, create = false) {
  const device = await openApplicationDevice({ store: assistantDeviceStore(t), ...(create ? { create: true } : {}) });
  try { return device.identity.publicKey; } finally { await device.close(); }
}

class LocalPeerSocket extends EventTarget {
  readyState = 0;
  binaryType = 'arraybuffer';
  #socket;
  constructor(upgrade) {
    super();
    void upgrade.then(response => {
      const socket = response.webSocket;
      if (!socket) throw Error('ASSISTANT_PEER_UPGRADE_FAILED');
      this.#socket = socket;
      socket.binaryType = "arraybuffer";
      for (const event of ['message', 'close', 'error']) socket.addEventListener(event, received => {
        if (event === 'close') this.readyState = 3;
        const forwarded = event === 'message' ? new MessageEvent(event, { data: received.data })
          : event === 'close' ? new CloseEvent(event, { code: received.code, reason: received.reason }) : new Event(event);
        this.dispatchEvent(forwarded);
      });
      socket.accept();
      if (this.readyState === 3) { socket.close(1000, 'Scope closed'); return; }
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    }).catch(() => {
      if (this.readyState !== 3) {
        this.readyState = 3;
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new CloseEvent('close', { code: 1011, reason: 'Upgrade failed' }));
      }
    });
  }
  send(value) { this.#socket.send(value); }
  close(code = 1000, reason = '') { this.readyState = 3; this.#socket?.close(code, reason); }
}

export function openAssistantSession(t, { applicationId, definition, exchange, upgrade, onDevice }) {
  return async ({ signal } = {}) => {
    const expiry = scopedDeadline(10_000, signal), deadline = expiry.signal;
    try {
      const peers = createPeersClient({
        base: 'https://tendril.internal',
        applicationId,
        request: exchange,
        socket: (url, protocols) => new LocalPeerSocket(upgrade(new URL(url), protocols)),
      });
      const authority = await peers.application({ signal: deadline });
      const verified = await verifyAuthorityBundle(authority);
      if (authority.descriptor.payload.applicationId !== applicationId) throw Error('ASSISTANT_APPLICATION_MISMATCH');
      const device = await openApplicationDevice({ store: assistantDeviceStore(t) });
      let session;
      onDevice(device.identity.publicKey);
      try {
        const grant = verified.grant(device.identity.publicKey);
        if (!grant?.reader || grant.administrator || grant.publisher || grant.coordinator || grant.recovery)
          throw Error('ASSISTANT_DEVICE_GRANT_INVALID');
        session = await openPeerApplication({ device, definition, authority });
        const control = session.connectControlParticipant({ exchange: (message, options) => peers.exchange(message, options) });
        const introductions = createPeerIntroductions({ peers, identity: session.deviceId, directTimeoutMs: 1,
          openDirectConnection: async () => { throw Error('ASSISTANT_RELAY_REQUIRED'); },
          openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }) });
        const participation = await session.participate({
          control, transport: introductions.transport, connections: { maxPeers: 1 },
          discovery: {
            read: introductions.discovery.read,
            // This short-lived peer only calls the coordinator. Advertising it
            // invites duplicate connections and burns an idle presence lease.
            async advertise() {},
            async withdraw() {},
            async *invitations({ signal }) {
              await new Promise(resolve => {
                if (signal.aborted) resolve();
                else signal.addEventListener('abort', resolve, { once: true });
              });
            },
          },
        });
        // Activate the retained data component before waiting for its live route.
        // A protocol-only connected status by itself cannot serve commands.
        const initial = await session.readView();
        await initial.release();
        const coordinator = verified.current?.payload.coordinator;
        if (!coordinator) throw Error('ASSISTANT_COORDINATOR_REQUIRED');
        const ready = status => status.phase === 'following' && status.connectedPeers.includes(coordinator);
        if (!ready(participation.status)) await new Promise((resolve, reject) => {
          const stop = () => { unsubscribe(); reject(deadline.reason); };
          let unsubscribe = () => {};
          unsubscribe = participation.onStatus(status => {
            if (ready(status)) {
              unsubscribe(); deadline.removeEventListener('abort', stop); resolve();
            }
          });
          deadline.addEventListener('abort', stop, { once: true });
          if (deadline.aborted) stop();
        });
        deadline.throwIfAborted();
        await session.resume();
        return { session, control };
      } catch (error) { if (session) await session.close(); else await device.close(); throw error; }
    } finally { expiry.close(); }
  };
}
