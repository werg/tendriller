import siteCopy from "./site-copy.json";

export type SiteCopy = typeof siteCopy;
export const SITE_COPY: SiteCopy = siteCopy;

export function escapeCopyHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Renders lightweight inline copy formatting (**bold**, `code`) and origin
 * placeholders ({host}, {base}) into safe escaped HTML.
 */
export function renderCopyText(template: string, vars: { host?: string; base?: string } = {}): string {
  const substituted = template
    .replaceAll("{host}", vars.host ?? "")
    .replaceAll("{base}", vars.base ?? "");
  return escapeCopyHtml(substituted)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Plain-text substitution for attributes, prompts, and Markdown output. */
export function renderCopyPlain(template: string, vars: { host?: string; base?: string } = {}): string {
  return template
    .replaceAll("{host}", vars.host ?? "")
    .replaceAll("{base}", vars.base ?? "");
}

/**
 * Emits `data-copy` hooks only when rendering inside the local copy-editor tool;
 * production HTML stays completely clean with zero extra bytes.
 */
export function copyAttrs(key: string, template: string, editable?: boolean): string {
  if (!editable) return "";
  return ` data-copy="${escapeCopyHtml(key)}" data-copy-raw="${escapeCopyHtml(template)}"`;
}
