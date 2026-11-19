// Copy this file to a private deployment directory and replace the account
// adapter with your current authenticated Tendriller account mapping. Nothing
// here enrolls a device, links an account or grants application consent.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const required = name => {
  const value = process.env[name];
  if (!value) throw Error(`Required deployment setting: ${name}`);
  return value;
};
const kitchen = resolve(required('TENDRILLER_KITCHEN_DIR'));
const { openSession } = await import(pathToFileURL(join(kitchen, 'session.mjs')).href);
const { readPrivate, bridgeDevicePath } = await import(pathToFileURL(join(kitchen, 'local.mjs')).href);
const { kitchenEventProjection } = await import(pathToFileURL(join(kitchen, 'projection.mjs')).href);
const descriptor = await readPrivate('descriptor.json');
// This is a deliberate operator-supplied module, not an invented application
// backend. It must expose current account ownership/access and browser login.
const account = await import(pathToFileURL(resolve(required('TENDRILLER_ACCOUNT_ADAPTER'))).href);

export default {
  resource: required('TENDRILLER_MCP_RESOURCE'),
  issuer: required('TENDRILLER_OAUTH_ISSUER'),
  jwksUri: required('TENDRILLER_OAUTH_JWKS_URI'),
  storePath: required('TENDRILLER_DELIVERY_DB'),
  storeKey: required('TENDRILLER_DELIVERY_KEY'), // dedicated base64 32-byte key, retained across restart
  authorizeAccountAccess: account.authorizeAccountAccess,
  authorizeOwner: account.authorizeOwner,
  applications: [{
    id: descriptor.payload.applicationId, label: 'Kitchen assistance',
    openSession: options => openSession({ ...options, deviceFile: bridgeDevicePath }),
    allowedQueries: ['kitchenContext', 'assistanceStatus'],
    allowedCommands: ['requestAssistance', 'replyToAssistance'],
    eventTopics: ['assistant'], eventProjection: kitchenEventProjection,
  }],
  management: {
    authenticate: account.authenticateBrowserSession,
    applicationsForPrincipal: account.applicationsForPrincipal,
    csrfKey: Buffer.from(required('TENDRILLER_MANAGEMENT_CSRF_KEY'), 'base64'),
  },
  host: '127.0.0.1', port: 8788,
  // Optional: workspaceAgent: { triggerId: 'agtch_...', accessToken: process.env.WORKSPACE_AGENT_ACCESS_TOKEN },
  // Optional lifecycle creation/publisher handoff: see LIFECYCLE.md. It needs
  // private host handles and a real authorizePublication owner approval callback.
};
