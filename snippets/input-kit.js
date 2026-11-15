/* User-controlled capture: aim/record, review, then send. Media remains local until Send.
 * Durable uploadEvent sends the media and its meaning together, including after a reload.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const names = { photo: 'Take photo', audio: 'Record voice note', location: 'Share location once', motion: 'Measure movement', file: 'Choose a file' };
  const valid = Object.keys(names);
  const el = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = String(text); return n; };
  const script = name => {
    if (ns[name]) return Promise.resolve(ns[name]);
    ns._loads ||= {};
    return ns._loads[name] ||= new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = `_tendril/snippets/${name}.js`;
      s.onload = () => resolve(ns[name]); s.onerror = () => { delete ns._loads[name]; reject(Error(`Could not load ${name}`)); }; document.head.append(s);
    });
  };
  const check = result => { if (result?.status === 'rejected' || result?.error) throw Error(result.message || result.error?.message || result.error || 'The page did not accept this input.'); return result; };
  const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

  function mount(target, { modalities = valid, block, context } = {}) {
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw Error('Input kit target was not found');
    let camera = null, cameraSession = null, recorder = null, stream = null, motion = null, motionStart = 0, motionCount = 0;
    let current = null, timer = null, recordingStart = 0, discardAudio = false, disposed = false, generation = 0;
    const objectUrls = new Set(), cards = new Map(), replies = new Map(), off = [];
    const section = el('section'); section.className = 'tendril-input-kit';
    const style = el('style'); style.textContent = '.tendril-input-kit{--ti-bg:#f2f7f0;--ti-fg:#244434;--ti-border:#adc5b1;color:inherit;display:grid;gap:.75rem}.tendril-input-kit button{min-height:44px;padding:.55em .85em;font:inherit;border-radius:.7rem;border:1px solid var(--ti-border);background:var(--ti-bg);color:var(--ti-fg);cursor:pointer}.tendril-input-kit button:disabled{opacity:.55;cursor:default}.tendril-input-kit .ti-actions{display:flex;gap:.6rem;flex-wrap:wrap}.tendril-input-kit .ti-review,.tendril-input-kit .ti-card{border:1px solid var(--ti-border);border-radius:1rem;padding:1rem;display:grid;gap:.6rem}.tendril-input-kit .ti-view{position:relative;max-width:32rem}.tendril-input-kit .ti-view video,.tendril-input-kit .ti-view img{width:100%;display:block;border-radius:.7rem}.tendril-input-kit textarea{font:inherit;min-height:5rem;width:100%;box-sizing:border-box;padding:.65rem;border:1px solid var(--ti-border);border-radius:.6rem}.tendril-input-kit .ti-dot{position:absolute;width:1.25rem;height:1.25rem;border:3px solid #f8b656;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 2px #244434;pointer-events:none}.tendril-input-kit .ti-card img{width:5rem;height:4rem;object-fit:cover;border-radius:.5rem}.tendril-input-kit .ti-error{color:#a63826}.tendril-input-kit [hidden]{display:none!important}@media(prefers-color-scheme:dark){.tendril-input-kit{--ti-bg:#253d2f;--ti-fg:#e6f2e6;--ti-border:#577861}}';
    const buttons = el('div'); buttons.className = 'ti-actions';
    const status = el('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const review = el('div'); review.className = 'ti-review'; review.hidden = true;
    const view = el('div'); view.className = 'ti-view';
    const actionBar = el('div'); actionBar.className = 'ti-actions';
    const details = el('div'), history = el('div'), update = el('div'); update.hidden = true; update.setAttribute('role', 'status');
    review.append(view, details, actionBar); section.append(style, buttons, status, review, update, history); host.replaceChildren(section);
    const say = message => { status.textContent = message; };
    const makeButton = (label, action) => {
      const b = el('button', label); b.type = 'button';
      b.onclick = async () => { b.disabled = true; try { await action(); } catch (error) { say(error?.message || String(error)); } finally { if (!disposed) b.disabled = false; } };
      return b;
    };
    const objectUrl = blob => { const url = URL.createObjectURL(blob); objectUrls.add(url); return url; };
    const release = url => { if (url && objectUrls.delete(url)) URL.revokeObjectURL(url); };
    const stopCamera = () => { cameraSession?.abort(); cameraSession = null; camera?.close(); camera = null; };
    const stopRecording = discard => { discardAudio = discard; if (recorder?.state === 'recording') recorder.stop(); else stream?.getTracks().forEach(t => t.stop()); clearInterval(timer); timer = null; };
    const busy = () => !!cameraSession || !!camera || recorder?.state === 'recording' || !!current || !!motion;
    const reset = () => { ++generation; stopCamera(); stopRecording(true); if (current) release(current.preview); current = null; view.replaceChildren(); details.replaceChildren(); actionBar.replaceChildren(); review.hidden = true; };
    const checked = async data => check(await tendril.send({ type: 'input', at: Date.now(), ...(block ? { block } : {}), ...data }));
    const receiptText = r => r.status === 'rejected' ? (r.message || r.error?.message || 'Not accepted. Retry or remove this capture.') : r.queued || r.status === 'queued' ? 'Saved on this device. Waiting for connection.' : 'Received by the page. Waiting for the agent.';

    function renderCard(r, data, preview) {
      const id = r.capture_id || `event:${r.seq || Date.now()}`;
      let card = cards.get(id);
      if (!card) {
        const node = el('article'); node.className = 'ti-card'; node.dataset.capture = id;
        const title = el('strong', data?.name || `${data?.modality || 'Media'} capture`), progress = el('p'), reply = el('p'), actions = el('div');
        progress.setAttribute('role', 'status'); actions.className = 'ti-actions'; reply.hidden = true;
        node.append(title, progress, reply, actions);
        card = { node, title, progress, reply, actions, data, preview }; cards.set(id, card); history.prepend(node);
        if (preview && (data?.modality === 'photo' || data?.mime?.startsWith('image/'))) { const img = el('img'); img.src = preview; img.alt = 'Your capture'; node.prepend(img); }
        while (cards.size > 20) { const first = cards.keys().next().value; const old = cards.get(first); old.node.remove(); release(old.preview); cards.delete(first); }
      }
      card.result = r; card.progress.textContent = receiptText(r); card.progress.className = r.status === 'rejected' ? 'ti-error' : '';
      card.actions.replaceChildren();
      if (r.status === 'rejected' && tendril.retryCapture) card.actions.append(makeButton('Retry capture', async () => renderCard(await tendril.retryCapture(id), card.data, card.preview)));
      if ((r.queued || r.status === 'rejected') && tendril.discardCapture) card.actions.append(makeButton('Remove capture', async () => { await tendril.discardCapture(id); card.node.remove(); release(card.preview); cards.delete(id); }));
      if (r.blob?.id && tendril.setBlobRetention && tendril.device?.role === 'owner') {
        if (r.blob.retention?.keep) card.actions.append(el('span', 'Kept'));
        else card.actions.append(makeButton('Keep capture', async () => { const blob = await tendril.setBlobRetention(r.blob.id, { keep: true }); renderCard({ ...card.result, blob }, card.data, card.preview); }));
      }
      if (r.seq) { card.node.dataset.seq = String(r.seq); if (replies.has(r.seq)) showReply(card, replies.get(r.seq)); }
      return card;
    }
    function showReply(card, text) { card.reply.hidden = false; card.reply.textContent = `Agent: ${text}`; card.progress.textContent = 'Agent replied.'; }
    const recover = () => { for (const item of tendril.captures?.() || []) { if (!modalities.includes(item.data?.modality) || (block && item.data?.block !== block)) continue; renderCard({ ...item, queued: item.status === 'queued' }, item.data, item.blob?.url); } };
    if (tendril.on) {
      off.push(tendril.on('capture_queue', recover));
      off.push(tendril.on('upload_event', r => { const existing = cards.get(r.capture_id); if (existing) renderCard(r, existing.data, existing.preview); }));
      off.push(tendril.on('say', m => { if (!m?.in_reply_to || !m.text) return; replies.set(m.in_reply_to, m.text); for (const card of cards.values()) if (card.result.seq === m.in_reply_to) showReply(card, m.text); }));
    }

    function readyCapture(capture) {
      capture.context = typeof context === 'function' ? context() : context;
      current = capture; stopCamera(); review.hidden = false; view.replaceChildren(); details.replaceChildren(); actionBar.replaceChildren();
      if (capture.modality === 'photo') {
        const img = el('img'); img.src = capture.preview; img.alt = 'Review your photo before sending'; view.append(img);
        const mark = el('span'); mark.className = 'ti-dot'; mark.hidden = true; view.append(mark);
        const markStatus = el('p', 'Optional: tap the photo to point out a detail, or describe it below.');
        const setPoint = (x, y) => { capture.point = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }; mark.style.left = `${capture.point.x * 100}%`; mark.style.top = `${capture.point.y * 100}%`; mark.hidden = false; markStatus.textContent = 'Point marked. Your original photo is unchanged.'; };
        img.onclick = e => { const r = img.getBoundingClientRect(); setPoint((e.clientX-r.left)/r.width, (e.clientY-r.top)/r.height); };
        const center = makeButton('Mark centre', () => setPoint(.5, .5));
        const clear = makeButton('Clear mark', () => { delete capture.point; mark.hidden = true; markStatus.textContent = 'Point removed.'; });
        details.append(markStatus, center, clear);
        actionBar.append(makeButton('Retake photo', async () => { reset(); await openCamera(); }));
      } else if (capture.modality === 'audio') {
        const audio = el('audio'); audio.controls = true; audio.src = capture.preview; audio.setAttribute('aria-label', 'Review voice note'); view.append(audio, el('p', `Voice note · ${clock(capture.duration_ms)}`));
      } else view.append(el('strong', capture.name || 'Selected file'), el('p', `${Math.ceil(capture.blob.size / 1024)} KB`));
      const label = el('label', 'Question or note (optional)'), note = el('textarea'); note.setAttribute('aria-label', 'Question or note (optional)'); label.append(note); details.append(label);
      const keepLabel = el('label'), keep = el('input'); keep.type = 'checkbox'; keepLabel.append(keep, document.createTextNode(' Keep this capture instead of automatic expiry')); if (tendril.device?.role === 'owner') details.append(keepLabel);
      actionBar.append(makeButton('Discard', () => { reset(); say('Capture discarded. Nothing was sent.'); }));
      actionBar.append(makeButton(capture.modality === 'photo' ? 'Send photo' : capture.modality === 'audio' ? 'Send voice note' : 'Send file', async () => {
        say('Saving capture…');
        const lock = disabled => { for (const button of actionBar.querySelectorAll('button')) button.disabled = disabled; note.disabled = disabled; keep.disabled = disabled; };
        lock(true);
        const data = { type: 'input', modality: capture.modality, at: Date.now(), ...(block ? { block } : {}), name: capture.name, size: capture.blob.size, mime: capture.blob.type,
          ...(capture.width ? { width: capture.width, height: capture.height } : {}), ...(capture.duration_ms ? { duration_ms: capture.duration_ms } : {}),
          ...(capture.point ? { point: capture.point } : {}), ...(note.value.trim() ? { question: note.value.trim() } : {}), ...(capture.context ? { context: capture.context } : {}) };
        let result;
        try {
          if (tendril.uploadEvent) result = await tendril.uploadEvent(capture.blob, { name: capture.name, data, keep: keep.checked });
          else { const file = await tendril.upload(capture.blob, { name: capture.name }); result = await checked({ ...data, blob: file.id, url: file.url }); }
        } catch (error) { lock(false); throw error; }
        if (disposed) return;
        if ((result.status === 'rejected' || result.error) && (!result.capture_id || result.error === 'storage_unavailable' || result.error?.code === 'storage_unavailable')) {
          // A capture id is assigned before the durable write. If storage failed,
          // there is no outbox item for Retry capture: keep the local Blob here.
          lock(false); say(receiptText(result)); return;
        }
        renderCard(result, data, capture.preview);
        current = null; review.hidden = true; view.replaceChildren(); details.replaceChildren(); actionBar.replaceChildren(); say(receiptText(result));
      }));
      say('Ready to review. Nothing has been sent yet.');
    }

    const cameraKit = modalities.includes('photo') ? script('camera').catch(() => null) : null;
    const motionKit = modalities.includes('motion') ? script('motion').catch(() => null) : null;
    const waitForFrame = (video, signal) => new Promise((resolve, reject) => {
      const events = ['loadeddata', 'canplay', 'playing', 'resize'];
      let timeout;
      const cleanup = () => { clearTimeout(timeout); for (const event of events) video.removeEventListener(event, checkFrame); video.removeEventListener('error', fail); signal.removeEventListener('abort', cancel); };
      const checkFrame = () => { if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) { cleanup(); resolve(); } };
      const fail = () => { cleanup(); reject(Error('The camera could not show a picture. Try switching again, or cancel and choose a photo.')); };
      const cancel = () => { cleanup(); reject(new DOMException('Camera closed', 'AbortError')); };
      if (signal.aborted) { cancel(); return; }
      for (const event of events) video.addEventListener(event, checkFrame);
      video.addEventListener('error', fail); signal.addEventListener('abort', cancel, { once: true });
      // A device failure needs a retry path; the shutter is enabled by a frame
      // event and current-data readiness, never by waiting an arbitrary delay.
      timeout = setTimeout(fail, 12000); checkFrame();
    });
    async function openCamera() {
      if (busy()) { say('Finish or discard your current capture first.'); return; }
      reset(); const token = generation, session = new AbortController(); cameraSession = session;
      const active = () => !disposed && token === generation && cameraSession === session && !session.signal.aborted;
      const cancel = makeButton('Cancel camera', () => { reset(); say('Camera closed.'); });
      actionBar.replaceChildren(cancel);
      review.hidden = false; say('Opening the camera…');
      let opened;
      try {
        const kit = await cameraKit; if (!active()) return;
        if (!kit) throw Error('Camera is unavailable. You can choose a photo instead.');
        opened = await kit.open(view);
        if (!active()) { opened.close(); return; }
        camera = opened;
        let working = false, frameAvailable = false;
        const shutter = el('button', 'Capture photo'), switcher = el('button', 'Switch camera'); shutter.type = switcher.type = 'button';
        const updateControls = () => { shutter.disabled = working || !frameAvailable; switcher.disabled = working; };
        const runCamera = async action => {
          if (working || !active()) return;
          working = true; updateControls();
          try { await action(); }
          catch (error) { if (active()) say(error?.message || 'Could not use the camera. Try again.'); }
          finally { working = false; if (active()) updateControls(); else opened.close(); }
        };
        const showReady = async () => {
          await waitForFrame(opened.video, session.signal);
          if (!active()) return;
          frameAvailable = true; say('Aim your camera, then choose Capture photo.');
        };
        shutter.onclick = () => void runCamera(async () => {
          await waitForFrame(opened.video, session.signal);
          if (!active()) return;
          const picture = await opened.capture({ upload: false });
          if (!active()) return;
          readyCapture({ ...picture, modality: 'photo', name: 'photo.jpg', preview: objectUrl(picture.blob) });
        });
        switcher.onclick = () => void runCamera(async () => {
          frameAvailable = false; say('Switching camera…');
          await opened.switch();
          if (!active()) return;
          await showReady();
        });
        actionBar.replaceChildren(shutter, switcher, cancel); updateControls();
        await runCamera(showReady);
      } catch (error) {
        if (!active()) { opened?.close(); return; }
        reset(); throw error;
      }
    }
    const picker = (accept, modality) => {
      if (busy()) { say('Finish or discard your current capture first.'); return; }
      const input = el('input'); input.type = 'file'; if (accept) input.accept = accept;
      input.onchange = async () => {
        const file = input.files?.[0]; if (!file) return; reset(); const preview = objectUrl(file);
        const capture = { blob: file, preview, name: file.name, modality: modality || (file.type.startsWith('image/') ? 'photo' : 'file') };
        if (capture.modality === 'photo') { try { const img = new Image(); img.src = preview; await img.decode(); capture.width = img.naturalWidth; capture.height = img.naturalHeight; } catch { release(preview); say('This photo could not be opened. Choose another image.'); return; } }
        readyCapture(capture);
      }; input.click();
    };
    if (modalities.includes('photo')) buttons.append(makeButton(names.photo, openCamera), makeButton('Choose a photo', () => picker('image/*', 'photo')));
    if (modalities.includes('file')) buttons.append(makeButton(names.file, () => picker('', 'file')));
    if (modalities.includes('location')) buttons.append(makeButton(names.location, async () => {
      if (!navigator.geolocation) throw Error('Location is unavailable on this device.'); say('Finding your location…');
      const p = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 15000 }));
      const result = await checked({ modality: 'location', latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy_m: p.coords.accuracy }); say(receiptText(result));
    }));
    if (modalities.includes('audio')) buttons.append(makeButton(names.audio, async () => {
      if (busy()) { say('Finish or discard your current capture first.'); return; }
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw Error('Audio recording is unavailable. You can type to the agent instead.');
      reset(); const token = generation; stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed || token !== generation) { stream.getTracks().forEach(t => t.stop()); return; }
      const chunks = [], recordingStream = stream; recorder = new MediaRecorder(recordingStream); const recording = recorder; discardAudio = false; recordingStart = Date.now();
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        recordingStream.getTracks().forEach(t => t.stop());
        if (recorder === recording) { stream = null; clearInterval(timer); timer = null; recorder = null; }
        if (discardAudio || disposed || token !== generation) return;
        const blob = new Blob(chunks, { type: recording.mimeType || 'audio/webm' });
        readyCapture({ blob, preview: objectUrl(blob), modality: 'audio', name: 'voice-note.webm', duration_ms: Date.now()-recordingStart });
      };
      recorder.start(); review.hidden = false; const duration = el('p', 'Recording · 0:00'); duration.setAttribute('role', 'timer'); view.append(duration);
      timer = setInterval(() => { const elapsed = Date.now()-recordingStart; duration.textContent = `Recording · ${clock(elapsed)}`; if (elapsed >= 300000) stopRecording(false); }, 250);
      actionBar.append(makeButton('Stop and review', () => stopRecording(false)), makeButton('Discard recording', () => { reset(); say('Recording discarded. Nothing was sent.'); })); say('Recording on this device. Stop to review before sending.');
    }));
    if (modalities.includes('motion')) {
      const button = makeButton(names.motion, async () => {
        if (motion) { motion.stop(); motion = null; const result = await checked({ modality: 'motion', duration_ms: Date.now()-motionStart, steps: motionCount }); button.textContent = names.motion; say(receiptText(result)); return; }
        const kit = await motionKit; if (!kit?.supported()) throw Error('Motion sensors are unavailable.');
        if (await kit.requestPermission() === 'denied') throw Error('Motion permission was denied.'); motionStart = Date.now(); motionCount = 0;
        motion = kit.start({ onStep: n => { motionCount = n; say(`${n} estimated steps. Stop to send the summary.`); } }); button.textContent = 'Stop and send movement'; say('Measuring movement.');
      }); buttons.append(button);
    }
    const beforeReload = e => {
      if (!busy()) return; e.preventDefault(); update.hidden = false;
      update.replaceChildren(el('p', 'A page update is ready. Finish or discard this capture before applying it.'), makeButton('Apply page update', () => { if (busy()) { say('Send or discard your capture first.'); return; } e.detail.apply(); }));
    };
    window.addEventListener('tendril:before-reload', beforeReload);
    recover();
    const api = { busy, stop() { disposed = true; reset(); motion?.stop(); motion = null; off.forEach(fn => fn?.()); window.removeEventListener('tendril:before-reload', beforeReload); for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls.clear(); } };
    return api;
  }
  ns.inputs = { supported: () => true, mount, modalities: valid };
})();
