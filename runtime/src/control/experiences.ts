import type { Core } from "../types";
import { clear, h } from "./dom";

// Reopening the details section keeps the same form, drafts and focused elements.
const mounted = new WeakSet<HTMLElement>();
type BriefFields = { purpose: string; current_task: string; open_questions: string[] };
const briefFields = (value: any): BriefFields => ({ purpose: value?.purpose || "", current_task: value?.current_task || "", open_questions: Array.isArray(value?.open_questions) ? value.open_questions : [] });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Preserve the latest agent checkpoint, and identify conflicting human edits. */
export function planContextSave(base: BriefFields, values: BriefFields, latest: any) {
  const edited = (Object.keys(values) as (keyof BriefFields)[]).filter(key => !equal(values[key], base[key]));
  const current = briefFields(latest);
  const conflicts = edited.filter(key => !equal(current[key], base[key]) && !equal(current[key], values[key]));
  const next = { ...latest };
  for (const key of edited) next[key] = values[key];
  return { edited, conflicts, next };
}

/** Owner controls use authenticated page endpoints; no agent credential enters the browser. */
export function mountExperienceSettings(host: HTMLElement, core: Core): void {
  if (core.device.role !== "owner" || core.device.pending) { clear(host, h("p", { text: "Only the owner can manage saved work and timers." })); return; }
  if (mounted.has(host) && host.childElementCount) return;
  mounted.add(host);
  const key = `tendril:${core.config.id}:experience-drafts`;
  let draft: any = {};
  try { draft = JSON.parse(sessionStorage.getItem(key) || "{}"); } catch { /* optional browser storage */ }
  if (!draft || typeof draft !== "object") draft = {};
  let busy = false, sessionLoaded = false, pendingApply: (() => void) | null = null;
  let summary: any = null, baseline: BriefFields | null = draft.brief?.baseline ? briefFields(draft.brief.baseline) : null;
  let conflict: any = null;
  const status = h("p", { role: "status", "aria-live": "polite" });
  const sections = h("div", { class: "experience-settings" });
  const update = h("div", { class: "experience-card", hidden: true });
  clear(host, status, update, sections);
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(core.config.base + "_tendril/" + path, { method, credentials: "same-origin",
      headers: { ...core.deviceHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 204) return null;
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error?.message || `Request failed (${response.status})`);
    return result;
  };
  const actionButtons = new Set<HTMLButtonElement>();
  function syncBusy() {
    for (const action of actionButtons) action.disabled = busy;
    for (const input of [purpose, task, questions]) input.disabled = !sessionLoaded;
    briefSubmit.disabled = busy || !sessionLoaded; resumePrompt.disabled = busy || !sessionLoaded;
    imported.disabled = busy; host.setAttribute("aria-busy", String(busy));
  }
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true; syncBusy(); status.textContent = "Working…";
    try { await fn(); }
    catch (e) { status.textContent = e instanceof Error ? e.message : "Could not complete that action."; }
    finally { busy = false; syncBusy(); }
  };
  const button = (text: string, fn: () => Promise<void>, cls = "btn") => {
    const action = h("button", { type: "button", class: cls, onclick: () => void run(fn) }, text);
    actionButtons.add(action); return action;
  };
  const field = (label: string, input: HTMLElement) => h("label", { class: "experience-field" }, h("span", { text: label }), input);
  const download = (data: unknown, name: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = h("a", { href: url, download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const localDate = (at: number) => { const date = new Date(at); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); };

  const timerList = h("div"), history = h("div"), lifetime = h("p", { class: "muted" });
  const title = h("input", { type: "text", required: true, maxlength: 200, placeholder: "Check the experiment", value: draft.timer?.title || "" });
  const when = h("input", { type: "datetime-local", required: true, value: draft.timer?.when || localDate(Date.now() + 5 * 60000) });
  const repeat = h("select", null, h("option", { value: "once" }, "Once"), h("option", { value: "interval" }, "Every few minutes"), h("option", { value: "daily" }, "Every day")); repeat.value = draft.timer?.repeat || "once";
  const interval = h("input", { type: "number", min: 1, max: 525600, value: draft.timer?.interval || 30 });
  const daily = h("input", { type: "time", value: draft.timer?.daily || "09:00" });
  const timezone = h("input", { type: "text", value: draft.timer?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  const missed = h("select", null, h("option", { value: "fire_once" }, "Run once if late"), h("option", { value: "skip" }, "Skip if over two minutes late")); missed.value = draft.timer?.missed || "fire_once";
  const notify = h("input", { type: "checkbox", checked: draft.timer?.notify === true }); notify.style.width = "auto";
  const minutesField = field("Minutes between runs", interval), dailyField = field("Daily time", daily), zoneField = field("Recurrence time zone", timezone);
  const updateRepeat = () => { minutesField.hidden = repeat.value !== "interval"; dailyField.hidden = zoneField.hidden = repeat.value !== "daily"; };
  repeat.onchange = updateRepeat; updateRepeat();
  const timerSnapshot = () => ({ title: title.value, when: when.value, repeat: repeat.value, interval: interval.value, daily: daily.value, timezone: timezone.value, missed: missed.value, notify: notify.checked });
  async function loadTimers() {
    const [data, past] = await Promise.all([request("timers"), request("timers/history")]);
    lifetime.textContent = data.expires_at == null ? "This is a resident page. Timers continue while the page is available."
      : `This page currently expires ${new Date(data.expires_at).toLocaleString()}. Repeating timers stop when it expires. Ask your agent to make the page resident for a longer schedule.`;
    when.max = data.expires_at == null ? "" : localDate(data.expires_at - 1);
    clear(timerList, ...(data.timers.length ? data.timers.map((timer: any) => h("article", { class: "experience-card" },
      h("strong", { text: timer.title }), h("p", { text: `${timer.state} · ${new Date(timer.due_at).toLocaleString()} · ${timer.timezone}` }),
      timer.state === "scheduled" ? button("Cancel timer", async () => { await request(`timers/${timer.id}`, "PATCH", { state: "cancelled" }); await loadTimers(); status.textContent = "Timer cancelled."; })
        : button("Remove timer", async () => { await request(`timers/${timer.id}`, "DELETE"); await loadTimers(); status.textContent = "Timer removed."; }))) : [h("p", { class: "muted", text: "No timers yet." })]));
    const names = new Map(data.timers.map((timer: any) => [timer.id, timer.title]));
    clear(history, ...(past.runs.length ? past.runs.slice(0, 10).map((r: any) => h("p", { text: `${names.get(r.timer_id) || "Timer"} · ${r.status} · ${new Date(r.fired_at).toLocaleString()}${r.delivery ? ` · notification ${r.delivery.state} · ${r.delivery.attempts} attempt${r.delivery.attempts === 1 ? "" : "s"}${r.delivery.next_attempt_at ? " · next retry " + new Date(r.delivery.next_attempt_at).toLocaleString() : ""}${r.delivery.last_error ? " · " + r.delivery.last_error : ""}` : r.notification ? " · " + r.notification : ""}` })) : [h("p", { text: "No timer runs yet." })]));
  }
  const timerSubmit = h("button", { type: "submit", class: "btn primary" }, "Add timer"); actionButtons.add(timerSubmit);
  const timerForm = h("form", { class: "experience-form" }, field("Timer name", title), field("First run (this device’s time)", when), field("Repeat", repeat), minutesField, dailyField, zoneField,
    field("If the server runs late", missed), field("Also notify my devices", notify), timerSubmit);
  timerForm.onsubmit = e => { e.preventDefault(); void run(async () => {
    const submitted = timerSnapshot();
    await request("timers", "POST", { title: submitted.title, due_at: new Date(submitted.when).getTime(), timezone: submitted.timezone,
      ...(submitted.repeat === "interval" ? { repeat: { every_minutes: Number(submitted.interval) } } : submitted.repeat === "daily" ? { repeat: { at: submitted.daily } } : {}), missed: submitted.missed, notify: submitted.notify });
    if (equal(timerSnapshot(), submitted)) title.value = "";
    saveDrafts(); await loadTimers(); status.textContent = "Timer saved. It runs on the server while this page is available, including when your browser is closed.";
  }); };
  sections.append(h("details", null, h("summary", null, "Durable timers"), h("p", { class: "muted", text: "Agent replies depend on its connection; notifications use your existing permission." }), lifetime, timerList, timerForm,
    button("Refresh timers and history", async () => { await loadTimers(); status.textContent = "Timers refreshed."; }), h("details", null, h("summary", null, "Execution history"), history)));

  const initialBrief = briefFields(draft.brief?.values);
  const purpose = h("textarea", { rows: 2, maxlength: 4000, value: initialBrief.purpose });
  const task = h("textarea", { rows: 3, maxlength: 4000, value: initialBrief.current_task });
  const questions = h("textarea", { rows: 3, placeholder: "One open question per line", value: typeof draft.brief?.rawQuestions === "string" ? draft.brief.rawQuestions : initialBrief.open_questions.join("\n") });
  const resumeState = h("p", { class: "muted" }), conflicts = h("div", { class: "experience-card", hidden: true });
  const currentBrief = (): BriefFields => ({ purpose: purpose.value, current_task: task.value, open_questions: questions.value.split("\n").map(s => s.trim()).filter(Boolean) });
  const setBrief = (values: BriefFields) => {
    if (purpose.value !== values.purpose) purpose.value = values.purpose;
    if (task.value !== values.current_task) task.value = values.current_task;
    if (!equal(currentBrief().open_questions, values.open_questions)) questions.value = values.open_questions.join("\n");
  };
  const editedFields = () => (Object.keys(currentBrief()) as (keyof BriefFields)[]).filter(key => !baseline || !equal(currentBrief()[key], baseline[key]));
  function showConflict(latest: any, changed: (keyof BriefFields)[]) {
    // Bring untouched fields forward before offering to keep the human draft;
    // otherwise an old, untouched value could become a new accidental edit.
    if (baseline) {
      const local = currentBrief(), edited = editedFields(), next = briefFields(latest.session);
      for (const key of Object.keys(next) as (keyof BriefFields)[]) if (!edited.includes(key)) { (local as any)[key] = next[key]; (baseline as any)[key] = next[key]; }
      setBrief(local);
    }
    conflict = latest; conflicts.hidden = false;
    const labels = { purpose: "purpose", current_task: "where to continue", open_questions: "open questions" };
    clear(conflicts, h("p", { text: `The saved ${changed.map(key => labels[key]).join(", ")} changed while you were editing. Your draft is kept. Review the latest context below before choosing which text to keep.` }),
      h("pre", { style: "white-space:pre-wrap;overflow-wrap:anywhere", text: `Purpose: ${latest.session.purpose}\nWhere to continue: ${latest.session.current_task}\nOpen questions:\n${latest.session.open_questions.join("\n")}` }),
      button("Use latest context", async () => { baseline = briefFields(conflict.session); summary = conflict; setBrief(baseline); conflict = null; conflicts.hidden = true; saveDrafts(); status.textContent = "Latest context loaded."; }),
      button("Keep my draft after review", async () => { baseline = briefFields(conflict.session); summary = conflict; conflict = null; conflicts.hidden = true; saveDrafts(); status.textContent = "Your draft is kept. Choose Save context to replace the fields you reviewed."; }));
    status.textContent = "Context changed. Review the latest text; your draft has not been overwritten.";
  }
  async function loadSession() {
    const latest = await request("resume"), before = currentBrief(), dirty = baseline ? editedFields() : [];
    summary = latest;
    if (!baseline) { baseline = briefFields(latest.session); setBrief(baseline); }
    else {
      const next = briefFields(latest.session);
      for (const key of Object.keys(next) as (keyof BriefFields)[]) if (!dirty.includes(key)) { (before as any)[key] = next[key]; (baseline as any)[key] = next[key]; }
      setBrief(before);
      const changed = dirty.filter(key => !equal(next[key], baseline![key]) && !equal(next[key], before[key]));
      if (changed.length) showConflict(latest, changed);
      else { conflict = null; conflicts.hidden = true; for (const key of dirty) if (equal(next[key], before[key])) (baseline as any)[key] = next[key]; }
    }
    sessionLoaded = true;
    resumeState.textContent = `${latest.pending_inputs.count} inputs after the saved checkpoint. ${latest.staged_remix ? "A prepared copy is waiting to be published." : ""}${latest.pending_inputs.history_gap ? " Some older event history has expired." : ""}`;
    if (latest.staged_remix && !result.contains(publish)) showPrepared("A prepared copy is ready. Connect an agent, then publish it here, or discard it to start again.");
    if (!latest.staged_remix && result.contains(publish)) clear(result);
    saveDrafts();
  }
  const briefSubmit = h("button", { type: "submit", class: "btn" }, "Save context"); actionButtons.add(briefSubmit);
  const briefForm = h("form", { class: "experience-form" }, field("What this page is for", purpose), field("Where to continue", task), field("Open questions", questions), briefSubmit);
  briefForm.onsubmit = e => { e.preventDefault(); void run(async () => {
    if (!sessionLoaded || !baseline) throw new Error("Wait for the saved context to load. Your draft stays here.");
    const values = currentBrief(), base = structuredClone(baseline), latest = await request("resume");
    const plan = planContextSave(base, values, latest.session);
    if (plan.conflicts.length) { showConflict(latest, plan.conflicts); return; }
    const saved = await request("resume", "PUT", { ...plan.next, expected_revision: latest.revision });
    summary = { ...latest, session: saved.session, revision: saved.revision };
    core.bus.emit("session_saved", {});
    const duringSave = currentBrief(); baseline = briefFields(saved.session);
    for (const key of Object.keys(baseline) as (keyof BriefFields)[]) if (equal(duringSave[key], values[key])) (duringSave as any)[key] = baseline[key];
    setBrief(duringSave); conflict = null; conflicts.hidden = true; saveDrafts();
    status.textContent = editedFields().length ? "Context saved. Your newer edits are kept and ready to save." : "Context saved for the next agent.";
  }); };
  const resumePrompt = button("Copy context prompt", async () => {
    const prompt = `Continue my Tendriller page. Read https://tendriller.dev/agent.md and the page's GET A/session.\nPurpose: ${purpose.value}\nCurrent task: ${task.value}\nOpen questions:\n${questions.value}\nUse Connect an agent on the page if you need a new private handle. Read queued inputs, preserve drafts, and acknowledge only work you handle.`;
    await navigator.clipboard.writeText(prompt); status.textContent = "Context prompt copied. Use Connect an agent to transfer access if needed.";
  });
  sections.append(h("details", { "data-experience": "context" }, h("summary", null, "Resume this work"), resumeState, briefForm, conflicts,
    button("Refresh saved context", async () => { await loadSession(); if (!conflict) status.textContent = "Saved context refreshed. Your edits are kept."; }), resumePrompt));

  const includeData = h("input", { type: "checkbox", checked: draft.includeData === true }); includeData.style.width = "auto";
  const copyName = h("input", { "data-copy-name": "", type: "text", maxlength: 100, placeholder: "Name for the copy", value: draft.copyName || "" });
  const result = h("div"), copyResult = h("div");
  const publish = button("Publish prepared copy", async () => {
    const current = await request("resume");
    if (!summary || current.version !== summary.version) throw new Error("The page changed. Refresh saved context to review its current version before publishing. Your draft stays here.");
    await request("bundle/publish", "POST", { expected_version: summary.version });
    core.bus.emit("session_saved", {});
    clear(result); status.textContent = pendingApply ? "Prepared copy published. Apply the page update when your drafts are ready." : "Prepared copy published.";
  }, "btn primary");
  publish.dataset.reviewCopy = "";
  const discard = button("Discard prepared copy", async () => { await request("bundle", "DELETE"); clear(result); if (summary) summary.staged_remix = false; status.textContent = "Prepared copy discarded."; });
  const showPrepared = (text: string, details?: HTMLElement) => clear(result, h("p", { text }), details, publish, discard);
  const imported = h("input", { type: "file", accept: ".json,application/json" });
  imported.onchange = () => { const file = imported.files?.[0]; if (!file) return; imported.value = ""; void run(async () => {
    if (file.size > 36 * 1024 * 1024) throw new Error("This bundle is too large (36 MB maximum).");
    const bundle = JSON.parse(await file.text()), data = await request("bundle", "PUT", bundle);
    summary = { ...summary, version: data.expected_version, staged_remix: true };
    const inspection = h("details", null, h("summary", null, "Prepared contents"), h("p", { text: `Name: ${bundle.name}. ${bundle.state ? "Includes shared data." : "Page template without shared data."}` }),
      h("ul", null, ...(bundle.files || []).slice(0, 100).map((item: any) => h("li", { text: String(item.path) }))));
    showPrepared(`${data.files} files and ${data.media} media prepared. Publishing replaces the current page and included state; earlier page versions remain available.`, inspection);
    await loadSession();
    status.textContent = "Review the prepared contents before publishing. Your context draft is kept.";
  }); };
  sections.append(h("details", { "data-experience": "remix" }, h("summary", null, "Save and remix"), h("p", { class: "muted", text: "A template contains page files and its purpose. Include data to copy shared state, notes, and media. Credentials, participant answers, approvals, and running timers never transfer." }),
    field("Include current data and media", includeData), button("Download bundle", async () => { download(await request(`bundle?include_data=${includeData.checked}`), "tendriller-bundle.json"); status.textContent = "Bundle downloaded."; }),
    field("Restore a bundle", imported), result, field("Copy name", copyName), button("Create independent copy", async () => {
      const data = await request("remix", "POST", { ...(copyName.value.trim() ? { name: copyName.value.trim() } : {}), include_data: includeData.checked });
      clear(copyResult, h("p", { text: data.next_step }), h("a", { class: "btn", href: data.page_url, target: "_blank", rel: "noopener" }, "Open your copy")); status.textContent = "Copy created. Connect its agent to publish it.";
    }), copyResult));

  function draftSnapshot() { return { brief: { baseline, values: currentBrief(), rawQuestions: questions.value }, timer: timerSnapshot(), copyName: copyName.value, includeData: includeData.checked }; }
  function saveDrafts() {
    try { sessionStorage.setItem(key, JSON.stringify(draftSnapshot())); return true; }
    catch { status.textContent = "This browser could not save your settings draft. Keep the page open or download the draft before applying an update."; return false; }
  }
  sections.addEventListener("input", saveDrafts); sections.addEventListener("change", saveDrafts);
  const apply = button("Apply page update", async () => { saveDrafts(); pendingApply?.(); });
  const backup = button("Download these drafts", async () => { download(draftSnapshot(), "tendriller-settings-draft.json"); status.textContent = "Settings drafts downloaded."; });
  window.addEventListener("tendril:before-reload", event => {
    if (!host.isConnected || !(busy || editedFields().length || title.value.trim() || copyName.value.trim())) return;
    const next = (event as CustomEvent).detail?.apply; if (typeof next !== "function") return;
    const stored = saveDrafts(); event.preventDefault(); pendingApply = next; update.hidden = false;
    clear(update, h("p", { text: stored ? "A page update is ready. Your settings drafts are saved in this tab. Apply it when you are ready." : "A page update is ready. Draft storage is unavailable; download these drafts before applying or they may be lost." }), backup, apply);
  });
  void run(async () => {
    const loaded = await Promise.allSettled([loadTimers(), loadSession()]);
    const failed = loaded.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failed.length) throw new Error(failed.map(item => item.reason?.message || "Could not load saved work.").join(" "));
    if (!conflict) status.textContent = "";
  });
}
