/* Tendriller snippet: list.js — a shared list (shopping, packing, to-do) stored in tendril state.
 *
 *   <section id="shopping"></section>
 *   <script src="_tendril/snippets/list.js"></script>
 *   <script>
 *     const list = tendrilSnippets.list.mount("#shopping", { path: "shopping", title: "Shopping list" });
 *     tendril.expose?.("tick", { phrases: ["tick *", "got *"] }, ({ text }) => list.tickByText(text));
 *   </script>
 *
 * State layout (records keyed by id, so two devices or the agent adding at once never collide):
 *   {"shopping": {"i_lx2k9a": {"text":"milk","done":false,"ts":1763040000000,"by":"d_…"}, …}}
 * The agent adds an item with PATCH <api>/state {"shopping": {"i_agent1": {"text":"eggs","done":false,"ts":…}}}
 * and removes one with {"shopping": {"i_agent1": null}}. Items sort by `ts`.
 *
 * mount(target, {path, title, placeholder, showClear=true}) → {add(text), tick(id, done), remove(id),
 *   edit(id, text), tickByText(text), clearDone(), items(), destroy()}
 * Works offline: tendril.state keeps a local copy and syncs on reconnect. Without window.tendril
 * (e.g. opened as a plain file) it falls back to localStorage on this device only.
 * Accessible: real form controls and labels, buttons named per item, changes announced politely.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const supported = () => true;
  const toPath = (p) => (Array.isArray(p) ? p : String(p).split("."));
  const newId = () => "i_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /** localStorage stand-in with the same shape as tendril.state, for pages without the runtime. */
  function localStore() {
    const KEY = "tendril-snippets:list-state";
    let state = {};
    try { state = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
    const fns = new Set();
    const walk = (path, create) => {
      let o = state;
      for (const k of path.slice(0, -1)) { if (o[k] == null) { if (!create) return null; o[k] = {}; } o = o[k]; }
      return o;
    };
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} fns.forEach((f) => f(state)); };
    return {
      get: (p) => { if (p == null) return state; const path = toPath(p); const o = walk(path, false); return o ? o[path[path.length - 1]] : undefined; },
      set: (p, v) => { const path = toPath(p); walk(path, true)[path[path.length - 1]] = v; save(); },
      delete: (p) => { const path = toPath(p); const o = walk(path, false); if (o) { delete o[path[path.length - 1]]; save(); } },
      on: (f) => { fns.add(f); return () => fns.delete(f); },
    };
  }

  function mount(target, { path = "list", title = "List", placeholder = "Add an item", showClear = true } = {}) {
    const host = typeof target === "string" ? document.querySelector(target) : target;
    const store = (window.tendril && window.tendril.state) || localStore();
    const base = toPath(path);
    const uid = "tl" + Math.random().toString(36).slice(2, 7);

    host.classList.add("tendril-list");
    host.innerHTML = "";
    const h = document.createElement("h2");
    h.id = uid + "-title";
    h.textContent = title;
    const form = document.createElement("form");
    form.innerHTML = `<label for="${uid}-new" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">New item for ${title}</label>
      <input id="${uid}-new" autocomplete="off" placeholder="${placeholder.replace(/"/g, "&quot;")}" style="font:inherit;min-height:44px;padding:0 .6em;flex:1">
      <button type="submit" style="font:inherit;min-height:44px;min-width:44px;padding:0 1em">Add</button>`;
    form.style.cssText = "display:flex;gap:.5em;margin:.5em 0";
    const ul = document.createElement("ul");
    ul.setAttribute("aria-labelledby", h.id);
    ul.style.cssText = "list-style:none;padding:0;margin:0";
    const empty = document.createElement("p");
    empty.textContent = "Nothing here yet.";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Remove ticked items";
    clear.style.cssText = "font:inherit;min-height:44px;margin-top:.5em";
    const live = document.createElement("p");
    live.setAttribute("role", "status");
    live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)";
    host.append(h, form, ul, empty, clear, live);
    const input = form.querySelector("input");
    const say = (msg) => { live.textContent = msg; };

    const items = () => Object.entries(store.get(base) || {})
      .filter(([, v]) => v && typeof v === "object")
      .map(([id, v]) => ({ id, text: String(v.text ?? ""), done: !!v.done, ts: v.ts || 0, by: v.by }))
      .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

    const api = {
      items,
      add(text) {
        text = String(text || "").trim();
        if (!text) return null;
        const id = newId();
        const by = window.tendril && window.tendril.device ? window.tendril.device.id : undefined;
        store.set([...base, id], { text, done: false, ts: Date.now(), ...(by ? { by } : {}) });
        say(`Added ${text}`);
        render();
        return id;
      },
      tick(id, done = true) {
        store.set([...base, id, "done"], !!done);
        render();
      },
      remove(id) {
        const it = items().find((i) => i.id === id);
        store.delete([...base, id]);
        if (it) say(`Removed ${it.text}`);
        render();
      },
      edit(id, text) {
        text = String(text || "").trim();
        if (text) store.set([...base, id, "text"], text);
      },
      tickByText(text) {
        const t = String(text || "").trim().toLowerCase();
        const it = items().find((i) => !i.done && i.text.toLowerCase() === t) || items().find((i) => !i.done && i.text.toLowerCase().includes(t));
        if (it) { api.tick(it.id, true); say(`Ticked ${it.text}`); }
        return !!it;
      },
      clearDone() { items().filter((i) => i.done).forEach((i) => store.delete([...base, i.id])); say("Removed ticked items"); render(); },
      destroy() { off(); host.innerHTML = ""; },
    };

    function row(it) {
      const li = document.createElement("li");
      li.dataset.id = it.id;
      li.style.cssText = "display:flex;align-items:center;gap:.5em;min-height:44px";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = `${uid}-${it.id}`;
      cb.checked = it.done;
      cb.style.cssText = "width:1.4em;height:1.4em";
      cb.onchange = () => { api.tick(it.id, cb.checked); say(`${it.text} ${cb.checked ? "ticked" : "unticked"}`); };
      const label = document.createElement("label");
      label.htmlFor = cb.id;
      label.textContent = it.text;
      label.style.cssText = "flex:1" + (it.done ? ";text-decoration:line-through;opacity:.7" : "");
      const btn = (text, name, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.setAttribute("aria-label", name);
        b.style.cssText = "font:inherit;min-height:44px;min-width:44px";
        b.onclick = fn;
        return b;
      };
      const edit = btn("Edit", `Edit ${it.text}`, () => {
        const field = document.createElement("input");
        field.value = it.text;
        field.setAttribute("aria-label", `New text for ${it.text}`);
        field.style.cssText = "flex:1;font:inherit;min-height:44px";
        const done = (save) => { if (save) api.edit(it.id, field.value); render(true); };
        field.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
        field.onblur = () => done(true);
        label.replaceWith(field);
        field.focus();
      });
      const del = btn("Remove", `Remove ${it.text}`, () => api.remove(it.id));
      li.append(cb, label, edit, del);
      return li;
    }

    function render(force) {
      const editing = ul.querySelector("li input:not([type=checkbox])");
      if (editing && !force) return; // do not yank the field away while the user types
      const focusedId = document.activeElement && document.activeElement.closest && document.activeElement.closest("li") && document.activeElement.closest("li").dataset.id;
      const focusedIdx = focusedId ? [...document.activeElement.closest("li").children].indexOf(document.activeElement) : -1;
      const list = items();
      ul.replaceChildren(...list.map(row));
      empty.hidden = list.length > 0;
      clear.hidden = !showClear || !list.some((i) => i.done);
      if (focusedId) {
        const li = ul.querySelector(`li[data-id="${focusedId}"]`);
        const target = li ? li.children[focusedIdx] || li.firstChild : input;
        target && target.focus();
      }
    }

    form.onsubmit = (e) => { e.preventDefault(); api.add(input.value); input.value = ""; input.focus(); };
    clear.onclick = () => api.clearDone();
    const off = store.on(() => render());
    render();
    return api;
  }

  ns.list = { supported, mount };
})();
