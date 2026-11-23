import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { startRuntime } from '../../runtime/src/kernel.ts';
import { mountObservations } from '../../docs/tutorial/observation/panel.mjs';
import { definition } from '../../docs/tutorial/observation/domain.mjs';

const worker = window.worker = new Worker('/worker.mjs', { type: 'module' });
window.ready = new Promise((resolve, reject) => worker.addEventListener('message', async ({ data }) => {
  try {
    if (data?.type === 'identity') {
      worker.postMessage({ type: 'configure', value: await window.__bootstrap(data.value) });
    }
    if (data?.type === 'bridge-out') {
      try {
        await window.__nativeFrame(data.lane, data.bytes);
        worker.postMessage({ type: 'bridge-ack', id: data.id });
      } catch (error) {
        worker.postMessage({ type: 'bridge-ack', id: data.id, error: error.message });
      }
    }
    if (data?.type === 'failure') reject(Error(data.message));
    if (data?.type !== 'ready') return;
    const session = window.session = await connectApplicationOwner(worker, {
      applicationId: data.applicationId,
      definitionId: definition.id,
      definitionVersion: definition.version,
    });
    const runtime = window.runtime = startRuntime({
      id: 'observation-fixture',
      base: '/',
      version: 0,
      documentPath: null,
      application: { id: data.applicationId },
    });
    window.controller = mountObservations({
      container: document.querySelector('main'),
      session,
      runtime,
      nativeDeviceId: data.nativeDeviceId,
    });
    await session.query('observations', null);
    resolve({ deviceId: session.deviceId, endpoint: session.endpoint });
  } catch (error) {
    reject(error);
  }
}));
