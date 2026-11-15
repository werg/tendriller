import type { Core } from "../types";
import { clear, h } from "./dom";

export type ReturnAction = "continue" | "context" | "review" | "remix";

/** Read-only summary on the first control panel. Private owner context never mounts for guests. */
export function mountReturnToWork(host: HTMLElement, core: Core, open: (action: ReturnAction) => void) {
  let generation = 0, loading = false;
  const owner = () => core.device.role === "owner" && !core.device.pending;
  async function refresh() {
    if (!owner()) { generation++; loading = false; host.hidden = true; clear(host); return; }
    if (!core.connected || loading) return;
    const request = ++generation; loading = true;
    try {
      const response = await fetch(core.config.base + "_tendril/session", { credentials: "same-origin", cache: "no-store", headers: core.deviceHeaders?.() || {} });
      if (!response.ok) return;
      const data = await response.json();
      if (request !== generation || !owner()) return;
      const task = data.session?.current_task || data.session?.purpose || "";
      const pending = Number(data.pending_inputs?.count) || 0;
      if (!task && !pending && !data.staged_remix) { host.hidden = true; clear(host); return; }
      const actions = h("div", { class: "actions" },
        h("button", { type: "button", class: "btn primary", onclick: () => open("continue") }, "Continue with a new agent"),
        h("button", { type: "button", class: "btn", onclick: () => open("context") }, "Review saved context"),
        h("button", { type: "button", class: "btn", onclick: () => open("remix") }, "Make a copy"));
      if (data.staged_remix) actions.prepend(h("button", { type: "button", class: "btn primary", onclick: () => open("review") }, "Review prepared copy"));
      clear(host, h("h3", null, data.staged_remix ? "A prepared copy is waiting" : "Pick up where you left off"),
        task ? h("p", { class: "return-task", text: task }) : h("p", { text: "Your page keeps its work across agent sessions." }),
        h("p", { class: "muted", text: `${pending} input${pending === 1 ? "" : "s"} since the saved checkpoint.${data.pending_inputs?.history_gap ? " Some older input history has expired." : ""}` }), actions);
      host.hidden = false;
    } catch { /* A summary cannot block the working conversation or expose a partial response. */ }
    finally { if (request === generation) loading = false; }
  }
  core.bus.on("role", () => { if (!owner()) { generation++; loading = false; host.hidden = true; clear(host); } });
  core.bus.on("session_saved", () => void refresh());
  core.bus.on("connect", () => void refresh());
  return { refresh };
}
