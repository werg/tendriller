import { openBrowserOwner, createBrowserIdentity } from '../../../session/browser.mjs';
import { createViewStore } from '../../local.mjs';
import { verifyParticipantPanel } from './presentation.mjs';

window.verifyParticipantPanel = verifyParticipantPanel;
const query = new URL(location.href).searchParams;
const profileId = query.get('profile') || 'browser-owner-test';
window.ownerStage = 'identity';
window.ownerReplacedCount = 0;

window.ready = (async () => {
  const workerUrl = new URL(`./worker.mjs?profile=${profileId}`, import.meta.url);
  if (query.get('identity') === 'create') {
    await createBrowserIdentity({ workerUrl, profileId });
    const retained = new URL(location.href);
    retained.searchParams.delete('identity');
    history.replaceState(null, '', retained);
  }
  window.ownerStage = 'attachment';
  const ownerOptions = {
    workerUrl,
    profileId,
    applicationId: '91'.repeat(32),
    takeover: query.get('takeover') === '1',
    onOwnerReplaced() { window.ownerReplacedCount++; },
    context: {
      viewId: sessionStorage.getItem('fixture-view') || query.get('view') || crypto.randomUUID(),
      documentPath: location.pathname,
      publicationId: 'fixture-publication',
    },
  };
  const attachment = await openBrowserOwner(ownerOptions);
  sessionStorage.setItem('fixture-view', attachment.session.endpoint.context.viewId);
  window.attachment = attachment;
  window.session = attachment.session;
  window.viewStore = createViewStore({
    storage: localStorage,
    applicationId: '91'.repeat(32),
    profileId,
    viewId: attachment.session.endpoint.context.viewId,
  });
  window.reattach = async () => {
    await window.attachment.detach();
    const next = await openBrowserOwner({ ...ownerOptions, takeover: false });
    window.attachment = next;
    window.session = next.session;
    return next.session.endpoint;
  };
  window.ownerProfile = profileId;
  window.ownerStage = 'ready';
  return {
    mode: attachment.mode,
    endpoint: attachment.session.endpoint,
    publicKey: attachment.session.identity.publicKey,
    status: attachment.session.status,
  };
})().catch(error => {
  window.ownerStage = `failed:${window.ownerStage}`;
  window.ownerFailure = { name: error.name, code: error.code, message: error.message };
  throw error;
});
