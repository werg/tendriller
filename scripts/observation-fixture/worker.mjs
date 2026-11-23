import { openBrowserDevice, openBrowserApplication, createApplicationOwner } from '@chronolog/peer-session/worker';
import { definition } from '../../docs/tutorial/observation/domain.mjs';
import { createTestConnection } from './connection.mjs';
let sequence = 0, session, owner;
const pending = new Map();
const bridge = createTestConnection((lane, bytes) => new Promise((resolve, reject) => {
  if (pending.size >= 128) { reject(Error('Fixture send capacity exceeded.')); return; }
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Fixture send timed out.')); }, 10000);
  pending.set(id, { resolve() { clearTimeout(timer); resolve(); }, reject(error) { clearTimeout(timer); reject(error); } });
  postMessage({ type: 'bridge-out', id, lane, bytes: [...bytes] });
}));
const config = new Promise(resolve => addEventListener('message', ({ data }) => {
  if (data?.type === 'configure') resolve(data.value);
  if (data?.type === 'bridge-in') bridge.accept(data.lane, new Uint8Array(data.bytes));
  if (data?.type === 'bridge-ack') { const task = pending.get(data.id); pending.delete(data.id); if (data.error) task?.reject(Error(data.error)); else task?.resolve(); }
  if (data?.type === 'disconnect') void bridge.close();
  if (data?.type === 'close') void owner?.close();
}));
try {
  const device = await openBrowserDevice({ name: 'observation-qualification', create: true });
  postMessage({ type: 'identity', value: device.identity.publicKey });
  const { authority, key, nativeDeviceId } = await config;
  session = await openBrowserApplication({ device, definition, authority, epochKeys: new Map([[0, new Uint8Array(key)]]) });
  await session.connectPeer({ connection: bridge.connection, peerIdentity: nativeDeviceId });
  owner = createApplicationOwner(session); owner.attach(self);
  postMessage({ type: 'ready', applicationId: session.applicationId, nativeDeviceId });
} catch (error) { postMessage({ type: 'failure', message: error.stack ?? String(error) }); await session?.close(); }
