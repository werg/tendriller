import type { RuntimeApi } from "../../contract/index.mjs";

const labels: Record<string, string> = { camera: "Camera", microphone: "Microphone", screen: "Screen sharing", location: "Location", motion: "Motion" };

/** Operational access and active-use stop only. This is not an authority boundary. */
export function mountUtility(api: RuntimeApi): () => void {
  const host = document.createElement("tendril-utility");
  host.style.cssText = "position:fixed!important;inset:auto 12px 12px auto!important;z-index:2147483647!important;display:block!important;contain:layout style!important;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;color-scheme:light dark;font:13px/1.4 system-ui}nav{display:flex;align-items:center;gap:8px;padding:6px;border:1px solid #737373;border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 2px 12px #0002}a,button{font:inherit;color:inherit;padding:6px 9px;border:0;border-radius:7px;background:transparent;text-decoration:none;cursor:pointer}a:focus-visible,button:focus-visible{outline:2px solid Highlight;outline-offset:2px}button{background:#a32020;color:white}span{max-width:45vw}button[hidden],span[hidden]{display:none}`;
  const nav = document.createElement("nav"); nav.setAttribute("aria-label", "Page operations");
  const link = document.createElement("a"); link.href = api.identity.managementUrl; link.textContent = "Manage page";
  link.title = "Page recovery and device management"; link.target = "_blank"; link.rel = "noopener";
  const active = document.createElement("span"); active.setAttribute("role", "status");
  const stop = document.createElement("button"); stop.type = "button"; stop.textContent = "Stop sensors";
  stop.addEventListener("click", () => api.sensors.stopAll());
  nav.append(link, active, stop); root.append(style, nav);
  const render = () => {
    const sensors = api.sensors.active();
    active.hidden = stop.hidden = sensors.length === 0;
    active.textContent = sensors.map(sensor => labels[sensor]).join(", ") + " active";
    stop.setAttribute("aria-label", "Stop " + sensors.map(sensor => labels[sensor]).join(", "));
  };
  const attach = () => { if (!host.isConnected) (document.body || document.documentElement).append(host); };
  const observer = new MutationObserver(attach);
  const off = api.sensors.on(render);
  render(); attach(); observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => { observer.disconnect(); off(); host.remove(); };
}
