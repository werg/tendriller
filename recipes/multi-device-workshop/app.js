const $ = id => document.getElementById(id), t = window.tendril;
let stream = null, purpose = "general", devices = [], frameId = null, overlay = null, lastPhoto = null;
const status = text => { $("status").textContent = text; };
const state = () => t.state.get("workshop") || {};
const owner = () => t.device.role === "owner" && !t.device.pending;
const writable = () => t.device.role !== "display" && !t.device.pending;
async function pageApi(path, method = "GET", body) {
  const response = await fetch(`_tendril/${path}`, { method, headers: { ...t.deviceHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error?.message || `Request failed (${response.status})`);
  return value;
}
function describe(result, label) { status(result.status === "rejected" || result.error ? `${label} rejected: ${result.message || result.error}` : result.queued ? `${label} kept on this device; waiting for the connection.` : `${label} received. Waiting for the agent's next step.`); }
function stopCamera() { for (const track of stream?.getTracks() || []) track.stop(); stream = null; $("video").srcObject = null; $("video").hidden = true; $("capture").disabled = true; $("stop-camera").disabled = true; }
function render() {
  const s = state(), step = s.step || {};
  $("title").textContent = s.title || "Multi-device workshop";
  $("step-title").textContent = step.title || "Choose a task with your agent";
  $("step-text").textContent = step.instruction || "Ask the agent to set a workshop step, then open this page on each device.";
  document.body.dataset.purpose = purpose;
  $("device-label").textContent = `${purpose[0].toUpperCase() + purpose.slice(1)} · ${t.device.name || t.device.id} · ${t.device.role}`;
  $("connection").textContent = t.connected ? "Connected" : "Offline — changes will wait";
  $("pause-banner").hidden = !s.paused; $("pause").textContent = s.paused ? "Resume workshop" : "Pause workshop";
  if (s.paused && stream) stopCamera();
  const passive = purpose === "display" || t.device.role === "display";
  $("actions").hidden = passive; $("camera-card").hidden = passive || purpose === "speaker" || purpose === "controller";
  const myReceipt = s.receipts?.[step.id]?.[t.device.id];
  $("done").disabled = !writable() || !!s.paused || !step.id || !!(myReceipt && myReceipt.status !== "rejected");
  $("pause").disabled = !owner(); $("focus").disabled = !owner(); $("apply-purpose").disabled = !owner(); $("purpose").disabled = !owner();
  $("refresh").disabled = !owner(); $("start-camera").disabled = !writable() || !!s.paused || !!stream;
  $("photo").disabled = !writable() || !!s.paused;
  $("speaker-note").hidden = purpose !== "speaker";
  const frame = s.frame;
  if (frame?.id && frame.id !== frameId) {
    frameId = frame.id; $("frame").src = frame.url || `_tendril/blob/${frame.id}`; $("frame").hidden = false;
    $("frame-note").textContent = `Frame from ${frame.device || "a participant"}, ${new Date(frame.at).toLocaleTimeString()}.`;
    $("frame").onload = () => { overlay?.detach(); overlay = tendrilSnippets.overlay.attach($("frame")); render(); };
  }
  const annotation = s.annotations, shapes = annotation?.frame === frameId && Array.isArray(annotation.shapes) ? annotation.shapes : [];
  if (overlay) overlay.draw(shapes);
  $("annotations").replaceChildren(...shapes.filter(shape => shape.text).map(shape => { const li = document.createElement("li"); li.textContent = shape.text; return li; }));
  const receipts = Object.values(s.receipts?.[step.id] || {});
  $("receipts").replaceChildren(...receipts.map(receipt => { const li = document.createElement("li"); li.textContent = `${receipt.device}: ${receipt.status} ${receipt.at ? "at " + new Date(receipt.at).toLocaleTimeString() : ""}`; return li; }));
  if (!receipts.length) $("receipts").textContent = "No completion receipts for this step yet.";
}
async function refresh() {
  if (!owner()) { purpose = t.device.role === "display" ? "display" : "general"; render(); return; }
  try {
    const info = await pageApi("devices"); devices = info.devices || [];
    const me = devices.find(device => device.id === t.device.id);
    purpose = me?.purpose || t.device.purpose || "general"; $("purpose").value = purpose;
    $("devices").replaceChildren(...devices.map(device => { const item = document.createElement("li"); item.textContent = `${device.name || device.id} · ${device.purpose || "general"} · ${device.connected === false ? "offline" : "connected"}`; return item; }));
    render();
  } catch (error) { status(error.message); }
}
$("apply-purpose").onclick = async () => { try { await pageApi("devices", "PATCH", { id: t.device.id, purpose: $("purpose").value }); await refresh(); status("This device's purpose is saved."); } catch (error) { status(error.message); } };
$("refresh").onclick = refresh;
$("focus").onclick = async () => { try { await pageApi("focus", "POST", { device: t.device.id, ttl_seconds: 300 }); status("Attention moved to this device for five minutes."); } catch (error) { status(error.message); } };
$("pause").onclick = async () => { if (!owner()) return; const paused = !state().paused; t.state.set("workshop.paused", paused); if (paused) stopCamera(); describe(await t.send({ type: "workshop.pause", paused, device: t.device.id, at: Date.now() }), paused ? "Pause" : "Resume"); };
$("done").onclick = async () => {
  const step = state().step; if (!step?.id || state().paused || !writable()) return;
  $("done").disabled = true;
  const result = await t.send({ type: "workshop.step_ack", step_id: step.id, action: "done", device: t.device.id, at: Date.now() });
  t.state.set(["workshop", "receipts", step.id, t.device.id], { device: t.device.id, at: Date.now(), status: result.status || (result.error ? "rejected" : result.queued ? "queued" : "accepted") });
  describe(result, "Completion"); render();
};
$("start-camera").onclick = async () => {
  if (!writable() || state().paused) return;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }); $("video").srcObject = stream; $("video").hidden = false; await $("video").play(); $("capture").disabled = false; $("stop-camera").disabled = false; render(); }
  catch (error) { stopCamera(); status(error.name === "NotAllowedError" ? "Camera permission was denied. Choose a photo or use another camera device." : error.message); }
};
$("stop-camera").onclick = () => { stopCamera(); render(); };
async function sendPhoto(blob, name) {
  if (!writable() || state().paused) return;
  const at = Date.now(), step_id = state().step?.id || null;
  const result = await t.uploadEvent(blob, { name, data: { type: "workshop.frame", device: t.device.id, at, step_id } });
  lastPhoto = { capture_id: result.capture_id, at, device: t.device.id, step_id };
  photoResult(result); describe(result, "Photo");
}
function photoResult(result) {
  if (result.status === "accepted" && result.blob && lastPhoto?.capture_id === result.capture_id) {
    t.state.set("workshop.frame", { id: result.blob.id, url: result.blob.url, at: lastPhoto.at, device: t.device.id, step_id: lastPhoto.step_id });
  }
}
$("capture").onclick = async () => {
  if (!stream || !writable() || state().paused) return;
  try { const video = $("video"), canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext("2d").drawImage(video, 0, 0); const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .85)); if (!blob) throw Error("Could not capture this frame"); await sendPhoto(blob, "workshop.jpg"); }
  catch (error) { status(error.message); }
};
$("photo").onchange = async event => { const file = event.target.files?.[0]; if (!file) return; try { await sendPhoto(file, file.name); } catch (error) { status(error.message); } finally { event.target.value = ""; } };
$("frame").onclick = async event => {
  if (!writable() || state().paused || !frameId) return;
  const image = $("frame"), box = image.getBoundingClientRect(), ratio = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight), width = image.naturalWidth * ratio, height = image.naturalHeight * ratio;
  const x = (event.clientX - box.left - (box.width - width) / 2) / width, y = (event.clientY - box.top - (box.height - height) / 2) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  describe(await t.send({ type: "workshop.point", frame: frameId, x, y, device: t.device.id, step_id: state().step?.id }), "Point of interest");
};
$("copy-link").onclick = async () => { try { await navigator.clipboard.writeText(location.href.split("#")[0]); status("Page link copied. Sign in on the other device to join."); } catch { status(`Open this page on the other device: ${location.href.split("#")[0]}`); } };
$("export").onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "tendriller-workshop-notes", version: 1, exported_at: Date.now(), workshop: state(), devices: devices.map(({ id, name, purpose }) => ({ id, name, purpose })) }, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "workshop-notes.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
t.state.on(render); t.on("connect", refresh); t.on("disconnect", render); t.on("role", refresh); t.on("device_config", refresh); t.on("upload_event", photoResult); window.addEventListener("pagehide", stopCamera); render(); if (t.connected) void refresh();
