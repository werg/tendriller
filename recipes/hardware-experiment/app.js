import { createRun, record, annotate, snapshot, parseReading, csv } from "./model.mjs";
const $ = id => document.getElementById(id), t = window.tendril;
let run = null, port = null, timer = null, running = false, ticks = 0, lastPublish = 0, lastAlert = 0, above = false, historySignature = "";
const status = text => { $("status").textContent = text; };
const writable = () => t.device.role !== "display" && !t.device.pending;
const selected = () => $("history").value ? t.state.get(["experiment", "runs", $("history").value]) : run ? snapshot(run) : null;
function receipt(result, label) {
  status(result.status === "rejected" || result.error ? `${label} was rejected: ${result.message || result.error}. Retry when corrected.` : result.queued ? `${label} saved on this device; waiting to send.` : `${label} received. The agent will respond here.`);
}
function save() {
  if (!run || !writable()) return;
  const value = snapshot(run); t.state.set(["experiment", "runs", run.id], value);
  // Keep bounded page state while preserving older runs via explicit export.
  const all = t.state.get("experiment.runs") || {}, ids = Object.keys(all).sort((a, b) => all[b].started_at - all[a].started_at);
  for (const id of ids.slice(5)) t.state.delete(["experiment", "runs", id]);
}
function draw(value) {
  const canvas = $("plot"), ctx = canvas.getContext("2d"), series = value?.series || [], dark = matchMedia("(prefers-color-scheme:dark)").matches;
  const ink = dark ? "#c4dcca" : "#335a40", line = dark ? "#91d4a7" : "#1d6641";
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.font = "16px system-ui"; ctx.fillStyle = ink;
  if (!series.length) { ctx.fillText("Choose a source to see measurements", 30, 170); return; }
  const lo = Math.min(...series.map(p => p.min)), hi = Math.max(...series.map(p => p.max)), range = hi - lo || 1, start = series[0].at, span = Math.max(1000, series.at(-1).at - start);
  const x = at => 80 + (at - start) / span * 890, y = v => 295 - (v - lo) / range * 245;
  ctx.strokeStyle = dark ? "#45604b" : "#d9e3da"; for (let i = 0; i <= 4; i++) { const h = 50 + i * 61.25; ctx.beginPath(); ctx.moveTo(80, h); ctx.lineTo(970, h); ctx.stroke(); ctx.fillText((hi - i * range / 4).toFixed(2), 5, h + 5); }
  ctx.strokeStyle = line; ctx.lineWidth = 3; ctx.beginPath(); series.forEach((p, i) => i ? ctx.lineTo(x(p.at), y(p.mean)) : ctx.moveTo(x(p.at), y(p.mean))); ctx.stroke();
  ctx.fillText(new Date(start).toLocaleTimeString(), 80, 335); ctx.fillText(new Date(series.at(-1).at).toLocaleTimeString(), 845, 335);
  ctx.fillStyle = "#ba762e"; for (const note of value.interventions || []) if (note.at >= start) { ctx.fillRect(x(note.at) - 1, 45, 2, 255); }
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
  $("serial").disabled = !writable() || running || !tendrilSnippets.serial.supported(); $("simulate").disabled = !writable() || running;
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
  if (at - lastPublish >= 5000) { lastPublish = at; save(); void t.send({ type: "experiment.telemetry", run: snapshot(run) }, { wake: false }); }
  const threshold = $("threshold").value === "" ? null : Number($("threshold").value);
  const crossing = threshold !== null && value >= threshold && !above;
  above = threshold !== null && value >= threshold;
  if (crossing && at - lastAlert > 30000) { lastAlert = at; const result = await t.send({ type: "experiment.threshold", run_id: run.id, source: run.source, value, threshold, unit: run.unit, at }); receipt(result, "Threshold observation"); }
  render();
}
function begin(source) {
  run = createRun({ id: crypto.randomUUID(), source, unit: $("unit").value.trim().slice(0, 32) || "units" });
  running = true; ticks = 0; lastPublish = Date.now(); lastAlert = 0; above = false; $("history").value = "";
  status(source === "simulation" ? "Simulation running. These readings are not from hardware." : "Connected. Reading instrument output."); save(); render();
}
async function stop() { running = false; clearInterval(timer); timer = null; const currentPort = port; port = null; if (currentPort) await currentPort.close(); if (run) { run.ended_at = Date.now(); save(); } render(); }
$("simulate").onclick = () => { if (!writable() || running) return; begin("simulation"); timer = setInterval(() => { ticks++; void sample(20 + 3 * Math.sin(ticks / 8) + .2 * Math.sin(ticks)); }, 100); };
$("serial").onclick = async () => {
  if (!writable() || running) return;
  try { port = await tendrilSnippets.serial.connect({ baudRate: Number($("baud").value), onLine: line => { const value = parseReading(line); if (value !== null) void sample(value); }, onError: message => { status(message); void stop(); } }); begin("serial"); }
  catch (error) { status(error.message); }
};
$("stop").onclick = stop;
$("annotate").onclick = async () => { if (!writable()) return; const note = run && annotate(run, $("note").value); if (!note) return; $("note").value = ""; save(); render(); receipt(await t.send({ type: "experiment.intervention", run_id: run.id, source: run.source, note, latest: snapshot(run) }), "Intervention"); };
$("send").onclick = async () => { const value = selected(); if (writable() && value?.count) { save(); receipt(await t.send({ type: "experiment.summary", run: value }), "Run summary"); } };
$("photo").onchange = async event => { const file = event.target.files?.[0]; if (!file || !run || !writable()) return; try { const result = await t.uploadEvent(file, { name: file.name, data: { type: "experiment.photo", run_id: run.id, source: run.source, note: $("note").value, at: Date.now() } }); receipt(result, "Experiment photo"); } catch (error) { status(error.message); } finally { event.target.value = ""; } };
function download(name, contents, type) { const url = URL.createObjectURL(new Blob([contents], { type })), a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$("json").onclick = () => { const value = selected(); if (!value) return status("Start or select a run first."); download(`experiment-${value.id}.json`, JSON.stringify({ format: "tendriller-experiment", version: 1, run: value, interpretation: t.state.get(["experiment", "results", value.id]) || null }, null, 2), "application/json"); };
$("csv").onclick = () => { if (!run || $("history").value && $("history").value !== run.id) return status("Raw samples are available only for this tab's current run. Use report JSON for saved runs."); download(`experiment-${run.id}.csv`, csv(run), "text/csv"); status(`Exported ${run.raw.length} raw samples${run.discarded_raw ? `; ${run.discarded_raw} earlier samples were summarized` : ""}.`); };
$("history").onchange = render;
$("support").textContent = tendrilSnippets.serial.supported() ? "Choose a serial device after pressing Connect. No commands are written to the device." : tendrilSnippets.serial.unsupportedReason() + " Simulation is available on this device.";
t.state.on(render); t.on("role", () => { if (!writable() && running) void stop(); render(); }); t.on("connect", render); t.on("upload_event", result => receipt(result, "Experiment photo")); window.addEventListener("pagehide", () => { clearInterval(timer); void port?.close(); }); render();
