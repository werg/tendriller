import { createRun, record, annotate, snapshot, parseReading, csv } from "./model.mjs";
const $ = id => document.getElementById(id), t = window.tendril;
let run = null, port = null, timer = null, running = false, ticks = 0, lastPublish = 0, lastAlert = 0, above = false, historySignature = "", rawExported = true, photoSending = false;
const status = text => { $("status").textContent = text; };
const writable = () => t.device.role !== "display" && !t.device.pending;
const session = () => ({ scope: "experiment", id: t.state.get("experiment.session_id") || "initial" });
const eventSession = value => ({ scope: "experiment", id: value?.session_id || "initial" });
const selected = () => $("history").value ? t.state.get(["experiment", "runs", $("history").value]) : run ? snapshot(run) : null;
function receipt(result, label) {
  status(result.status === "rejected" || result.error ? `${label} was rejected: ${result.message || result.error}. Retry when corrected.` : result.queued ? `${label} saved on this device; waiting to send.` : `${label} received. The agent will respond here.`);
}
function save() {
  if (!run || !writable() || run.session_id !== session().id) return;
  const value = snapshot(run); t.state.set(["experiment", "runs", run.id], value);
}
function draw(value) {
  const canvas = $("plot"), ctx = canvas.getContext("2d"), series = value?.series || [], dark = matchMedia("(prefers-color-scheme:dark)").matches;
  const ink = dark ? "#c4dcca" : "#335a40", line = dark ? "#91d4a7" : "#1d6641";
  // Draw in CSS pixels; scaling a fixed-width bitmap squeezes the labels on phones.
  const { width, height } = canvas.getBoundingClientRect(), density = window.devicePixelRatio || 1;
  if (!width || !height) return;
  const pixelWidth = Math.round(width * density), pixelHeight = Math.round(height * density);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  ctx.clearRect(0, 0, width, height); ctx.font = "14px system-ui"; ctx.fillStyle = ink; ctx.textAlign = "left";
  if (!series.length) {
    const lines = [""];
    for (const word of "Choose a source to see measurements".split(" ")) {
      const candidate = `${lines.at(-1)} ${word}`.trim();
      if (ctx.measureText(candidate).width > width - 24 && lines.at(-1)) lines.push(word);
      else lines[lines.length - 1] = candidate;
    }
    lines.forEach((text, i) => ctx.fillText(text, 12, height / 2 + (i - (lines.length - 1) / 2) * 22));
    return;
  }
  const lo = Math.min(...series.map(p => p.min)), hi = Math.max(...series.map(p => p.max)), range = hi - lo || 1, start = series[0].at, span = Math.max(1000, series.at(-1).at - start);
  const labels = Array.from({ length: 5 }, (_, i) => (hi - i * range / 4).toFixed(2));
  const left = Math.max(...labels.map(label => ctx.measureText(label).width)) + 12, right = width - 8, top = 24, bottom = height - 48;
  const x = at => left + (at - start) / span * (right - left), y = v => bottom - (v - lo) / range * (bottom - top);
  ctx.strokeStyle = dark ? "#45604b" : "#d9e3da"; ctx.lineWidth = 1;
  labels.forEach((label, i) => { const h = top + i * (bottom - top) / 4; ctx.beginPath(); ctx.moveTo(left, h); ctx.lineTo(right, h); ctx.stroke(); ctx.fillText(label, 0, h + 5); });
  ctx.strokeStyle = line; ctx.lineWidth = 3; ctx.beginPath(); series.forEach((p, i) => i ? ctx.lineTo(x(p.at), y(p.mean)) : ctx.moveTo(x(p.at), y(p.mean))); ctx.stroke();
  ctx.font = "12px system-ui";
  const firstTime = new Date(start).toLocaleTimeString(), lastTime = new Date(series.at(-1).at).toLocaleTimeString();
  const stagger = ctx.measureText(firstTime).width + ctx.measureText(lastTime).width + 8 > right - left;
  ctx.fillText(firstTime, left, bottom + 22); ctx.textAlign = "right"; ctx.fillText(lastTime, right, bottom + (stagger ? 40 : 22)); ctx.textAlign = "left";
  ctx.fillStyle = "#ba762e"; for (const note of value.interventions || []) if (note.at >= start) { ctx.fillRect(x(note.at) - 1, top, 2, bottom - top); }
  canvas.setAttribute("aria-label", `${value.source} trace: ${value.count} samples, mean ${value.mean?.toFixed(2)} ${value.unit}, minimum ${value.min?.toFixed(2)}, maximum ${value.max?.toFixed(2)}.`);
}
function render() {
  const value = selected(); draw(value);
  $("source").textContent = value ? `${value.source === "simulation" ? "SIMULATED" : "Serial instrument"} · ${value.unit}` : "No source connected";
  $("source").classList.toggle("simulation", value?.source === "simulation");
  $("run-state").textContent = running ? "Recording" : value ? "Stopped" : "Ready";
  $("count").textContent = `${value?.count || 0} samples`;
  $("stats").textContent = value?.count ? `Min ${value.min.toFixed(2)} · Mean ${value.mean.toFixed(2)} · Max ${value.max.toFixed(2)} ${value.unit}` : "No measurements yet";
  $("stop").disabled = !running; $("send").disabled = !writable() || !value?.count; $("annotate").disabled = !writable() || !run; $("photo").disabled = !writable() || !run;
  const full = Object.keys(t.state.get("experiment.runs") || {}).length >= 5;
  $("serial").disabled = !writable() || running || full || !tendrilSnippets.serial.supported(); $("simulate").disabled = !writable() || running || full;
  $("retention").textContent = full ? "Five reports are kept. Archive this experiment below before starting more runs; none are silently removed." : "Raw readings stay in this tab. Export the CSV before starting another run. Up to five reports stay in shared state.";
  $("notes").replaceChildren(...(value?.interventions || []).map(note => { const item = document.createElement("li"); item.textContent = `${new Date(note.at).toLocaleTimeString()} — ${note.text}`; return item; }));
  const all = t.state.get("experiment.runs") || {}, signature = Object.keys(all).join(",");
  if (signature !== historySignature) { historySignature = signature; const chosen = $("history").value; $("history").replaceChildren(new Option("Current run", ""), ...Object.values(all).sort((a, b) => b.started_at - a.started_at).map(v => new Option(`${new Date(v.started_at).toLocaleTimeString()} · ${v.source}`, v.id))); $("history").value = chosen; }
  const result = value && t.state.get(["experiment", "results", value.id]);
  $("analysis").replaceChildren();
  if (!result) $("analysis").textContent = "Send a summary to ask the agent to interpret the run.";
  else { const text = document.createElement("p"); text.textContent = result.summary || "Interpretation received."; $("analysis").append(text); for (const note of [...(result.observations || []), ...(result.next_steps || [])]) { const p = document.createElement("p"); p.textContent = String(note); $("analysis").append(p); } }
}
async function sample(value, at = Date.now()) {
  if (!running || !writable() || !record(run, value, at)) return;
  rawExported = false;
  if (at - lastPublish >= 5000) { lastPublish = at; save(); void t.send({ type: "experiment.telemetry", session: eventSession(run), run: snapshot(run) }, { wake: false }); }
  const threshold = $("threshold").value === "" ? null : Number($("threshold").value);
  const crossing = threshold !== null && value >= threshold && !above;
  above = threshold !== null && value >= threshold;
  if (crossing && at - lastAlert > 30000) { lastAlert = at; const result = await t.send({ type: "experiment.threshold", session: eventSession(run), run_id: run.id, source: run.source, value, threshold, unit: run.unit, at }); receipt(result, "Threshold observation"); }
  render();
}
function canBegin() {
  if (Object.keys(t.state.get('experiment.runs') || {}).length >= 5) { status('Five reports are kept. Archive this experiment below before starting another run.'); return false; }
  if (run?.raw.length && !rawExported) { status('Export this run’s raw CSV before starting another run. Its readings stay available here.'); return false; }
  return true;
}
function begin(source) {
  if (!canBegin()) return false;
  run = createRun({ id: crypto.randomUUID(), source, session_id: session().id, unit: $("unit").value.trim().slice(0, 32) || "units" });
  rawExported = true; running = true; ticks = 0; lastPublish = Date.now(); lastAlert = 0; above = false; $("history").value = "";
  status(source === "simulation" ? "Simulation running. These readings are not from hardware." : "Connected. Reading instrument output."); save(); render(); return true;
}
async function stop() { running = false; clearInterval(timer); timer = null; const currentPort = port; port = null; if (currentPort) await currentPort.close(); if (run) { run.ended_at = Date.now(); save(); } render(); }
$("simulate").onclick = () => { if (!writable() || running || !begin("simulation")) return; timer = setInterval(() => { ticks++; void sample(20 + 3 * Math.sin(ticks / 8) + .2 * Math.sin(ticks)); }, 100); };
$("serial").onclick = async () => {
  if (!writable() || running || !canBegin()) return;
  try { port = await tendrilSnippets.serial.connect({ baudRate: Number($("baud").value), onLine: line => { const value = parseReading(line); if (value !== null) void sample(value); }, onError: message => { status(message); void stop(); } }); if (!begin("serial")) { const unused = port; port = null; await unused.close(); } }
  catch (error) { status(error.message); }
};
$("stop").onclick = stop;
$("annotate").onclick = async () => { if (!writable()) return; const note = run && annotate(run, $("note").value); if (!note) { if (run?.interventions.length >= 50) status("This run has 50 intervention notes. Stop and export it, then start a new run; your draft stays here."); return; } $("note").value = ""; save(); render(); receipt(await t.send({ type: "experiment.intervention", session: eventSession(run), run_id: run.id, source: run.source, note, latest: snapshot(run) }), "Intervention"); };
$("send").onclick = async () => { const value = selected(); if (writable() && value?.count) { save(); receipt(await t.send({ type: "experiment.summary", session: eventSession(value), run: value }), "Run summary"); } };
$("photo").onchange = async event => { const file = event.target.files?.[0]; if (!file || !run || !writable() || photoSending) return; photoSending = true; try { const result = await t.uploadEvent(file, { name: file.name, data: { type: "experiment.photo", session: eventSession(run), run_id: run.id, source: run.source, note: $("note").value, at: Date.now() } }); receipt(result, "Experiment photo"); } catch (error) { status(error.message); } finally { photoSending = false; event.target.value = ""; } };
function download(name, contents, type) { const url = URL.createObjectURL(new Blob([contents], { type })), a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$("json").onclick = () => { const value = selected(); if (!value) return status("Start or select a run first."); download(`experiment-${value.id}.json`, JSON.stringify({ format: "tendriller-experiment", version: 1, run: value, interpretation: t.state.get(["experiment", "results", value.id]) || null }, null, 2), "application/json"); };
$("csv").onclick = () => { if (!run || $("history").value && $("history").value !== run.id) return status("Raw samples are available only for this tab's current run. Use report JSON for saved runs."); download(`experiment-${run.id}.csv`, csv(run), "text/csv"); rawExported = true; status(`Exported ${run.raw.length} raw samples${run.discarded_raw ? `; ${run.discarded_raw} earlier samples were summarized` : ""}.`); };
$("history").onchange = render;
new ResizeObserver(() => draw(selected())).observe($("plot"));
$("support").textContent = tendrilSnippets.serial.supported() ? "Choose a serial device after pressing Connect. No commands are written to the device." : tendrilSnippets.serial.unsupportedReason() + " Simulation is available on this device.";
t.state.on(() => {
  if (run && run.session_id !== session().id && running) { running = false; clearInterval(timer); timer = null; const old = port; port = null; void old?.close(); status('This experiment was archived on another device. Export any raw readings still in this tab before starting again.'); }
  render();
}); t.on("role", () => { if (!writable() && running) void stop(); render(); }); t.on("connect", render); t.on("upload_event", result => receipt(result, "Experiment photo")); window.addEventListener("pagehide", () => { clearInterval(timer); void port?.close(); }); render();

tendrilSnippets.sessionArchive.mount('#session-tools',{scope:'experiment',title:'experiment',guard:()=>running||port?'Stop the instrument or simulation before archiving.':photoSending?'Wait for the photo to finish saving.':$('note').value.trim()?'Save or clear your intervention draft before archiving.':run?.raw.length&&!rawExported?'Export the raw CSV before archiving. Raw readings are kept in this tab; the archive keeps the bounded report.':null,afterArchive:()=>{run=null;rawExported=true;historySignature='';$('history').value='';render();}});
