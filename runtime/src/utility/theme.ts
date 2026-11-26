/**
 * Adaptive page-theme sampler for the Tendriller floating utility dock & modals.
 * Reads the host page's natural background, polarity, ink, and accent colors
 * without network requests, storage writes, or layout reflows.
 */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const DEFAULT_LINK_COLORS = new Set([
  "0,0,238",     // #0000ee browser default unvisited link
  "85,26,139",   // #551a8b browser default visited link
  "238,0,0",     // #ee0000 active link
]);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function parseCssColor(raw: string | null | undefined): Rgba | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === "transparent" || s === "none" || s === "auto" || s === "inherit" || s === "initial") return null;

  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      const a = hex.length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
      if ([r, g, b, a].some(Number.isNaN)) return null;
      return a < 0.08 ? null : { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b, a].some(Number.isNaN)) return null;
      return a < 0.08 ? null : { r, g, b, a };
    }
    return null;
  }

  const rgbMatch = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (rgbMatch) {
    const ch = (token: string) => token.endsWith("%") ? Math.round((parseFloat(token) / 100) * 255) : Math.round(parseFloat(token));
    const r = clamp(ch(rgbMatch[1]!), 0, 255);
    const g = clamp(ch(rgbMatch[2]!), 0, 255);
    const b = clamp(ch(rgbMatch[3]!), 0, 255);
    const aRaw = rgbMatch[4];
    const a = aRaw === undefined ? 1 : (aRaw.endsWith("%") ? parseFloat(aRaw) / 100 : parseFloat(aRaw));
    if ([r, g, b, a].some(Number.isNaN) || a < 0.08) return null;
    return { r, g, b, a: clamp(a, 0, 1) };
  }

  const srgbMatch = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (srgbMatch) {
    const r = clamp(Math.round(parseFloat(srgbMatch[1]!) * 255), 0, 255);
    const g = clamp(Math.round(parseFloat(srgbMatch[2]!) * 255), 0, 255);
    const b = clamp(Math.round(parseFloat(srgbMatch[3]!) * 255), 0, 255);
    const aRaw = srgbMatch[4];
    const a = aRaw === undefined ? 1 : (aRaw.endsWith("%") ? parseFloat(aRaw) / 100 : parseFloat(aRaw));
    if ([r, g, b, a].some(Number.isNaN) || a < 0.08) return null;
    return { r, g, b, a: clamp(a, 0, 1) };
  }

  return null;
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(c: Rgba): number {
  return 0.2126 * linearize(c.r) + 0.7152 * linearize(c.g) + 0.0722 * linearize(c.b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function mix(a: Rgba, b: Rgba, weightA: number): Rgba {
  const w = clamp(weightA, 0, 1);
  return {
    r: Math.round(a.r * w + b.r * (1 - w)),
    g: Math.round(a.g * w + b.g * (1 - w)),
    b: Math.round(a.b * w + b.b * (1 - w)),
    a: 1,
  };
}

function rgbToHsl(c: Rgba): { h: number; s: number; l: number } {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): Rgba {
  if (s === 0) {
    const v = Math.round(clamp(l, 0, 1) * 255);
    return { r: v, g: v, b: v, a: 1 };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(clamp(hue(h + 1 / 3), 0, 1) * 255),
    g: Math.round(clamp(hue(h), 0, 1) * 255),
    b: Math.round(clamp(hue(h - 1 / 3), 0, 1) * 255),
    a: 1,
  };
}

const hex = (c: Rgba) => `#${[c.r, c.g, c.b].map(v => clamp(v, 0, 255).toString(16).padStart(2, "0")).join("")}`;
const rgbaStr = (c: Rgba, alpha: number) => `rgba(${c.r},${c.g},${c.b},${alpha.toFixed(2)})`;

function normalizeAccent(raw: Rgba, bg: Rgba, isDark: boolean): Rgba {
  const hsl = rgbToHsl(raw);
  let candidate = { ...raw, a: 1 };
  // Ensure the accent stands out cleanly from the dock surface (>= 3.2:1)
  if (contrastRatio(candidate, bg) < 3.2) {
    let l = hsl.l;
    for (let i = 0; i < 14; i++) {
      l = isDark ? Math.min(0.78, l + 0.05) : Math.max(0.22, l - 0.05);
      candidate = hslToRgb(hsl.h, Math.min(0.85, hsl.s), l);
      if (contrastRatio(candidate, bg) >= 3.2) break;
    }
  }
  // Keep vivid colors tasteful (avoid neon-blinding extremes) while preserving brand character
  const adjusted = rgbToHsl(candidate);
  if (adjusted.s > 0.88) {
    candidate = hslToRgb(adjusted.h, 0.82, adjusted.l);
  }
  return candidate;
}

function pickAccentInk(accent: Rgba): Rgba {
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  const dark: Rgba = { r: 12, g: 16, b: 14, a: 1 };
  return contrastRatio(white, accent) >= contrastRatio(dark, accent) ? white : dark;
}

function sameColor(a: Rgba, b: Rgba): boolean {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 28;
}

function isChromatic(c: Rgba): boolean {
  const { s, l } = rgbToHsl(c);
  return s >= 0.16 && l > 0.08 && l < 0.92;
}

function detectPageBackground(host: HTMLElement): Rgba | null {
  const candidates: Array<Element | null> = [
    document.body,
    document.documentElement,
    document.querySelector?.("main"),
    document.querySelector?.("[data-app], #app, #root"),
  ];
  for (const node of candidates) {
    if (!node || node === host || host.contains?.(node)) continue;
    try {
      const bg = parseCssColor(window.getComputedStyle(node).backgroundColor);
      if (bg && bg.a >= 0.5) return bg.a >= 0.98 ? { ...bg, a: 1 } : composite(bg, { r: 255, g: 255, b: 255, a: 1 });
    } catch { /* ignore */ }
  }
  return null;
}

function detectPageAccent(host: HTMLElement, pageBg: Rgba, pageInk: Rgba): { color: Rgba; explicit: boolean } | null {
  // 1) Explicit CSS variable override from the app author
  try {
    for (const target of [document.body, document.documentElement]) {
      if (!target) continue;
      const custom = window.getComputedStyle(target).getPropertyValue("--tendril-accent").trim();
      const parsed = parseCssColor(custom);
      if (parsed) return { color: parsed, explicit: true };
    }
  } catch { /* ignore */ }

  // 2) <meta name="theme-color">
  try {
    const meta = document.querySelector?.('meta[name="theme-color"]') as HTMLMetaElement | null;
    const parsed = parseCssColor(meta?.content);
    if (parsed && isChromatic(parsed) && !sameColor(parsed, pageBg)) {
      return { color: parsed, explicit: false };
    }
  } catch { /* ignore */ }

  // 3) CSS accent-color on :root or body
  try {
    for (const target of [document.body, document.documentElement]) {
      if (!target) continue;
      const parsed = parseCssColor(window.getComputedStyle(target).accentColor);
      if (parsed && isChromatic(parsed)) return { color: parsed, explicit: false };
    }
  } catch { /* ignore */ }

  // 4) Bounded sample of the page's natural interactive elements (buttons, links, active tabs)
  const buckets = new Map<string, { color: Rgba; score: number }>();
  let monochromeButton: Rgba | null = null;
  const record = (raw: Rgba | null, weight: number, allowNeutral = false) => {
    if (!raw || raw.a < 0.65) return;
    const solid = raw.a >= 0.98 ? { ...raw, a: 1 } : composite(raw, pageBg);
    const exactKey = `${solid.r},${solid.g},${solid.b}`;
    if (DEFAULT_LINK_COLORS.has(exactKey)) return;
    if (sameColor(solid, pageBg)) return;
    if (!isChromatic(solid)) {
      if (allowNeutral && contrastRatio(solid, pageBg) >= 4.5 && !monochromeButton) {
        monochromeButton = solid;
      }
      return;
    }
    const { s, l } = rgbToHsl(solid);
    // Bucket nearby shades together so a page's primary brand color wins cleanly.
    // Very dark or very pale shades (e.g. dark nav link text) score much lower than vivid accents.
    const key = `${Math.round(solid.r / 20)},${Math.round(solid.g / 20)},${Math.round(solid.b / 20)}`;
    const prev = buckets.get(key);
    const vibrancy = (l < 0.22 || l > 0.84) ? 0.35 : (0.75 + s * 0.9);
    const boost = weight * vibrancy;
    if (prev) prev.score += boost;
    else buckets.set(key, { color: solid, score: boost });
  };

  try {
    const selectors = 'button, [role="button"], input[type="submit"], a[href], [aria-current], [aria-selected="true"]';
    const nodes = document.querySelectorAll?.(selectors);
    if (nodes) {
      const limit = Math.min(nodes.length, 32);
      for (let i = 0; i < limit; i++) {
        const node = nodes[i]!;
        if (node === host || host.contains?.(node)) continue;
        const cs = window.getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const tag = node.tagName.toLowerCase();
        const isButton = tag === "button" || tag === "input" || node.getAttribute("role") === "button";
        const bg = parseCssColor(cs.backgroundColor);
        const fg = parseCssColor(cs.color);
        if (isButton) {
          record(bg, 4.5, true);
          record(fg, 0.9, false);
        } else {
          record(bg, 2.5, false);
          if (fg && !sameColor(fg, pageInk)) record(fg, 1.1, false);
        }
      }
    }
  } catch { /* ignore */ }

  let best: { color: Rgba; score: number } | null = null;
  for (const entry of buckets.values()) {
    if (!best || entry.score > best.score) best = entry;
  }
  if (best) return { color: best.color, explicit: false };
  if (monochromeButton) return { color: monochromeButton, explicit: false };
  return null;
}

/**
 * Computes a `:host { ... }` CSS override block adapting the utility dock & modals
 * to the host page's background, polarity, ink, and accent palette.
 * Returns "" on completely unstyled pages so default light/dark tokens apply.
 */
export function buildAdaptiveThemeCss(host: HTMLElement): string {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function" || !document.body) {
    return "";
  }

  const pageBg = detectPageBackground(host);
  let explicitBg: Rgba | null = null;
  let explicitInk: Rgba | null = null;
  try {
    const rootStyle = window.getComputedStyle(document.documentElement);
    const bodyStyle = window.getComputedStyle(document.body);
    explicitBg = parseCssColor(bodyStyle.getPropertyValue("--tendril-bg") || rootStyle.getPropertyValue("--tendril-bg"));
    explicitInk = parseCssColor(bodyStyle.getPropertyValue("--tendril-ink") || rootStyle.getPropertyValue("--tendril-ink"));
  } catch { /* ignore */ }

  const osDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const fallbackBg: Rgba = osDark ? { r: 20, g: 27, b: 24, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  const effectivePageBg = explicitBg ?? pageBg ?? fallbackBg;
  const isDark = luminance(effectivePageBg) < 0.38;

  let bodyInk: Rgba | null = null;
  try { bodyInk = parseCssColor(window.getComputedStyle(document.body).color); } catch { /* ignore */ }
  const defaultInk: Rgba = isDark ? { r: 237, g: 244, b: 240, a: 1 } : { r: 20, g: 36, b: 28, a: 1 };
  const effectiveInk = explicitInk
    ?? (bodyInk && contrastRatio(bodyInk, effectivePageBg) >= 4.5 ? { ...bodyInk, a: 1 } : defaultInk);

  const detectedAccent = detectPageAccent(host, effectivePageBg, effectiveInk);

  // Leave bare / unstyled pages on Tendriller's default theme tokens
  if (!pageBg && !explicitBg && !explicitInk && !detectedAccent) return "";

  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };

  // Harmonized panel & surface steps derived from the page's real background tint
  const bg = explicitBg
    ? explicitBg
    : pageBg
      ? (isDark ? mix(effectivePageBg, white, 0.94) : mix(effectivePageBg, white, 0.72))
      : fallbackBg;
  const surface = isDark ? mix(bg, white, 0.93) : mix(bg, effectiveInk, 0.96);
  const surface2 = isDark ? mix(bg, white, 0.87) : mix(bg, effectiveInk, 0.91);
  const ink = contrastRatio(effectiveInk, bg) >= 4.5 ? effectiveInk : (isDark ? { r: 241, g: 245, b: 243, a: 1 } : { r: 18, g: 26, b: 22, a: 1 });
  const muted = mix(ink, bg, isDark ? 0.68 : 0.62);

  const vars: string[] = [
    `color-scheme:${isDark ? "dark" : "light"}`,
    `--t-bg:${hex(bg)}`,
    `--t-surface:${hex(surface)}`,
    `--t-surface-2:${hex(surface2)}`,
    `--t-border:${rgbaStr(ink, isDark ? 0.14 : 0.13)}`,
    `--t-border-strong:${rgbaStr(ink, isDark ? 0.25 : 0.22)}`,
    `--t-ink:${hex(ink)}`,
    `--t-muted:${hex(muted)}`,
    `color:${hex(ink)}`,
  ];

  if (isDark) {
    vars.push(
      `--t-danger:#f87171`,
      `--t-danger-soft:rgba(248,113,113,.22)`,
      `--t-warn:#fbbf24`,
      `--t-warn-soft:rgba(251,191,36,.16)`,
      `--t-ok:#4ade80`,
      `--t-ok-soft:rgba(74,222,128,.16)`,
      `--t-shadow:0 10px 32px rgba(0,0,0,.45),0 2px 10px rgba(0,0,0,.3)`,
      `--t-shadow-lg:0 24px 64px rgba(0,0,0,.65),0 4px 20px rgba(0,0,0,.4)`,
    );
  } else {
    vars.push(
      `--t-danger:#b91c1c`,
      `--t-danger-soft:rgba(185,28,28,.12)`,
      `--t-warn:#b45309`,
      `--t-warn-soft:rgba(217,119,6,.13)`,
      `--t-ok:#15803d`,
      `--t-ok-soft:rgba(21,128,61,.13)`,
      `--t-shadow:0 8px 30px rgba(10,20,16,.14),0 2px 8px rgba(10,20,16,.08)`,
      `--t-shadow-lg:0 20px 60px rgba(8,18,14,.28),0 4px 16px rgba(8,18,14,.14)`,
    );
  }

  if (detectedAccent) {
    const accent = detectedAccent.explicit
      ? detectedAccent.color
      : normalizeAccent(detectedAccent.color, bg, isDark);
    const accentInk = pickAccentInk(accent);
    const accentHover = isDark ? mix(accent, white, 0.88) : mix(accent, black, 0.86);
    vars.push(
      `--t-accent:${hex(accent)}`,
      `--t-accent-hover:${hex(accentHover)}`,
      `--t-accent-soft:${rgbaStr(accent, isDark ? 0.2 : 0.13)}`,
      `--t-accent-ink:${hex(accentInk)}`,
      `--t-glow:${rgbaStr(accent, 0.55)}`,
    );
  } else if (pageBg || explicitBg) {
    // Page has a custom background tint with no strong brand accent: adapt accent subtly
    // using either a soft contrast-matched ink tone (if neutral page) or default polarity accent.
    const bgHsl = rgbToHsl(effectivePageBg);
    const accent = bgHsl.s >= 0.12
      ? normalizeAccent(hslToRgb(bgHsl.h, Math.min(0.45, Math.max(0.24, bgHsl.s * 1.4)), isDark ? 0.62 : 0.34), bg, isDark)
      : (isDark ? { r: 226, g: 234, b: 230, a: 1 } : { r: 28, g: 36, b: 32, a: 1 });
    const accentInk = pickAccentInk(accent);
    const accentHover = isDark ? mix(accent, white, 0.88) : mix(accent, black, 0.86);
    vars.push(
      `--t-accent:${hex(accent)}`,
      `--t-accent-hover:${hex(accentHover)}`,
      `--t-accent-soft:${rgbaStr(accent, isDark ? 0.18 : 0.11)}`,
      `--t-accent-ink:${hex(accentInk)}`,
      `--t-glow:${rgbaStr(accent, 0.45)}`,
    );
  }

  return `:host{${vars.join(";")}}`;
}

/** Observes host theme/style changes and keeps the shadow-root adaptive theme in sync. */
export function observePageTheme(host: HTMLElement, themeStyle: HTMLStyleElement): () => void {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return () => {};
  let disposed = false;
  let raf: number | null = null;
  let lastCss = "";

  const apply = () => {
    if (disposed) return;
    const next = buildAdaptiveThemeCss(host);
    if (next !== lastCss) {
      lastCss = next;
      themeStyle.textContent = next;
    }
  };

  const schedule = () => {
    if (disposed || raf !== null) return;
    const req = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16) as unknown as number;
    raf = req(() => {
      raf = null;
      apply();
    });
  };

  apply();
  // Sample again after initial styles / first frame paint
  schedule();
  const onLoad = () => schedule();
  window.addEventListener?.("load", onLoad, { once: true });

  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const onMedia = () => schedule();
  media?.addEventListener?.("change", onMedia);

  let attrObserver: MutationObserver | null = null;
  if (typeof MutationObserver === "function") {
    attrObserver = new MutationObserver(schedule);
    const opts: MutationObserverInit = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme"] };
    if (document.documentElement) attrObserver.observe(document.documentElement, opts);
    if (document.body) attrObserver.observe(document.body, opts);
  }

  return () => {
    disposed = true;
    if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    window.removeEventListener?.("load", onLoad);
    media?.removeEventListener?.("change", onMedia);
    attrObserver?.disconnect();
  };
}
