import { openSession as openDeviceSession } from './session.mjs';
import { bridgeDevicePath } from './local.mjs';

// Dedicated enrolled reader/writer. Never run the remote service with the
// creator's coordinator/publisher device or export a browser's signer.
export function openSession(options = {}) {
  return openDeviceSession({ ...options, deviceFile: bridgeDevicePath });
}
