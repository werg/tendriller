/* Agent-editable UI blocks. Stable ids preserve drafts, focus and capture sessions.
 * tendrilSnippets.ui.mount('#app', {path:'interface'});
 * Events are page data: {type:'ui', block, value}. Drafts stay on this device.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const types = ['message', 'status', 'choice', 'text', 'slider', 'button', 'photo', 'location', 'file', 'drawing', 'hardware'];
  const hardware = new Set(['screen', 'clipboard', 'contacts', 'directory', 'gamepad', 'midi', 'hid', 'usb', 'serial', 'bluetooth', 'nfc', 'xr', 'ambient_light', 'magnetometer', 'proximity', 'accelerometer', 'gyroscope']);
  const el = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = String(text); return n; };
  const load = (name, key = name) => {
    if (ns[key]) return Promise.resolve(ns[key]);
    ns._loads ||= {};
    return ns._loads[name] ||= new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = `_tendril/snippets/${name}.js`;
      s.onload = () => resolve(ns[key]); s.onerror = () => { delete ns._loads[name]; reject(Error(`Could not load ${name}`)); }; document.head.append(s);
    });
  };
  const accepted = result => { if (result?.status === 'rejected' || result?.error) throw Error(result.message || result.error?.message || result.error || 'This input was not accepted. Please try again.'); return result; };

  function mount(target, { path = 'interface' } = {}) {
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw Error('UI target not found');
    const key = `tendril:${window.__TENDRIL__?.id || location.pathname}:drafts:${path}`;
    let drafts = Object.create(null), durableDrafts = true;
    try { const parsed = JSON.parse(localStorage.getItem(key) || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(drafts, parsed); } catch { /* private browsing */ }
    const save = () => { try { const json = JSON.stringify(drafts); if (json.length >= 1500000) throw Error('Draft too large'); localStorage.setItem(key, json); durableDrafts = true; } catch { durableDrafts = false; feedback.textContent = 'This browser could not save your draft. Keep this page open or copy your text before applying an update.'; } };
    const records = new Map();
    let pendingSpec = null, pendingReload = null, disposed = false;
    const root = el('section'); root.style.cssText = 'display:grid;gap:1rem;max-width:42rem;font:inherit';
    const title = el('h1'), description = el('p'), blocks = el('div'), notice = el('div'), feedback = el('p');
    blocks.style.cssText = 'display:grid;gap:1rem';
    notice.hidden = true; notice.setAttribute('role', 'status'); notice.style.cssText = 'padding:1rem;border:1px solid #b4ccb8;border-radius:.8rem;background:#edf6ee;color:#244b36';
    const updateText = el('p'), updateButton = el('button', 'Apply update'); updateButton.type = 'button';
    updateButton.onclick = () => { if ([...records.values()].some(rec => rec.kit?.busy?.())) { report('Send or discard your capture before applying this layout.'); return; } save(); if (pendingReload) { const apply = pendingReload; pendingReload = null; apply(); } else if (pendingSpec) { const spec = pendingSpec; pendingSpec = null; reconcile(spec, true); } notice.hidden = true; };
    notice.append(updateText, updateButton);
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    root.append(title, description, notice, blocks, feedback); host.replaceChildren(root);
    const report = msg => { feedback.textContent = msg; };
    const changed = (id, value) => { drafts[id] = value; const rec = records.get(id); if (rec) rec.dirty = true; save(); };
    const send = async (id, value, blob) => {
      report('Sending…');
      try {
        const result = accepted(blob && tendril.uploadEvent
          ? await tendril.uploadEvent(blob, { name: 'drawing.png', dataPath: ['value'], data: { type: 'ui', block: id, value: { width: 640, height: 320 }, at: Date.now() } })
          : await tendril.send({ type: 'ui', block: id, value, at: Date.now() }));
        report(result?.queued ? 'Saved on this device. It will send when connected.' : 'Received by the page. Waiting for the agent.');
        return true;
      } catch (error) { report(error?.message || 'Could not send. Your draft is still here.'); return false; }
    };
    const dirty = rec => rec.dirty || rec.kit?.busy?.() || rec.wrap.contains(document.activeElement);
    const protect = event => {
      save();
      if (![...records.values()].some(dirty)) return;
      event.preventDefault(); pendingReload = event.detail?.apply;
      notice.hidden = false; updateText.textContent = durableDrafts ? 'A new page is ready. Your draft is saved on this device. Apply it when you are ready.' : 'A new page is ready. This browser could not save your draft. Copy or send it before applying.';
    };
    window.addEventListener('tendril:before-reload', protect);
    window.addEventListener('pagehide', save);

    function create(block) {
      const wrap = el('div'); wrap.dataset.block = block.id; wrap.style.cssText = 'display:grid;gap:.4rem';
      const caption = el('label');
      const id = `tendril-ui-${encodeURIComponent(block.id)}`;
      caption.htmlFor = id;
      const rec = { wrap, caption, block, dirty: Object.hasOwn(drafts, block.id), signature: '', kit: null, input: null };
      const remember = value => changed(block.id, value);
      if (block.type === 'message' || block.type === 'status') {
        rec.input = el('p'); if (block.type === 'status') rec.input.setAttribute('role', 'status'); wrap.append(rec.input);
      } else if (block.type === 'drawing') {
        const canvas = el('canvas'); canvas.width = 640; canvas.height = 320; canvas.id = id;
        canvas.style.cssText = 'width:100%;max-width:40rem;border:1px solid currentColor;border-radius:.6rem;touch-action:none;background:white';
        const ctx = canvas.getContext('2d'); ctx.lineWidth = 3; ctx.lineCap = 'round';
        let down = false, touched = false;
        const pos = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX-r.left)*canvas.width/r.width, (e.clientY-r.top)*canvas.height/r.height]; };
        const storeDrawing = () => { down = false; remember(canvas.toDataURL('image/png')); };
        canvas.onpointerdown = e => { down = true; touched = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
        canvas.onpointermove = e => { if (down) { ctx.lineTo(...pos(e)); ctx.stroke(); rec.dirty = true; } };
        canvas.onpointerup = storeDrawing; canvas.onpointercancel = storeDrawing;
        if (drafts[block.id]) { const image = new Image(); image.onload = () => { if (!touched) ctx.drawImage(image, 0, 0); }; image.src = drafts[block.id]; }
        const submit = el('button', 'Send drawing'); submit.type = 'button';
        submit.onclick = async () => {
          submit.disabled = true; const submittedDrawing = canvas.toDataURL('image/png');
          try {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            let value = { width: canvas.width, height: canvas.height };
            if (!tendril.uploadEvent) { const file = await tendril.upload(blob, { name: 'drawing.png' }); value = { ...value, blob: file.id, url: file.url }; }
            if (await send(block.id, value, blob)) { if (canvas.toDataURL('image/png') === submittedDrawing) { rec.dirty = false; delete drafts[block.id]; save(); } }
          } catch (error) { report(error?.message || 'Could not send the drawing.'); } finally { submit.disabled = false; }
        };
        const clear = el('button', 'Clear drawing'); clear.type = 'button'; clear.onclick = () => { touched = true; ctx.clearRect(0, 0, canvas.width, canvas.height); delete drafts[block.id]; rec.dirty = false; save(); };
        const fallback = el('p', 'You can also describe your drawing in the conversation.'); fallback.style.fontSize = '.85em';
        rec.input = canvas; wrap.append(caption, canvas, submit, clear, fallback);
      } else if (['photo', 'location', 'file'].includes(block.type)) {
        const slot = el('div'); wrap.append(caption, slot);
        load('input-kit', 'inputs').then(kit => { if (!disposed && slot.isConnected) rec.kit = kit.mount(slot, { modalities: [block.type], block: block.id }); }).catch(error => { slot.textContent = error.message; });
      } else if (block.type === 'hardware') {
        const slot = el('div'); wrap.append(caption, slot);
        if (hardware.has(block.connector)) load('connectors').then(() => ['serial', 'bluetooth'].includes(block.connector) ? load(block.connector) : null)
          .then(() => load('hardware-lab', 'hardwareLab')).then(lab => { if (!disposed && slot.isConnected) rec.kit = lab.mount(slot, { only: block.connector }); }).catch(error => { slot.textContent = error.message; });
      } else if (block.type === 'choice') {
        const input = el('select'); input.id = id; rec.input = input;
        input.onchange = async () => { if (!input.value) return; remember(input.value); if (await send(block.id, input.value)) rec.dirty = false; };
        wrap.append(caption, input);
      } else if (block.type === 'text') {
        const form = el('form'), input = el('textarea'), submit = el('button', 'Send'); input.id = id; input.rows = 3; input.value = drafts[block.id] || ''; input.style.cssText = 'font:inherit;width:100%;padding:.65rem;border:1px solid #9db6a4;border-radius:.6rem';
        input.oninput = () => remember(input.value); submit.type = 'submit';
        form.style.cssText = 'display:grid;gap:.5rem'; form.append(input, submit);
        form.onsubmit = async e => { e.preventDefault(); const value = input.value.trim(); if (!value) return; submit.disabled = true; if (await send(block.id, value)) { if (input.value.trim() === value) { input.value = ''; delete drafts[block.id]; rec.dirty = false; save(); } } submit.disabled = false; };
        rec.input = input; wrap.append(caption, form);
      } else if (block.type === 'slider') {
        const input = el('input'); input.id = id; input.type = 'range'; rec.input = input; rec.output = el('output');
        input.oninput = () => { rec.output.textContent = input.value; remember(input.value); };
        input.onchange = async () => { if (await send(block.id, Number(input.value))) rec.dirty = false; };
        wrap.append(caption, input, rec.output);
      } else {
        const input = el('button'); input.id = id; input.type = 'button'; rec.input = input;
        input.onclick = async () => { input.disabled = true; await send(block.id, true); input.disabled = false; }; wrap.append(input);
      }
      return rec;
    }

    function update(rec, block) {
      const label = String(block.label || block.id).slice(0, 200);
      rec.caption.textContent = label; rec.block = block;
      if (block.type === 'message' || block.type === 'status') rec.input.textContent = block.text || label;
      if (block.type === 'button') rec.input.textContent = label;
      if (block.type === 'drawing') rec.input.setAttribute('aria-label', label);
      if (block.type === 'choice') {
        const options = (Array.isArray(block.options) ? block.options : []).slice(0, 30).map(String);
        const sig = JSON.stringify(options);
        if (rec.options !== sig) {
          const value = rec.input.value || drafts[block.id] || block.value || '';
          const empty = el('option', 'Choose…'); empty.value = '';
          rec.input.replaceChildren(empty, ...options.map(value => { const option = el('option', value); option.value = value; return option; }));
          if (value && !options.includes(value)) { const previous = el('option', `${value} (previous choice)`); previous.value = value; rec.input.append(previous); }
          rec.input.value = value; rec.options = sig;
        }
      }
      if (block.type === 'slider') {
        rec.input.min = String(Number.isFinite(+block.min) ? +block.min : 0); rec.input.max = String(Number.isFinite(+block.max) ? +block.max : 100);
        if (!rec.dirty && document.activeElement !== rec.input) rec.input.value = String(drafts[block.id] ?? block.value ?? 50);
        rec.output.textContent = rec.input.value;
      }
    }

    function reconcile(spec, force = false) {
      if (disposed) return;
      const next = (Array.isArray(spec.blocks) ? spec.blocks : []).slice(0, 40).filter(block => block && types.includes(block.type) && typeof block.id === 'string');
      const ids = new Set(); const unique = next.filter(block => { if (ids.has(block.id)) return false; ids.add(block.id); return true; });
      const changedStructure = [...records].some(([id, rec]) => { const b = unique.find(x => x.id === id); return (!b || b.type !== rec.block.type || b.connector !== rec.block.connector) && dirty(rec); });
      if (changedStructure && !force) {
        pendingSpec = spec; notice.hidden = false; updateText.textContent = durableDrafts ? 'The agent has a new layout ready. Finish your input or apply the update. Your draft will stay saved.' : 'The agent has a new layout ready. This browser could not save your draft. Copy or send it before applying.';
        for (const b of unique) { const r = records.get(b.id); if (r && ['message', 'status'].includes(b.type) && r.block.type === b.type) update(r, b); }
        return;
      }
      const active = document.activeElement;
      const selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
      title.textContent = spec.title || ''; title.hidden = !spec.title; description.textContent = spec.description || ''; description.hidden = !spec.description;
      for (const [id, rec] of records) if (!unique.some(b => b.id === id && b.type === rec.block.type && b.connector === rec.block.connector)) { rec.kit?.stop?.(); rec.wrap.remove(); records.delete(id); }
      unique.forEach((block, i) => {
        let rec = records.get(block.id); if (!rec) { rec = create(block); records.set(block.id, rec); }
        update(rec, block);
        const before = blocks.children[i]; if (before !== rec.wrap) blocks.insertBefore(rec.wrap, before || null);
      });
      if (active?.isConnected && document.activeElement !== active) { active.focus({ preventScroll: true }); if (selection) try { active.setSelectionRange(...selection); } catch { /* range inputs */ } }
      if (!pendingReload) notice.hidden = true;
      pendingSpec = null;
    }
    const render = () => reconcile(tendril.state.get(path) || {});
    render(); const off = tendril.state.on(render);
    return { render, saveDrafts: save, destroy() { disposed = true; save(); off(); window.removeEventListener('pagehide', save); window.removeEventListener('tendril:before-reload', protect); for (const rec of records.values()) rec.kit?.stop?.(); host.replaceChildren(); } };
  }
  ns.ui = { supported: () => true, mount, types };
})();
