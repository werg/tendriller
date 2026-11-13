// Local phrase matcher for the fast voice layer (PROTOCOL section 9).
// Patterns like "tick *" or "next step": case-insensitive, punctuation at word edges
// ignored, `*` captures one or more words (the first capture is `args.text`).

export interface PhraseEntry<T = unknown> { key: T; phrases: string[] }
export interface PhraseMatch<T = unknown> { key: T; phrase: string; args: Record<string, any> }

/** Split into words, dropping punctuation at the edges of each word ("Milk," -> "Milk", "don't" kept). */
export function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}*]+|[^\p{L}\p{N}*]+$/gu, ""))
    .filter(Boolean);
}

export function normalize(text: string): string {
  return words(text).join(" ").toLowerCase();
}

// Politeness words stripped from either end of an utterance before matching.
const LEADING = ["please", "can you", "could you", "would you", "ok", "okay", "hey", "now"];
const TRAILING = ["please", "thanks", "thank you", "now"];

function stripPoliteness(ws: string[]): string[] {
  let out = ws.slice();
  let changed = true;
  while (changed && out.length) {
    changed = false;
    for (const p of LEADING) {
      const pw = p.split(" ");
      if (out.length > pw.length && pw.every((w, i) => out[i].toLowerCase() === w)) { out = out.slice(pw.length); changed = true; }
    }
    for (const p of TRAILING) {
      const pw = p.split(" ");
      const off = out.length - pw.length;
      if (off > 0 && pw.every((w, i) => out[off + i].toLowerCase() === w)) { out = out.slice(0, off); changed = true; }
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Compiled { re: RegExp; literal: number; wild: number }
const cache = new Map<string, Compiled>();

function compile(pattern: string): Compiled {
  let c = cache.get(pattern);
  if (c) return c;
  const ws = words(pattern).map((w) => w.toLowerCase());
  const parts = ws.map((w) => (w === "*" ? "(.+?)" : w.split("*").map(esc).join("(.+?)")));
  const wild = (pattern.match(/\*/g) || []).length;
  c = { re: new RegExp("^" + parts.join(" ") + "$", "iu"), literal: ws.join("").replace(/\*/g, "").length, wild };
  cache.set(pattern, c);
  return c;
}

function tryMatch(ws: string[], pattern: string): Record<string, any> | null {
  const c = compile(pattern);
  const m = c.re.exec(ws.join(" "));
  if (!m) return null;
  const caps = m.slice(1).map((s) => s.trim());
  const args: Record<string, any> = {};
  if (caps.length) args.text = caps[0];
  if (caps.length > 1) args.captures = caps;
  return args;
}

/**
 * Returns the best match: exact (wildcard-free) patterns beat wildcard ones, then more
 * literal characters win, then registration order. The raw utterance is tried first,
 * then with politeness words stripped.
 */
export function matchPhrase<T>(text: string, entries: Iterable<PhraseEntry<T>>): PhraseMatch<T> | null {
  const raw = words(text);
  if (!raw.length) return null;
  // Stripped first, so "tick milk please" captures "milk"; raw second, so a pattern
  // that itself contains "please" still matches.
  const stripped = stripPoliteness(raw);
  const variants = stripped.length !== raw.length ? [stripped, raw] : [raw];
  let best: (PhraseMatch<T> & { score: number }) | null = null;
  let order = 0;
  for (const e of entries) {
    for (const phrase of e.phrases) {
      order++;
      for (const ws of variants) {
        const args = tryMatch(ws, phrase);
        if (!args) continue;
        const c = compile(phrase);
        // Higher is better: exact over wildcard, then more literal text, then earlier registration.
        const score = (c.wild === 0 ? 1e6 : 0) + c.literal * 100 - order / 1e4;
        if (!best || score > best.score) best = { key: e.key, phrase, args, score };
        break;
      }
    }
  }
  if (!best) return null;
  return { key: best.key, phrase: best.phrase, args: best.args };
}
