const $ = id => document.getElementById(id), t = window.tendril;
let stream = null, purpose = "general", devices = [], frameId = null, overlay = null, lastPhoto = null;
let cameraGeneration = 0, cameraStarting = false, pageHidden = false, refreshGeneration = 0, photoSending = false, seenSession = null;
const status = text => { $("status").textContent = text; };
const state = () => t.state.get("workshop") || {};
const session = () => ({ scope: "workshop", id: state().session_id || "initial" });
const owner = () => t.device.role === "owner" && !t.device.pending;
const writable = () => t.device.role !== "display" && !t.device.pending;
const cameraAllowed = () => !pageHidden && writable() && !state().paused && (purpose === "general" || purpose === "camera");
async function pageApi(path, method = "GET", body) {
  const response = await fetch(`_tendril/${path}`, { method, headers: { ...t.deviceHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error?.message || `Request failed (${response.status})`);
  return value;
}
function describe(result, label) { status(result.status === "rejected" || result.error ? `${label} rejected: ${result.message || result.error}` : result.queued ? `${label} kept on this device; waiting for the connection.` : `${label} received. Waiting for the agent's next step.`); }
function stopTracks(media) { for (const track of media?.getTracks() || []) track.stop(); }
function stopCamera() {
  ++cameraGeneration; cameraStarting = false;
  stopTracks(stream); stream = null; $("video").srcObject = null; $("video").hidden = true;
  $("capture").disabled = true; $("stop-camera").disabled = true;
}
function clearFrame() {
  frameId = null; overlay?.detach(); overlay = null;
  $("frame").onload = null; $("frame").removeAttribute("src"); $("frame").hidden = true;
  $("frame-note").textContent = "No photo shared yet.";
}
function render() {
  const s = state(), step = s.step || {};
  const generation = session().id; if (seenSession && seenSession !== generation) { stopCamera(); lastPhoto = null; status("A fresh workshop has started. Start the camera again when you are ready."); } seenSession = generation;
  $("title").textContent = s.title || "Multi-device workshop";
  $("step-title").textContent = step.title || "Choose a task with your agent";
  $("step-text").textContent = step.instruction || "Ask the agent to set a workshop step, then open this page on each device.";
  document.body.dataset.purpose = purpose;
  $("device-label").textContent = `${purpose[0].toUpperCase() + purpose.slice(1)} · ${t.device.name || t.device.id} · ${t.device.role}`;
  $("connection").textContent = t.connected ? "Connected" : "Offline — changes will wait";
  $("pause-banner").hidden = !s.paused; $("pause").textContent = s.paused ? "Resume workshop" : "Pause workshop";
  if (!cameraAllowed() && (stream || cameraStarting)) stopCamera();
  const passive = purpose === "display" || t.device.role === "display";
  $("actions").hidden = passive; $("camera-card").hidden = passive || purpose === "speaker" || purpose === "controller";
  const myReceipt = s.receipts?.[step.id]?.[t.device.id];
  $("done").disabled = !writable() || !!s.paused || !step.id || !!(myReceipt && myReceipt.status !== "rejected");
  $("pause").disabled = !owner(); $("focus").disabled = !owner(); $("apply-purpose").disabled = !owner(); $("purpose").disabled = !owner();
  $("refresh").disabled = !owner(); $("start-camera").disabled = !cameraAllowed() || !!stream || cameraStarting;
  $("stop-camera").disabled = !stream && !cameraStarting;
  $("photo").disabled = !cameraAllowed();
  $("speaker-note").hidden = purpose !== "speaker";
  const frame = s.frame;
  if (pageHidden || !frame?.id) clearFrame();
  else if (frame.id !== frameId) {
    clearFrame(); frameId = frame.id;
    $("frame").onload = () => {
      if (pageHidden || frameId !== frame.id || state().frame?.id !== frame.id) return;
      overlay?.detach(); overlay = tendrilSnippets.overlay.attach($("frame")); render();
    };
    $("frame").src = frame.url || `_tendril/blob/${frame.id}`; $("frame").hidden = false;
    $("frame-note").textContent = `Frame from ${frame.device || "a participant"}, ${new Date(frame.at).toLocaleTimeString()}.`;
  }
  const annotation = s.annotations, shapes = frameId && annotation?.frame === frameId && Array.isArray(annotation.shapes) ? annotation.shapes : [];
  if (overlay) overlay.draw(shapes);
  $("annotations").replaceChildren(...shapes.filter(shape => shape.text).map(shape => { const li = document.createElement("li"); li.textContent = shape.text; return li; }));
  const receipts = Object.values(s.receipts?.[step.id] || {});
  $("receipts").replaceChildren(...receipts.map(receipt => { const li = document.createElement("li"); li.textContent = `${receipt.device}: ${receipt.status} ${receipt.at ? "at " + new Date(receipt.at).toLocaleTimeString() : ""}`; return li; }));
  if (!receipts.length) { const li = document.createElement("li"); li.textContent = "No completion receipts for this step yet."; $("receipts").append(li); }
}
async function refresh() {
  const generation = ++refreshGeneration;
  // Role and purpose changes take effect before a slower roster request returns.
  purpose = t.device.role === "display" ? "display" : t.device.purpose || "general"; render();
  if (!owner()) return;
  try {
    const info = await pageApi("devices");
    if (generation !== refreshGeneration || !owner() || pageHidden) return;
    devices = info.devices || [];
    const me = devices.find(device => device.id === t.device.id);
    purpose = me?.purpose || t.device.purpose || "general"; $("purpose").value = purpose;
    $("devices").replaceChildren(...devices.map(device => { const item = document.createElement("li"); item.textContent = `${device.name || device.id} · ${device.purpose || "general"} · ${device.connected === false ? "offline" : "connected"}`; return item; }));
    render();
  } catch (error) { status(error.message); }
}
$("apply-purpose").onclick = async () => { try { await pageApi("devices", "PATCH", { id: t.device.id, purpose: $("purpose").value }); await refresh(); status("This device's purpose is saved."); } catch (error) { status(error.message); } };
$("refresh").onclick = refresh;
$("focus").onclick = async () => { try { await pageApi("focus", "POST", { device: t.device.id, ttl_seconds: 300 }); status("Attention moved to this device for five minutes."); } catch (error) { status(error.message); } };
$("pause").onclick = async () => { if (!owner()) return; const paused = !state().paused; t.state.set("workshop.paused", paused); if (paused) stopCamera(); describe(await t.send({ type: "workshop.pause", session: session(), paused, device: t.device.id, at: Date.now() }), paused ? "Pause" : "Resume"); };
$("done").onclick = async () => {
  const step = state().step; if (!step?.id || state().paused || !writable()) return;
  if (!state().receipts?.[step.id] && Object.keys(state().receipts || {}).length >= 100) { status("This workshop has 100 step receipts. The owner can archive it before continuing a new session."); return; }
  $("done").disabled = true; const sentSession = session();
  const result = await t.send({ type: "workshop.step_ack", session: sentSession, step_id: step.id, action: "done", device: t.device.id, at: Date.now() });
  if (sentSession.id !== session().id) { status("This completion belongs to the previous workshop. Its new session is unchanged."); return; }
  t.state.set(["workshop", "receipts", step.id, t.device.id], { device: t.device.id, at: Date.now(), status: result.status || (result.error ? "rejected" : result.queued ? "queued" : "accepted") });
  describe(result, "Completion"); render();
};
$("start-camera").onclick = async () => {
  if (!cameraAllowed() || stream || cameraStarting) return;
  const generation = ++cameraGeneration;
  const current = () => generation === cameraGeneration && cameraAllowed();
  cameraStarting = true; render();
  let candidate = null;
  try {
    candidate = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    if (!current()) { stopTracks(candidate); return; }
    stream = candidate; $("video").srcObject = candidate; $("video").hidden = false;
    await $("video").play();
    if (!current()) { stopTracks(candidate); return; }
    cameraStarting = false; $("capture").disabled = false; render();
  } catch (error) {
    stopTracks(candidate);
    if (generation !== cameraGeneration) return;
    stopCamera(); render(); status(error.name === "NotAllowedError" ? "Camera permission was denied. Choose a photo or use another camera device." : error.message);
  }
};
$("stop-camera").onclick = () => { stopCamera(); render(); };
async function sendPhoto(blob, name) {
  if (!cameraAllowed() || photoSending) return;
  photoSending = true;
  const sentSession = session(), at = Date.now(), step_id = state().step?.id || null;
  try { const result = await t.uploadEvent(blob, { name, data: { type: "workshop.frame", session: sentSession, device: t.device.id, at, step_id } });
  lastPhoto = { capture_id: result.capture_id, session: sentSession, at, device: t.device.id, step_id };
  photoResult(result); describe(result, "Photo"); } finally { photoSending = false; }
}
function photoResult(result) {
  if (result.status === "accepted" && result.blob && lastPhoto?.capture_id === result.capture_id && lastPhoto.session.id === session().id) {
    t.state.set("workshop.frame", { id: result.blob.id, url: result.blob.url, at: lastPhoto.at, device: t.device.id, step_id: lastPhoto.step_id });
  }
}
$("capture").onclick = async () => {
  if (!stream || !cameraAllowed()) return;
  try { const video = $("video"), canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext("2d").drawImage(video, 0, 0); const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .85)); if (!blob) throw Error("Could not capture this frame"); await sendPhoto(blob, "workshop.jpg"); }
  catch (error) { status(error.message); }
};
$("photo").onchange = async event => { const file = event.target.files?.[0]; if (!file) return; try { await sendPhoto(file, file.name); } catch (error) { status(error.message); } finally { event.target.value = ""; } };
$("frame").onclick = async event => {
  if (!writable() || state().paused || !frameId) return;
  const image = $("frame"), box = image.getBoundingClientRect(), ratio = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight), width = image.naturalWidth * ratio, height = image.naturalHeight * ratio;
  const x = (event.clientX - box.left - (box.width - width) / 2) / width, y = (event.clientY - box.top - (box.height - height) / 2) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  describe(await t.send({ type: "workshop.point", session: session(), frame: frameId, x, y, device: t.device.id, step_id: state().step?.id }), "Point of interest");
};
$("copy-link").onclick = async () => { try { await navigator.clipboard.writeText(location.href.split("#")[0]); status("Page link copied. Sign in on the other device to join."); } catch { status(`Open this page on the other device: ${location.href.split("#")[0]}`); } };
$("export").onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "tendriller-workshop-notes", version: 1, exported_at: Date.now(), workshop: state(), devices: devices.map(({ id, name, purpose }) => ({ id, name, purpose })) }, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "workshop-notes.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
t.state.on(render); t.on("connect", refresh); t.on("disconnect", render); t.on("role", refresh); t.on("device_config", refresh); t.on("upload_event", photoResult);
window.addEventListener("pagehide", () => { pageHidden = true; ++refreshGeneration; stopCamera(); clearFrame(); });
window.addEventListener("pageshow", () => { pageHidden = false; render(); });
render(); if (t.connected) void refresh();

tendrilSnippets.sessionArchive.mount('#session-tools',{scope:'workshop',title:'workshop',guard:()=>stream||cameraStarting?'Stop the camera before archiving this workshop.':photoSending?'Wait for the current photo to finish saving.':null,afterArchive:()=>{stopCamera();lastPhoto=null;clearFrame();render();}});
