import { ICONS, type IconName } from "./icons";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined && text !== "") node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function btn(text?: string, className?: string): HTMLButtonElement {
  const node = el("button", text, className);
  node.type = "button";
  return node;
}

export function iconEl(name: IconName, className = "ico"): HTMLSpanElement {
  const span = el("span", undefined, className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = ICONS[name];
  return span;
}

export function clearChildren(node: Element): void {
  while (node.firstChild) node.firstChild.remove();
}

export function setData(node: Element, name: string, value: string): void {
  node.setAttribute(`data-${name}`, value);
}

const AGENT_COLORS = ["#166047", "#2563eb", "#7c3aed", "#c2410c", "#0f766e", "#be123c", "#4338ca", "#047857"];
const USER_COLORS = ["#0369a1", "#9333ea", "#b45309", "#0f766e", "#be185d", "#4f46e5"];

export function handleColor(handle?: string, isUser = false): string {
  const palette = isUser ? USER_COLORS : AGENT_COLORS;
  if (!handle) return palette[0]!;
  let hash = 0;
  for (let i = 0; i < handle.length; i++) hash = ((hash << 5) - hash + handle.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}

/** Render text safely with highlighted @mention spans (zero innerHTML). */
export function renderMentionText(container: HTMLElement, text: string): void {
  clearChildren(container);
  const re = /(^|[\s([{"'])(@[a-z][a-z0-9_-]{1,31}|@all)\b/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const lead = match[1] ?? "";
    const mention = match[2] ?? "";
    const start = match.index + lead.length;
    if (start > last) container.append(document.createTextNode(text.slice(last, start)));
    const chip = el("span", mention, "mention-pill");
    container.append(chip);
    last = start + mention.length;
  }
  if (last < text.length) container.append(document.createTextNode(text.slice(last)));
}

export function formatCountdown(expiresAtMs: number): string {
  const remaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
  if (remaining <= 0) return "Expired";
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function formatExpiry(expiresAtMs: number | null): string {
  if (expiresAtMs === null) return "Never expires";
  const diff = expiresAtMs - Date.now();
  if (diff <= 0) return "Expired";
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `Expires in ${Math.max(1, hours)}h`;
  const days = Math.round(diff / 86_400_000);
  return `Expires in ${days}d`;
}
