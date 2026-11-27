import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { createApplicationBackend } from '@chronolog/peer-session';
import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { mountCallRoom, renderTabTakeoverBanner } from '../../shared/ui/call-room.mjs';

const root = document.querySelector('#call-root') ?? document.body;
const response = await fetch(new URL('./configuration.json', import.meta.url));
if (!response.ok) throw Error('Public application configuration is unavailable');
const configuration = await response.json();
const profileId = browserProfileId(configuration.applicationId);

let attachment, callUi;

async function connect(takeover = 'auto') {
  try {
    attachment = await openBrowserOwner({
      workerUrl: new URL('./worker.mjs', import.meta.url),
      profileId,
      applicationId: configuration.applicationId,
      takeover,
      onOwnerReplaced() {
        void callUi?.dispose();
        renderTabTakeoverBanner(root, {
          message: 'This call moved to another tab.',
          onTakeover: () => connect(true),
        });
      },
    });
    const session = attachment.session;
    window.tendril.application.install(createApplicationBackend(session));
    window.tendril.signals.install(session.signals);
    window.tendril.transport.install(session);

    callUi = await mountCallRoom({
      runtime: window.tendril,
      session,
      attachment,
      peers: window.tendril.host.peers,
      container: root,
      title: 'Tendriller Call Room',
      transcription: 'model',
      persistTranscript: false,
      agentAudio: 'ask',
      stage: true,
    });
    window.tendril.ready();
  } catch (error) {
    if (error?.code === 'TAB_ACTIVE_ELSEWHERE') {
      renderTabTakeoverBanner(root, {
        message: 'This call page is already open in another tab.',
        onTakeover: () => connect(true),
      });
      return;
    }
    root.textContent = `Could not open local call session: ${error.message}`;
  }
}

window.addEventListener('pagehide', () => {
  void callUi?.dispose();
  void attachment?.detach().catch(() => {});
});
void connect();
