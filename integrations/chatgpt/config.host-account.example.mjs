// Private deployment configuration using Tendriller's own account/OAuth host.
// deploy/prepare.mjs generates the environment and matching host registration.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const required = name => {
  const value = process.env[name];
  if (!value) throw Object.assign(Error(`Required deployment setting: ${name}`), { code: `MISSING_${name}` });
  return value;
};
const kitchen = resolve(required('TENDRILLER_KITCHEN_DIR'));
const { openSession } = await import(pathToFileURL(join(kitchen, 'session.mjs')).href);
const { readPrivate, bridgeDevicePath } = await import(pathToFileURL(join(kitchen, 'local.mjs')).href);
const { kitchenEventProjection } = await import(pathToFileURL(join(kitchen, 'projection.mjs')).href);
const [descriptor, handle] = await Promise.all([readPrivate('descriptor.json'), readPrivate('handle.json')]);
const hostOrigin = required('TENDRILLER_HOST_ORIGIN');
if (handle.application?.id !== descriptor.payload.applicationId || new URL(handle.api).origin !== hostOrigin)
  throw Object.assign(Error('The private page handle and pinned descriptor must match the configured account host'), { code: 'HOST_APPLICATION_SCOPE_MISMATCH' });

export default {
  resource: required('TENDRILLER_MCP_RESOURCE'),
  storePath: required('TENDRILLER_DELIVERY_DB'),
  storeKey: required('TENDRILLER_DELIVERY_KEY'),
  hostAccount: {
    origin: hostOrigin,
    bridgeId: required('TENDRILLER_BRIDGE_ID'),
    bridgeSecret: required('TENDRILLER_BRIDGE_SECRET'),
    csrfKey: Buffer.from(required('TENDRILLER_MANAGEMENT_CSRF_KEY'), 'base64'),
  },
  applications: [{
    id: descriptor.payload.applicationId, pageId: handle.id, label: 'Kitchen assistance',
    openSession: options => openSession({ ...options, deviceFile: bridgeDevicePath }),
    allowedQueries: ['kitchenContext', 'assistanceStatus'],
    allowedCommands: ['requestAssistance', 'replyToAssistance'],
    allowedEvents: ['assistant.help_requested', 'application.recovery_notice'],
    allowEventDetails: true,
    eventTopics: ['assistant'], eventProjection: kitchenEventProjection,
  }],
  host: '127.0.0.1', port: 8788,
  shutdownTimeoutMs: 15000,
  // Optional: expose creation only after approving tendrils:create in the OAuth
  // client. The account host supplies the current verified owner email.
  // lifecycle: { creation: true },
  // Optional: workspaceAgent: { triggerId: 'agtch_...', accessToken: process.env.WORKSPACE_AGENT_ACCESS_TOKEN },
};
