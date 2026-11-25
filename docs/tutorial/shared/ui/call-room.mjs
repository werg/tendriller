// Drop-in responsive video conferencing UI for Tendriller pages:
// - Hair-check lobby (local preview before enrollment completes)
// - 1-click Waiting Room Admit (wraps Chronolog grant + HPKE exportProvisioning, or custom onAdmit hook)
// - Single-active-tab takeover banner (`renderTabTakeoverBanner`)
// - Responsive desktop & 320px video grid, screen share, per-person live transcript,
//   shared meeting notes, honest relay notice, and persistent agent-modality disclosure pills.
import { createMediaRoom } from '../media/call-room.mjs';
import { decodeRecord, encodeRecord, recordDigest, verifyRecord } from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';

const STYLES = `
.tr-call{font-family:system-ui,-apple-system,sans-serif;display:grid;gap:12px;color:#0f172a}
.tr-call-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px}
.tr-call-pills{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.tr-pill{font-size:12px;padding:4px 9px;border-radius:999px;background:#e2e8f0;color:#1e293b;display:inline-flex;align-items:center;gap:5px}
.tr-pill.audio{background:#fef3c7;color:#92400e;border:1px solid #f59e0b}
.tr-pill.saving{background:#fee2e2;color:#991b1b;border:1px solid #ef4444}
.tr-pill.relay{background:#ffedd5;color:#9a3412}
.tr-call-main{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;align-items:start}
@media(max-width:760px){.tr-call-main{grid-template-columns:1fr}}
.tr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.tr-tile{position:relative;background:#0f172a;border-radius:12px;overflow:hidden;aspect-ratio:16/10;border:2px solid transparent}
.tr-tile.speaking{border-color:#22c55e}
.tr-tile video{width:100%;height:100%;object-fit:cover;display:block}
.tr-tile-label{position:absolute;left:8px;bottom:8px;background:rgba(15,23,42,.78);color:#fff;font-size:12px;padding:3px 8px;border-radius:6px}
.tr-controls{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px}
.tr-btn{padding:8px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;font-size:14px;cursor:pointer}
.tr-btn.primary{background:#2563eb;color:#fff;border-color:#2563eb}
.tr-btn.danger{background:#dc2626;color:#fff;border-color:#dc2626}
.tr-btn[aria-pressed="false"].toggle{background:#fee2e2;color:#991b1b;border-color:#fca5a5}
.tr-panel{border:1px solid #e2e8f0;border-radius:10px;background:#fff;display:grid;grid-template-rows:auto minmax(180px,360px) auto;overflow:hidden}
.tr-panel-head{padding:10px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;display:flex;justify-content:space-between;align-items:center;font-size:14px}
.tr-feed{overflow-y:auto;padding:10px 12px;display:grid;gap:8px;align-content:start;font-size:13px}
.tr-utt{padding:6px 8px;border-radius:8px;background:#f8fafc}
.tr-utt-meta{font-size:11px;color:#64748b;margin-bottom:2px}
.tr-lobby{display:grid;gap:12px;max-width:480px;margin:0 auto;padding:16px;border:1px solid #e2e8f0;border-radius:12px;background:#fff}
.tr-lobby video{width:100%;border-radius:10px;background:#0f172a;aspect-ratio:16/10;object-fit:cover}
.tr-toast{padding:10px 12px;border-radius:10px;background:#eff6ff;border:1px solid #93c5fd;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;font-size:13px}
`;

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('tr-call-styles')) return;
  const style = document.createElement('style');
  style.id = 'tr-call-styles';
  style.textContent = STYLES;
  document.head.append(style);
}

/** Render a clean single-active-tab handoff prompt when `openBrowserOwner` throws `TAB_ACTIVE_ELSEWHERE`. */
export function renderTabTakeoverBanner(container, { message = 'This page is already open in another tab.', onTakeover }) {
  injectStyles();
  const box = document.createElement('section');
  box.className = 'tr-toast';
  box.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tr-btn primary';
  button.textContent = 'Use here';
  button.addEventListener('click', () => { button.disabled = true; void onTakeover?.(); });
  box.append(text, button);
  container.replaceChildren(box);
  return box;
}

/**
 * Mount a complete video/audio conferencing experience onto `container`:
 * hair-check lobby, 1-click Waiting Room Admit, adaptive video grid, screen share,
 * per-person on-device captions, opt-in transcript saving, and honest agent disclosure.
 */
export async function mountCallRoom({
  runtime = globalThis.window?.tendril,
  session,
  attachment,
  peers,
  container,
  callId = 'main',
  title = 'Meeting Room',
  transcription = 'model',
  persistTranscript = false,
  agentAudio = 'ask',
  allowSyntheticGesture = false,
  onAdmit,
  loadVoice,
} = {}) {
  if (!container) throw Error('mountCallRoom requires a container element');
  injectStyles();

  const waitingGuests = new Map();
  const audioConsentPrompts = new Map();

  const room = createMediaRoom({
    runtime, session, attachment, callId, transcription, persistTranscript, agentAudio, allowSyntheticGesture,
    ...(loadVoice ? { loadVoice } : {}),
    onAgentAudioRequest(req) {
      audioConsentPrompts.set(req.agentKey, req);
      render(room.snapshot());
    },
    onWaitingKnock(knock) {
      waitingGuests.set(knock.authorId, knock);
      render(room.snapshot());
    },
  });

  // 1-click Waiting Room Admit: runs custom `onAdmit` (e.g., feat/admission) or standard grant + HPKE export.
  const admitGuest = async (knock) => {
    if (typeof onAdmit === 'function') {
      await onAdmit(knock);
    } else if (knock.provisioningRequest && peers && session?.provisioning) {
      const request = decodeRecord(authorityRecordBytes(knock.provisioningRequest));
      await verifyRecord('provisioning-request', request, request.payload.recipient);
      const metadata = await peers.application();
      let bundle = decodeRecord(authorityRecordBytes(metadata.authority));
      const head = bundle.memberships.at(-1);
      const existing = head.payload.members.find(m => m.publicKey === request.payload.recipient);
      if (!existing?.reader || !existing?.writer) {
        const result = await peers.grant({
          requestId: crypto.randomUUID(),
          expectedMembershipId: await recordDigest(head),
          authorTimeAfterMs: (BigInt(Date.now()) > head.payload.authorTimeAfterMs ? BigInt(Date.now()) : head.payload.authorTimeAfterMs + 1n).toString(),
          grant: {
            publicKey: request.payload.recipient,
            reader: true, writer: true,
            administrator: existing?.administrator ?? false,
            publisher: existing?.publisher ?? false,
            finalizer: existing?.finalizer ?? false,
          },
        });
        bundle = decodeRecord(authorityRecordBytes(result.authority));
      }
      await session.mergeAuthority(bundle);
      const wrapped = await session.provisioning.exportProvisioning(request);
      if (session.signals) {
        await session.signals.send('call/waiting.admit', {
          callId,
          recipient: request.payload.recipient,
          package: authorityRecord(encodeRecord(wrapped)),
        }, { ttlMs: 60_000 });
      }
    }
    waitingGuests.delete(knock.authorId);
    render(room.snapshot());
  };

  // Sync durable transcript changes into the room view.
  const refreshDurable = async () => {
    if (typeof session?.query !== 'function') return;
    try {
      const state = await session.query('callState', { callId });
      if (state?.utterances) room.setDurableUtterances(state.utterances);
    } catch {}
  };
  const offChange = typeof session?.onChange === 'function' ? session.onChange(() => { void refreshDurable(); }) : () => {};
  void refreshDurable();

  const root = document.createElement('div');
  root.className = 'tr-call';
  container.replaceChildren(root);

  let savedDisplayName = '';
  let previewStream = null;
  const stopPreview = () => {
    for (const t of previewStream?.getTracks() ?? []) { try { t.stop(); } catch {} }
    previewStream = null;
  };

  const renderLobby = (snap) => {
    const lobby = document.createElement('section');
    lobby.className = 'tr-lobby';
    const heading = document.createElement('h2');
    heading.style.margin = '0';
    heading.textContent = title;
    const preview = document.createElement('video');
    preview.autoplay = true; preview.muted = true; preview.playsInline = true;
    if (previewStream) preview.srcObject = previewStream;
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Your name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Enter your display name';
    nameInput.value = savedDisplayName || snap.displayName || '';
    nameInput.style.cssText = 'display:block;width:100%;padding:8px;margin-top:4px;border:1px solid #cbd5e1;border-radius:8px;box-sizing:border-box';
    nameInput.addEventListener('input', () => { savedDisplayName = nameInput.value; });
    nameLabel.append(nameInput);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button'; previewBtn.className = 'tr-btn';
    previewBtn.textContent = previewStream ? 'Stop preview' : 'Check camera';
    previewBtn.addEventListener('click', async event => {
      if (!allowSyntheticGesture && !event.isTrusted) return;
      if (previewStream) { stopPreview(); render(room.snapshot()); return; }
      try {
        previewStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        preview.srcObject = previewStream;
        previewBtn.textContent = 'Stop preview';
      } catch (err) {
        statusLine.textContent = `Camera unavailable: ${err.message}`;
      }
    });
    const joinBtn = document.createElement('button');
    joinBtn.type = 'button'; joinBtn.className = 'tr-btn primary';
    joinBtn.textContent = 'Join call';
    const statusLine = document.createElement('div');
    statusLine.style.cssText = 'font-size:12px;color:#64748b';
    statusLine.textContent = snap.agents.length
      ? `Agents ready: ${snap.agents.map(a => `@${a.handle || a.displayName} (${a.mode === 'audio' ? 'audio' : 'transcript'})`).join(', ')}`
      : 'Peer-to-peer WebRTC with on-device per-person captions.';

    joinBtn.addEventListener('click', async event => {
      joinBtn.disabled = true;
      stopPreview();
      try {
        await room.join(event, { audio: true, video: true, displayName: (nameInput.value || '').trim() || undefined });
      } catch (err) {
        joinBtn.disabled = false;
        statusLine.textContent = `Could not join: ${err.message}`;
      }
    });

    actions.append(previewBtn, joinBtn);
    lobby.append(heading, preview, nameLabel, actions, statusLine);
    return lobby;
  };

  const renderActive = (snap) => {
    const frag = document.createDocumentFragment();

    // Top bar: title + honest agent & privacy disclosure pills.
    const bar = document.createElement('header');
    bar.className = 'tr-call-bar';
    const h = document.createElement('strong');
    h.textContent = title;
    const pills = document.createElement('div');
    pills.className = 'tr-call-pills';

    for (const agent of snap.agents) {
      const pill = document.createElement('span');
      pill.className = `tr-pill${agent.mode === 'audio' || agent.mode === 'av' ? ' audio' : ''}`;
      pill.textContent = agent.mode === 'audio' || agent.mode === 'av'
        ? `@${agent.handle || agent.displayName} · ${agent.audioApproved ? 'Listening to audio' : 'Audio requested'}`
        : `@${agent.handle || agent.displayName} · Transcript only`;
      pills.append(pill);
    }
    if (snap.savingTranscript) {
      const savePill = document.createElement('span');
      savePill.className = 'tr-pill saving';
      savePill.textContent = 'Saving transcript';
      pills.append(savePill);
    }
    const relayCount = snap.humans.filter(p => !p.mediaAvailable).length;
    if (relayCount > 0) {
      const relayPill = document.createElement('span');
      relayPill.className = 'tr-pill relay';
      relayPill.textContent = `${relayCount} peer(s) on relay — captions & chat active`;
      pills.append(relayPill);
    }
    bar.append(h, pills);
    frag.append(bar);

    // 1-click Waiting Room Admit toasts.
    for (const knock of waitingGuests.values()) {
      const toast = document.createElement('div');
      toast.className = 'tr-toast';
      toast.setAttribute('role', 'alert');
      const label = document.createElement('span');
      label.textContent = `${knock.displayName || knock.authorId.slice(0, 8)} is in the waiting room`;
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px';
      const admit = document.createElement('button');
      admit.type = 'button'; admit.className = 'tr-btn primary'; admit.textContent = 'Admit';
      admit.addEventListener('click', () => { admit.disabled = true; void admitGuest(knock); });
      const deny = document.createElement('button');
      deny.type = 'button'; deny.className = 'tr-btn'; deny.textContent = 'Deny';
      deny.addEventListener('click', () => { waitingGuests.delete(knock.authorId); render(room.snapshot()); });
      btns.append(admit, deny);
      toast.append(label, btns);
      frag.append(toast);
    }

    // Explicit agent audio consent toasts.
    for (const req of audioConsentPrompts.values()) {
      const toast = document.createElement('div');
      toast.className = 'tr-toast';
      const label = document.createElement('span');
      label.textContent = `@${req.handle || req.agentKey.slice(0, 8)} requested live audio access`;
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px';
      const allow = document.createElement('button');
      allow.type = 'button'; allow.className = 'tr-btn primary'; allow.textContent = 'Allow audio';
      allow.addEventListener('click', () => { audioConsentPrompts.delete(req.agentKey); room.approveAgentAudio(req.agentKey, true); });
      const decline = document.createElement('button');
      decline.type = 'button'; decline.className = 'tr-btn'; decline.textContent = 'Transcript only';
      decline.addEventListener('click', () => { audioConsentPrompts.delete(req.agentKey); room.approveAgentAudio(req.agentKey, false); });
      btns.append(allow, decline);
      toast.append(label, btns);
      frag.append(toast);
    }

    // Main split: Video grid + Per-person live transcript panel.
    const main = document.createElement('div');
    main.className = 'tr-call-main';
    const grid = document.createElement('div');
    grid.className = 'tr-grid';

    // Local tile
    const localTile = document.createElement('div');
    localTile.className = `tr-tile${snap.speakingLevel > 0.08 ? ' speaking' : ''}`;
    const localVideo = document.createElement('video');
    localVideo.autoplay = true; localVideo.muted = true; localVideo.playsInline = true;
    if (snap.localStream) localVideo.srcObject = snap.localStream;
    const localLabel = document.createElement('span');
    localLabel.className = 'tr-tile-label';
    localLabel.textContent = `${snap.displayName} (You)${snap.audioEnabled ? '' : ' · Muted'}`;
    localTile.append(localVideo, localLabel);
    grid.append(localTile);

    // Remote human tiles
    for (const peer of snap.humans) {
      const tile = document.createElement('div');
      tile.className = `tr-tile${peer.speaking ? ' speaking' : ''}`;
      const video = document.createElement('video');
      video.autoplay = true; video.playsInline = true;
      if (peer.stream) video.srcObject = peer.stream;
      const lbl = document.createElement('span');
      lbl.className = 'tr-tile-label';
      lbl.textContent = `${peer.displayName}${peer.muted ? ' · Muted' : ''}${peer.mediaAvailable ? '' : ' · Relay (no video)'}`;
      tile.append(video, lbl);
      grid.append(tile);
    }

    // Transcript panel
    const panel = document.createElement('aside');
    panel.className = 'tr-panel';
    const head = document.createElement('div');
    head.className = 'tr-panel-head';
    head.textContent = 'Live Per-Person Transcript';
    const saveToggle = document.createElement('button');
    saveToggle.type = 'button'; saveToggle.className = 'tr-btn';
    saveToggle.style.cssText = 'padding:4px 8px;font-size:12px';
    saveToggle.textContent = snap.savingTranscript ? 'Stop saving' : 'Save transcript';
    saveToggle.addEventListener('click', () => room.setPersistTranscript(!snap.savingTranscript));
    head.append(saveToggle);

    const feed = document.createElement('div');
    feed.className = 'tr-feed';
    feed.setAttribute('aria-live', 'polite');
    if (snap.transcript.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#64748b';
      empty.textContent = 'Per-person captions will appear here as participants speak.';
      feed.append(empty);
    } else {
      for (const u of snap.transcript.slice(-100)) {
        const row = document.createElement('div');
        row.className = 'tr-utt';
        const meta = document.createElement('div');
        meta.className = 'tr-utt-meta';
        meta.textContent = `${u.displayName} · ${new Date(u.startedAtMs).toLocaleTimeString()}${u.persisted ? ' · saved' : ''}`;
        const body = document.createElement('div');
        body.textContent = u.text;
        row.append(meta, body);
        feed.append(row);
      }
    }
    panel.append(head, feed);
    main.append(grid, panel);
    frag.append(main);

    // Bottom controls bar
    const controls = document.createElement('div');
    controls.className = 'tr-controls';
    const micBtn = document.createElement('button');
    micBtn.type = 'button'; micBtn.className = 'tr-btn toggle';
    micBtn.setAttribute('aria-pressed', String(snap.audioEnabled));
    micBtn.textContent = snap.audioEnabled ? 'Mute mic' : 'Unmute mic';
    micBtn.addEventListener('click', () => room.setAudioEnabled(!snap.audioEnabled));

    const camBtn = document.createElement('button');
    camBtn.type = 'button'; camBtn.className = 'tr-btn toggle';
    camBtn.setAttribute('aria-pressed', String(snap.videoEnabled));
    camBtn.textContent = snap.videoEnabled ? 'Turn off camera' : 'Turn on camera';
    camBtn.addEventListener('click', () => room.setVideoEnabled(!snap.videoEnabled));

    const screenBtn = document.createElement('button');
    screenBtn.type = 'button'; screenBtn.className = 'tr-btn';
    screenBtn.textContent = snap.screenSharing ? 'Stop sharing' : 'Share screen';
    screenBtn.addEventListener('click', event => {
      if (snap.screenSharing) room.stopScreenShare();
      else void room.startScreenShare(event).catch(() => {});
    });

    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button'; leaveBtn.className = 'tr-btn danger';
    leaveBtn.textContent = 'Leave call';
    leaveBtn.addEventListener('click', () => { void room.leave(); });

    controls.append(micBtn, camBtn, screenBtn, leaveBtn);
    frag.append(controls);
    return frag;
  };

  const render = (snap) => {
    root.replaceChildren(snap.joined ? renderActive(snap) : renderLobby(snap));
  };

  const offRoom = room.subscribe(render);

  return Object.freeze({
    room,
    async dispose() {
      stopPreview();
      offRoom();
      offChange();
      await room.dispose();
    },
  });
}
