// Signed browser page: it opens its own retained identity/keys/storage and never requires the native participant.
import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { createLiveView, createViewStore, createApplicationBackend } from '@chronolog/peer-session';
import { browserProfileId } from './support/browser-profile.mjs';
import { mountProvisioning } from './support/provisioning-view.mjs';
import { enableHostedMcp } from './support/hosted-mcp.mjs';
import { deriveChecklist } from './review-domain.mjs';
const $ = selector => document.querySelector(selector);
const response = await fetch(new URL('./configuration.json', import.meta.url));
if (!response.ok) throw Error('Public application configuration is unavailable');
const configuration = await response.json(), profileId = browserProfileId(configuration.applicationId);
let storage, viewId;
try { storage = localStorage; viewId = sessionStorage.getItem(`${profileId}:view`) || crypto.randomUUID(); sessionStorage.setItem(`${profileId}:view`, viewId); }
catch { const map = new Map(); storage = { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; viewId = crypto.randomUUID(); }
const local = createViewStore({ storage, applicationId: configuration.applicationId, profileId, viewId });
let attachment, session, live, provisioning, hostedMcp, canAuthor = false, items = [];
const nodes = new Map();
function render() {
  for (const item of items) {
    let node = nodes.get(item.id);
    if (!node) {
      const li = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Mark complete';
      button.addEventListener('click', () => {
        button.disabled = true;
        // One stable ID per click: a retry is the same operation, never a second item event.
        session.command('completeItem', { id: item.id }, { operationId: crypto.randomUUID() }).catch(error => { $('#view-error').hidden = false; $('#view-error').textContent = error.message ?? String(error); render(); });
      });
      li.append(label, button); node = { li, label, button }; nodes.set(item.id, node); $('#items').append(li);
    }
    const text = `${item.complete ? '✓ Complete' : 'Incomplete'} · ${item.label}`;
    if (node.label.textContent !== text) node.label.textContent = text;
    node.button.disabled = item.complete || !canAuthor;
  }
}
async function connect() {
  try {
    attachment = await openBrowserOwner({ workerUrl: new URL('./worker.mjs', import.meta.url), profileId, applicationId: configuration.applicationId, context: { viewId }, timeoutMs: 30_000 });
    session = attachment.session; $('#public-key').value = session.identity.publicKey;
    session.onStatus(status => { canAuthor = status.canAuthor; $('#connection-status').textContent = `${status.canAuthor ? 'Local signing and storage ready' : 'Key provisioning required'} · ${status.connectedPeers} connected peers. Peer availability never gates saving.`; render(); });
    window.tendril.application.install(createApplicationBackend(session));
    provisioning = mountProvisioning({ root: $('#provisioning'), session, peers: window.tendril.host.peers, local });
    // Page options → An agent offers explicit owner opt-in for each linked OAuth client; nothing connects automatically.
    hostedMcp = enableHostedMcp({ runtime: window.tendril, session, peers: window.tendril.host.peers, label: 'Review checklist' });
    live = createLiveView(session, deriveChecklist, { onError: error => { $('#view-error').hidden = false; $('#view-error').textContent = `View not current: ${error.message}. The last snapshot is retained.`; } });
    live.subscribe(snapshot => { items = snapshot.value; $('#view-error').hidden = true; render(); });
    try { await live.ready({ timeoutMs: 30_000 }); } catch { /* The error callback reports it; local authoring stays independent. */ }
    window.tendril.ready();
  } catch (error) { $('#connection-status').textContent = `Local session could not open: ${error.message}. Retain this browser profile.`; }
}
window.addEventListener('pagehide', event => { if (event.persisted) void attachment?.suspend().catch(() => {}); else { live?.close(); provisioning?.close(); hostedMcp?.close(); void attachment?.detach().catch(() => {}); } });
window.addEventListener('pageshow', event => { if (event.persisted) void attachment?.resume().then(() => live?.refresh()).catch(() => {}); });
void connect();
