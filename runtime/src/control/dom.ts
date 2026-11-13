// Tiny DOM helpers. Text is always set through textContent, never parsed as HTML.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k === "text") el.textContent = String(v);
      else if (k === "value") (el as any).value = v;
      else if (k === "checked") (el as any).checked = !!v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: (Child | Child[])[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element, ...children: (Child | Child[])[]): void {
  el.replaceChildren();
  append(el, children);
}

// Icons: 24×24, stroke-based, currentColor. Static strings only.
const P: Record<string, string> = {
  listening: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/><path d="M7.2 7.2a6.8 6.8 0 0 0 0 9.6M16.8 7.2a6.8 6.8 0 0 1 0 9.6"/>',
  working: '<path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5" class="spin"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  scheduled: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  not_responding: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r=".9" fill="currentColor" stroke="none"/>',
  away: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  no_agent: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3.2"/>',
  offline: '<path d="M2.5 9a14 14 0 0 1 19 0M6 12.5a9 9 0 0 1 12 0M9.5 16a4 4 0 0 1 5 0"/><path d="M3 3l18 18"/>',
  connecting: '<circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/>',
  pending: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.3"/>',
  microphone: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  screen: '<rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M8.5 20h7M12 16.5V20"/>',
  location: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  motion: '<rect x="7.5" y="3" width="9" height="18" rx="2"/><path d="M3.5 8.5c-1 2-1 5 0 7M20.5 8.5c1 2 1 5 0 7"/>',
  undo: '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9.5a5 5 0 0 1 0 10H11"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  text: '<path d="M4 18L8.5 6 13 18M5.6 14h5.8"/><path d="M15 11.5a2.8 2.8 0 0 1 5 1.7V18M20 15.5c-1.5-.6-5-.6-5 1.2 0 1.8 3.6 1.8 5-.3"/>',
  device: '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M11 18.5h2"/>',
};

export function icon(name: string, cls = "icon"): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? ""}</svg>`;
  return s;
}

export function relTime(ts: number | null | undefined, lang: string): string {
  if (!ts) return "";
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  let rtf: Intl.RelativeTimeFormat;
  try { rtf = new Intl.RelativeTimeFormat(lang || undefined, { numeric: "auto" }); } catch { rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" }); }
  if (abs < 45) return rtf.format(0, "second") === "now" ? "just now" : rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return rtf.format(Math.round(diff / (86400 * 30)), "month");
}
