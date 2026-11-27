import siteCopy from "./site-copy.json";

export type SiteCopy = typeof siteCopy;
export const SITE_COPY: SiteCopy = siteCopy;

export type CopyVars = Record<string, string | undefined>;

export function escapeCopyHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function substituteVars(template: string, vars: CopyVars = {}): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

/**
 * Renders lightweight inline copy formatting (**bold**, `code`) and template
 * placeholders ({host}, {base}, {name}, etc.) into safe escaped HTML.
 */
export function renderCopyText(template: string, vars: CopyVars = {}): string {
  return escapeCopyHtml(substituteVars(template, vars))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Plain-text substitution for attributes, prompts, and Markdown output. */
export function renderCopyPlain(template: string, vars: CopyVars = {}): string {
  return substituteVars(template, vars);
}

/**
 * Emits `data-copy` hooks only when rendering inside the local copy-editor tool;
 * production HTML stays completely clean with zero extra bytes.
 */
export function copyAttrs(key: string, template: string, editable?: boolean): string {
  if (!editable) return "";
  return ` data-copy="${escapeCopyHtml(key)}" data-copy-raw="${escapeCopyHtml(template)}"`;
}
