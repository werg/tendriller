import { observation, entries, exportNotebook, MAX_ENTRIES } from "./model.mjs";
const t = window.tendril, $ = id => document.getElementById(id);
// Different owner/guest/display links on the same page origin do not share drafts.
const key = `tendriller:notebook:${window.__TENDRIL__?.id || location.pathname}:${window.__TENDRIL__?.base || location.pathname}`;
let selectedPhoto = null, previewUrl = null, locationFix = null, pending = {}, busy = false, deferredApply = null;
const status = text => { $("status").textContent = text; };
const readLocal = (name, fallback) => { try { return JSON.parse(localStorage.getItem(`${key}:${name}`)) || fallback; } catch { return fallback; } };
function writeLocal(name, value) { try { localStorage.setItem(`${key}:${name}`, JSON.stringify(value)); return true; } catch { status("This browser could not save a local draft. Keep the page open until the agent has stored your observation."); return false; } }
pending = readLocal("pending", {});
const draft = readLocal("draft", {}); $("note").value = draft.note || ""; $("tags").value = draft.tags || "";
locationFix = draft.location || null;
function saveDraft() { writeLocal("draft", { note: $("note").value, tags: $("tags").value, location: locationFix, include_location: $("include-location").checked }); }
$("note").addEventListener("input", saveDraft); $("tags").addEventListener("input", saveDraft);
function element(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
function action(label, fn) { const button = element("button", label); button.type = "button"; button.onclick = fn; return button; }
const session = () => ({ scope: "notebook", id: t.state.get("notebook.session_id") || "initial" });
let knownSession = session().id;
const editable = () => t.device.role === "owner" && !t.device.pending;
const applyUpdate = action("Apply page update", () => { if (!busy && !selectedPhoto) deferredApply?.(); });
applyUpdate.hidden = true; $("compose").append(applyUpdate);
const all = () => entries(t.state.get("notebook.entries") || {}, editable() ? pending : {}, $("filter").value);
function remember(entry) { pending[entry.id] = entry; writeLocal("pending", pending); render(); }
function render() {
  $("connection").textContent = t.connected ? "Connected" : "Offline · drafts stay here"; $("connection").dataset.offline = String(!t.connected);
  for (const input of $("observation-form").querySelectorAll("input,textarea,button")) input.disabled = busy || !editable();
  $("compose").hidden = !editable(); applyUpdate.hidden = !deferredApply; applyUpdate.disabled = busy || !!selectedPhoto;
  const items = all(); $("count").textContent = `${items.length} observation${items.length === 1 ? "" : "s"} · newest first · up to ${MAX_ENTRIES} per notebook`;
  const queued = editable() ? Object.values(pending).filter(entry => entry.status === "queued").length : 0;
  $("queue").textContent = queued ? `${queued} observation${queued === 1 ? "" : "s"} waiting on this device. Media and its context travel together when the connection returns.` : "";
  if (editable() && $("timeline").contains(document.activeElement)) return;
  const nodes = items.map(entry => {
    const article = element("article", undefined, "entry"); article.dataset.id = entry.id;
    article.append(element("span", new Date(entry.created_at).toLocaleString(), "badge"), element("p", entry.note || "Photo observation"));
    if (entry.photo?.id) { const image = element("img"); image.src = `_tendril/blob/${encodeURIComponent(entry.photo.id)}`; image.alt = "Photo attached to the observation"; image.loading = "lazy"; article.append(image); }
    if (entry.location) {
      const link = element("a", `${entry.location.latitude.toFixed(5)}, ${entry.location.longitude.toFixed(5)} · ±${Math.round(entry.location.accuracy)} m`);
      link.href = `https://www.openstreetmap.org/?mlat=${entry.location.latitude}&mlon=${entry.location.longitude}#map=16/${entry.location.latitude}/${entry.location.longitude}`; link.target = "_blank"; link.rel = "noopener noreferrer";
      const place = element("p"); place.append(link); article.append(place);
    }
    if (entry.interpretation) article.append(element("p", entry.interpretation, "interpretation"));
    article.append(element("footer", `${(entry.tags || []).map(tag => "#" + tag).join("  ")} ${(entry.session_id || "initial") !== session().id ? "· Previous-session recovery " : ""}${entry.status === "queued" ? "· Waiting to send" : entry.status === "rejected" ? "· Needs retry" : entry.interpretation ? "· Interpretation available" : "· Waiting for the agent’s interpretation"}`));
    if (editable() && !["queued", "rejected"].includes(entry.status)) {
      const details = element("details"), summary = element("summary", "Edit the interpretation"), text = element("textarea"); text.rows = 3; text.maxLength = 4000; text.value = entry.interpretation || ""; text.setAttribute("aria-label", "Interpretation for this observation");
      const draftKey = "interpretation:" + entry.id, saved = readLocal(draftKey, null); if (typeof saved === "string") text.value = saved;
      text.oninput = () => writeLocal(draftKey, text.value);
      details.append(summary, text, action("Save interpretation", () => {
        // State writes are optimistic. Keep the local text until an authoritative
        // remote value matches it, so a later quota/permission rejection is safe.
        writeLocal(draftKey, text.value);
        t.state.set(["notebook", "entries", entry.id, "interpretation"], text.value.trim());
        status(t.connected ? "Interpretation saved on this device and sent for syncing." : "Interpretation saved on this device. It will sync when connected.");
      }));
      const previous = [...$("timeline").children].find(node => node.dataset.id === entry.id)?.querySelector("details[open]");
      article.append(previous || details);
    }
    if (entry.status === "rejected" && editable()) {
      article.append(element("p", entry.error || "Could not send this observation."));
      if ((entry.session_id || "initial") === session().id) article.append(action("Retry observation", () => void retry(entry)));
      const removal = element("details"); removal.append(element("summary", "Remove local rejected copy…"), element("p", "Export notes first if you want to keep this observation. Removing it stops its local retry; any already uploaded media stays on the page."), action("Remove this local copy", async () => { if (entry.capture_id) await t.discardCapture(entry.capture_id); delete pending[entry.id]; writeLocal("pending", pending); render(); })); article.append(removal);
    }
    return article;
  });
  $("timeline").replaceChildren(...(nodes.length ? nodes : [element("p", "Your first observation starts the trail. A note or a photo is enough.", "empty")]));
}
function clearPhoto() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; selectedPhoto = null; $("photo").value = ""; $("photo-preview").hidden = $("remove-photo").hidden = true; applyUpdate.disabled = busy; }
$("photo").onchange = () => { const file = $("photo").files?.[0]; if (!file) return; if (!file.type.startsWith("image/")) { status("Choose an image for this observation."); return; } if (previewUrl) URL.revokeObjectURL(previewUrl); selectedPhoto = file; previewUrl = URL.createObjectURL(file); $("photo-preview").src = previewUrl; $("photo-preview").hidden = $("remove-photo").hidden = false; };
$("remove-photo").onclick = clearPhoto;
$("locate").onclick = () => {
  if (!navigator.geolocation) { status("This browser does not provide location. You can describe the place in your note."); return; }
  status("Finding this place…"); navigator.geolocation.getCurrentPosition(position => {
    locationFix = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy };
    $("location-detail").textContent = `${locationFix.latitude.toFixed(5)}, ${locationFix.longitude.toFixed(5)} · accuracy about ${Math.round(locationFix.accuracy)} metres. Review before saving.`;
    $("location-review").hidden = false; $("include-location").checked = true; saveDraft(); status("Location is ready to review.");
  }, error => status(error.code === 1 ? "Location permission was declined. Your note and photo still work." : "Could not get a location. Try again outdoors or describe the place."), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
};
function resultFor(entry, result) {
  if ((entry.session_id || 'initial') !== session().id) {
    remember({ ...entry, capture_id: result.capture_id || entry.capture_id, status: 'rejected', error: 'This observation belongs to a previous session. Check saved archives or export this local recovery copy before removing it.' }); return false;
  }
  if (result.status === "rejected") { remember({ ...entry, capture_id: result.capture_id || entry.capture_id, status: "rejected", error: result.message || String(result.error) }); return false; }
  const latest = t.state.get(["notebook", "entries", entry.id]) || {};
  const saved = { ...entry, ...(result.capture_id ? { capture_id: result.capture_id } : {}), ...(result.blob ? { photo: { id: result.blob.id, name: entry.photo_name || "Observation photo" } } : {}), ...latest, status: result.status };
  delete saved.error; remember(saved);
  if (result.status === "accepted" && (entry.session_id || "initial") === session().id) t.state.set(["notebook", "entries", entry.id], saved);
  return true;
}
$("observation-form").onsubmit = async event => {
  event.preventDefault(); if (busy || !editable()) return;
  if (entries(t.state.get("notebook.entries"), pending).length >= MAX_ENTRIES) { status("This notebook has 100 observations. Export it and create a new notebook before adding more."); return; }
  busy = true; render();
  let submitted;
  try {
    const entry = observation({ note: $("note").value, tags: $("tags").value, photo: selectedPhoto, location: $("include-location").checked ? locationFix : null });
    submitted = entry;
    if (selectedPhoto) entry.photo_name = selectedPhoto.name;
    entry.session_id = session().id;
    remember({ ...entry, status: "queued" });
    const data = { type: "notebook.observation", session: session(), observation_id: entry.id, entry };
    const result = selectedPhoto ? await t.uploadEvent(selectedPhoto, { name: selectedPhoto.name, keep: true, data }) : await t.send(data);
    if (resultFor(entry, result)) {
      $("note").value = $("tags").value = ""; clearPhoto(); locationFix = null; $("location-review").hidden = true; saveDraft();
      status(result.queued ? "Saved on this device. It will send when connected." : "Observation received. Your agent can add an interpretation here.");
    } else status(result.message || "Your observation is kept below for retry.");
  } catch (error) { if (submitted) remember({ ...submitted, status: "rejected", error: error.message }); status(error.message || "Could not save this observation. Your draft is still here."); }
  finally { busy = false; render(); }
};
async function retry(entry) {
  try { const result = entry.capture_id ? await t.retryCapture(entry.capture_id) : await t.send({ type: "notebook.observation", session: { scope: "notebook", id: entry.session_id || "initial" }, observation_id: entry.id, entry }); resultFor(entry, result); status(result.status === "accepted" ? "Observation received." : result.message || "Observation is queued."); }
  catch (error) { status(error.message); }
}
function discoverCaptures() {
  if (!editable()) { render(); return; }
  for (const capture of t.captures()) if (capture.data.type === "notebook.observation" && capture.data.entry?.id) {
    const entry = capture.data.entry; pending[entry.id] = { ...entry, capture_id: capture.capture_id, status: capture.status, error: capture.message };
  }
  writeLocal("pending", pending); render();
}
t.on("upload_event", result => { const entry = Object.values(pending).find(entry => entry.capture_id === result.capture_id); if (entry) resultFor(entry, result); });
t.on("send_result", result => { const id = result.data?.observation_id; if (result.data?.type === "notebook.observation" && pending[id]) resultFor(pending[id], result); });
t.on("capture_queue", discoverCaptures); t.on("connect", discoverCaptures); t.on("disconnect", render); t.on("role", render);
t.state.on((_state, ops, by) => {
  const remote = by === "server" || by?.startsWith("agent:") || (by?.startsWith("device:") && by !== `device:${t.device.id}`);
  // A cached/reset state can contain optimistic local operations. Confirm only
  // values present in actual remote operations, rather than the merged view.
  if (remote) for (const op of ops || []) {
    if (op.op !== "set") continue;
    const path = op.path || [], updates = new Map();
    if (!path.length) for (const [id, entry] of Object.entries(op.value?.notebook?.entries || {})) updates.set(id, entry);
    else if (path[0] === "notebook") {
      if (path.length === 1) for (const [id, entry] of Object.entries(op.value?.entries || {})) updates.set(id, entry);
      else if (path[1] === "entries") {
        if (path.length === 2) for (const [id, entry] of Object.entries(op.value || {})) updates.set(id, entry);
        else if (path.length === 3) updates.set(path[2], op.value);
        else if (path.length === 4 && path[3] === "interpretation") updates.set(path[2], { interpretation: op.value });
      }
    }
    for (const [id, entry] of updates) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.status === "accepted" || typeof entry.interpretation === "string") delete pending[id];
      const local = readLocal(`interpretation:${id}`, null);
      if (typeof local === "string" && typeof entry.interpretation === "string" && local.trim() === entry.interpretation) writeLocal(`interpretation:${id}`, null);
    }
  }
  if (knownSession !== session().id) {
    knownSession = session().id;
    for (const [id, entry] of Object.entries(pending)) if ((entry.session_id || 'initial') !== knownSession)
      pending[id] = { ...entry, status: 'rejected', error: 'This local observation belongs to the previous session. Check the saved archive or export it before removing this recovery copy.' };
    if (editable()) status('A fresh notebook session started. Any unfinished local work is kept here for recovery.');
  }
  if (by === "rejected" && editable()) status("A shared edit was not accepted. Your observation backups and interpretation drafts are still on this device.");
  writeLocal("pending", pending); render();
});
$("filter").oninput = render; $("timeline").addEventListener("focusout", () => setTimeout(render, 0));
$("export").onclick = () => { const data = exportNotebook(entries(t.state.get("notebook.entries"), editable() ? pending : {})); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "field-notebook.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); status("Notes exported. Use an include-data bundle in Settings for photo bytes."); };
$("print").onclick = () => window.print();
window.addEventListener("pagehide", () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
$("include-location").onchange = saveDraft;
if (locationFix) { $("location-review").hidden = false; $("include-location").checked = draft.include_location !== false; $("location-detail").textContent = `${Number(locationFix.latitude).toFixed(5)}, ${Number(locationFix.longitude).toFixed(5)} · accuracy about ${Math.round(locationFix.accuracy)} metres. Saved with your draft; locate again if you have moved.`; }
window.addEventListener("tendril:before-reload", event => { if (selectedPhoto || busy) { event.preventDefault(); deferredApply = event.detail.apply; status("An update is ready. Save or remove your photo, then apply it when ready."); render(); } });
render(); if (t.connected) discoverCaptures();

tendrilSnippets.sessionArchive.mount('#session-tools', { scope: 'notebook', title: 'field notebook',
  guard: () => {
    if (busy || selectedPhoto || $('note').value.trim() || $('tags').value.trim()) return 'Save or clear your unfinished observation before archiving. Your draft stays here.';
    const shared = t.state.get('notebook.entries') || {};
    if (Object.values(pending).some(entry => ['queued','rejected'].includes(entry.status) || !shared[entry.id])) return 'Resolve the observations waiting on this device before archiving.';
    if (Object.values(shared).some(entry => { const draft = readLocal('interpretation:' + entry.id, null); return typeof draft === 'string' && draft.trim() !== (entry.interpretation || ''); })) return 'Save your interpretation drafts before archiving. They stay on this device.';
    return null;
  },
  afterArchive: ({archive}) => {
    for (const id of Object.keys(archive.shared_state?.notebook?.entries || {})) { delete pending[id]; writeLocal('interpretation:' + id, null); }
    writeLocal('pending', pending); $('filter').value = ''; render();
  }
});
